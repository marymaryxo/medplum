// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { Form, MedplumLink, ResourceAvatar, ResourceInput, useMedplum } from '@medplum/react';
import { useResource } from '@medplum/react-hooks';
import { createReference, formatHumanName, formatPeriod, getReferenceString } from '@medplum/core';
import type { Appointment, Encounter, Patient, Reference } from '@medplum/fhirtypes';
import type { JSX } from 'react';
import { useCallback, useState } from 'react';
import { IconTrash } from '@tabler/icons-react';
import { showErrorNotification } from '../../utils/notifications';
import { showNotification } from '@mantine/notifications';
import {
  cancelRecurrenceSeries,
  getRecurrenceSeriesId,
  updateEncounterStatus,
} from '../../utils/encounter';

type UpdateAppointmentFormProps = {
  appointment: Appointment;
  onUpdate: (appointment: Appointment) => void;
};

function UpdateAppointmentForm(props: UpdateAppointmentFormProps): JSX.Element {
  const medplum = useMedplum();
  const [patient, setPatient] = useState<Patient | undefined>(undefined);

  const { appointment, onUpdate } = props;
  const handleSubmit = useCallback(async () => {
    if (!patient) {
      return;
    }
    const updated = {
      ...appointment,
      participant: [
        ...appointment.participant,
        {
          actor: createReference(patient),
          status: 'tentative',
        },
      ],
    } satisfies Appointment;

    let result: Appointment;
    try {
      result = await medplum.updateResource(updated);
    } catch (error) {
      showErrorNotification(error);
      return;
    }
    onUpdate?.(result);
  }, [medplum, patient, appointment, onUpdate]);

  return (
    <Form onSubmit={handleSubmit}>
      <Stack gap="md">
        <ResourceInput
          label="Patient"
          resourceType="Patient"
          name="Patient-id"
          required={true}
          onChange={(value) => setPatient(value as Patient)}
        />

        <Button fullWidth size="md" type="submit">
          Update Appointment
        </Button>
      </Stack>
    </Form>
  );
}

export function AppointmentDetails(props: {
  appointment: Appointment;
  onUpdate: (appointment: Appointment) => void;
  onRefresh?: () => void;
}): JSX.Element {
  const { appointment, onUpdate, onRefresh } = props;
  const medplum = useMedplum();
  const [cancelling, setCancelling] = useState(false);
  const [confirmThisOpened, { open: openConfirmThis, close: closeConfirmThis }] = useDisclosure(false);
  const [confirmSeriesOpened, { open: openConfirmSeries, close: closeConfirmSeries }] = useDisclosure(false);
  const participantRef = appointment.participant.find((p) => p.actor?.reference?.startsWith('Patient/'));
  const patientParticipant = useResource(participantRef?.actor as Reference<Patient> | undefined);
  const recurrenceSeriesId = getRecurrenceSeriesId(appointment);
  const isCancelled = appointment.status === 'cancelled';

  const handleCancelThis = useCallback(async () => {
    closeConfirmThis();
    if (!appointment.id) return;
    setCancelling(true);
    try {
      const encounters = await medplum.searchResources('Encounter', {
        appointment: getReferenceString(appointment as Appointment & { id: string }),
      });
      const encounter = encounters[0] as (Encounter & { id: string }) | undefined;
      if (encounter) {
        await updateEncounterStatus(
          medplum,
          encounter,
          appointment as Appointment & { id: string },
          'cancelled'
        );
      } else {
        await medplum.updateResource({ ...appointment, status: 'cancelled' });
      }
      onUpdate({ ...appointment, status: 'cancelled' });
    } catch (err) {
      showErrorNotification(err);
    } finally {
      setCancelling(false);
    }
  }, [medplum, appointment, onUpdate, closeConfirmThis]);

  const handleCancelSeries = useCallback(async () => {
    closeConfirmSeries();
    if (!recurrenceSeriesId) return;
    setCancelling(true);
    try {
      const { cancelledCount } = await cancelRecurrenceSeries(medplum, recurrenceSeriesId);
      onUpdate({ ...appointment, status: 'cancelled' });
      onRefresh?.();
      showNotification({
        message: `Cancelled ${cancelledCount} appointment${cancelledCount === 1 ? '' : 's'} in the series.`,
      });
    } catch (err) {
      showErrorNotification(err);
    } finally {
      setCancelling(false);
    }
  }, [medplum, recurrenceSeriesId, appointment, onUpdate, onRefresh, closeConfirmSeries]);

  return (
    <Stack gap="md">
      <Text size="xl" fw={500}>{formatPeriod({ start: appointment.start, end: appointment.end })}</Text>

      {!participantRef && <UpdateAppointmentForm appointment={appointment} onUpdate={onUpdate} />}

      {!!patientParticipant && (
        <Group align="center" gap="sm">
          <MedplumLink to={patientParticipant}>
            <ResourceAvatar value={patientParticipant} size={48} radius={48} />
          </MedplumLink>
          <MedplumLink to={patientParticipant} fw={800} size="xl">
            {formatHumanName(patientParticipant.name?.[0])}
          </MedplumLink>
        </Group>
      )}

      {!isCancelled && appointment.id && (
        <Stack gap="sm">
          <Button
            variant="light"
            color="red"
            size="md"
            leftSection={<IconTrash size={18} />}
            onClick={openConfirmThis}
            loading={cancelling}
          >
            Cancel this appointment
          </Button>
          {recurrenceSeriesId && (
            <Button
              variant="subtle"
              color="red"
              size="md"
              leftSection={<IconTrash size={18} />}
              onClick={openConfirmSeries}
              loading={cancelling}
            >
              Cancel entire series
            </Button>
          )}
        </Stack>
      )}

      <Modal opened={confirmThisOpened} onClose={closeConfirmThis} title="Cancel appointment" centered>
        <Text size="md" c="dimmed" mb="md">
          Are you sure you want to cancel this appointment? This action cannot be undone.
        </Text>
        <Group justify="flex-end" gap="sm">
          <Button variant="subtle" onClick={closeConfirmThis}>
            Keep
          </Button>
          <Button color="red" leftSection={<IconTrash size={16} />} onClick={handleCancelThis}>
            Cancel appointment
          </Button>
        </Group>
      </Modal>

      <Modal opened={confirmSeriesOpened} onClose={closeConfirmSeries} title="Cancel entire series" centered>
        <Text size="md" c="dimmed" mb="md">
          This will cancel all appointments in this recurring series. This action cannot be undone.
        </Text>
        <Group justify="flex-end" gap="sm">
          <Button variant="subtle" onClick={closeConfirmSeries}>
            Keep appointments
          </Button>
          <Button color="red" leftSection={<IconTrash size={16} />} onClick={handleCancelSeries}>
            Cancel entire series
          </Button>
        </Group>
      </Modal>
    </Stack>
  );
}
