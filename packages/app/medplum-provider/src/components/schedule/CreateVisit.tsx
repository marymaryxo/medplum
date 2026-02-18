// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { CodingInput, DateTimeInput, Form, ResourceInput, useMedplum } from '@medplum/react';
import { useState, useMemo } from 'react';
import type { JSX } from 'react';
import { Button, Card, Flex, NumberInput, Select, Stack, Switch, Text, Title } from '@mantine/core';
import type { Appointment, Coding, Patient, PlanDefinition, PlanDefinitionAction, Slot } from '@medplum/fhirtypes';
import { IconAlertSquareRounded, IconCircleCheck, IconCirclePlus } from '@tabler/icons-react';
import classes from './CreateVisit.module.css';
import { createEncounter } from '../../utils/encounter';
import { showErrorNotification } from '../../utils/notifications';
import { useNavigate } from 'react-router';
import { showNotification } from '@mantine/notifications';
import { v4 as uuidv4 } from 'uuid';
import type { Range } from '../../types/scheduling';
import { rangesOverlap } from '../../utils/slots';

/** Generate (start, end) pairs for recurring appointments. */
function getRecurringSlots(
  firstStart: Date,
  firstEnd: Date,
  occurrences: number,
  intervalWeeks: number
): { start: Date; end: Date }[] {
  const durationMs = firstEnd.getTime() - firstStart.getTime();
  const slots: { start: Date; end: Date }[] = [];
  for (let i = 0; i < occurrences; i++) {
    const start = new Date(firstStart);
    start.setDate(start.getDate() + i * intervalWeeks * 7);
    const end = new Date(start.getTime() + durationMs);
    slots.push({ start, end });
  }
  return slots;
}

interface CreateVisitProps {
  appointmentSlot: Range | undefined;
  /** Blocked slots (busy-unavailable) to prevent scheduling over. */
  blockedSlots?: Slot[];
  /** Existing appointments to prevent overlapping. */
  existingAppointments?: Appointment[];
}

export function CreateVisit(props: CreateVisitProps): JSX.Element {
  const { appointmentSlot, blockedSlots = [], existingAppointments = [] } = props;
  const [patient, setPatient] = useState<Patient | undefined>();
  const [planDefinitionData, setPlanDefinitionData] = useState<PlanDefinition | undefined>();
  const [encounterClass, setEncounterClass] = useState<Coding | undefined>();
  const [start, setStart] = useState<Date | undefined>(appointmentSlot?.start);
  const [end, setEnd] = useState<Date | undefined>(appointmentSlot?.end);
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurrenceOccurrences, setRecurrenceOccurrences] = useState(4);
  const [recurrenceIntervalWeeks, setRecurrenceIntervalWeeks] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const medplum = useMedplum();
  const navigate = useNavigate();

  const [formattedDate, formattedSlotTime] = useMemo(() => {
    if (!appointmentSlot) {
      return ['', ''];
    }

    const startDate = new Date(appointmentSlot?.start);
    const endDate = new Date(appointmentSlot?.end);

    const options: Intl.DateTimeFormatOptions = {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    };
    const dateStr = startDate.toLocaleDateString('en-US', options);

    const timeOptions: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: 'numeric', hour12: true };
    const startTimeStr = startDate.toLocaleTimeString('en-US', timeOptions);
    const endTimeStr = endDate.toLocaleTimeString('en-US', timeOptions);

    const formattedTime = `${startTimeStr} – ${endTimeStr}`;
    return [dateStr, formattedTime];
  }, [appointmentSlot]);

  async function handleSubmit(): Promise<void> {
    if (!patient || !planDefinitionData || !encounterClass || !start || !end) {
      showNotification({
        color: 'yellow',
        icon: <IconAlertSquareRounded />,
        title: 'Error',
        message: 'Please fill out required fields.',
      });
      return;
    }

    // Prevent appointment over existing block (FHIR: busy-unavailable is not bookable)
    const overlappingBlock = blockedSlots.find((s) =>
      rangesOverlap(start, end, new Date(s.start), new Date(s.end))
    );
    if (overlappingBlock) {
      showNotification({
        color: 'red',
        message: 'This time is blocked. Choose another time or remove the block first.',
      });
      return;
    }

    // Prevent overlapping appointments
    const overlappingAppointment = existingAppointments.find(
      (apt) =>
        apt.start &&
        apt.end &&
        apt.status !== 'cancelled' &&
        rangesOverlap(start, end, new Date(apt.start), new Date(apt.end))
    );
    if (overlappingAppointment) {
      showNotification({
        color: 'red',
        message: 'This time overlaps with an existing appointment. Choose another time.',
      });
      return;
    }

    setIsLoading(true);
    try {
      const slots = isRecurring
        ? getRecurringSlots(start, end, recurrenceOccurrences, recurrenceIntervalWeeks)
        : [{ start, end }];

      const recurrenceSeriesId = isRecurring && slots.length > 1 ? uuidv4() : undefined;

      const encounters: Awaited<ReturnType<typeof createEncounter>>[] = [];
      for (const slot of slots) {
        const enc = await createEncounter(
          medplum,
          slot.start,
          slot.end,
          encounterClass,
          patient,
          planDefinitionData,
          recurrenceSeriesId ? { recurrenceSeriesId } : undefined
        );
        encounters.push(enc);
      }

      const count = encounters.length;
      showNotification({
        icon: <IconCircleCheck />,
        title: 'Success',
        message: count === 1 ? 'Visit created' : `${count} recurring visits created`,
      });
      navigate(`/Patient/${patient.id}/Encounter/${encounters[0].id}`)?.catch(console.error);
    } catch (err) {
      showErrorNotification(err);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <Flex direction="column" gap="md" h="100%" justify="space-between">
        <Stack gap="md" h="100%">
          <Stack gap={0}>
            <Title order={1} fw={600}>
              {formattedDate}
            </Title>
            <Text size="lg" mt={4}>{formattedSlotTime}</Text>
          </Stack>

          <ResourceInput
            label="Patient"
            resourceType="Patient"
            name="Patient-id"
            required={true}
            onChange={(value) => setPatient(value as Patient)}
          />

          <DateTimeInput
            name="start"
            label="Start Time"
            defaultValue={appointmentSlot?.start?.toISOString()}
            required={true}
            onChange={(value) => {
              setStart(new Date(value));
            }}
          />

          <DateTimeInput
            name="end"
            label="End Time"
            defaultValue={appointmentSlot?.end?.toISOString()}
            required={true}
            onChange={(value) => {
              setEnd(new Date(value));
            }}
          />

          <Switch
            label="Repeat weekly"
            checked={isRecurring}
            onChange={(e) => setIsRecurring(e.currentTarget.checked)}
          />
          {isRecurring && (
            <Stack gap="xs">
              <NumberInput
                label="Number of occurrences"
                min={2}
                max={52}
                value={recurrenceOccurrences}
                onChange={(v) => setRecurrenceOccurrences(typeof v === 'string' ? parseInt(v, 10) : v ?? 4)}
              />
              <Select
                label="Repeat every"
                data={[
                  { value: '1', label: 'Every week' },
                  { value: '2', label: 'Every 2 weeks' },
                  { value: '3', label: 'Every 3 weeks' },
                  { value: '4', label: 'Every 4 weeks' },
                ]}
                value={String(recurrenceIntervalWeeks)}
                onChange={(v) => setRecurrenceIntervalWeeks(parseInt(v ?? '1', 10))}
              />
            </Stack>
          )}

          <CodingInput
            name="class"
            label="Class"
            binding="http://terminology.hl7.org/ValueSet/v3-ActEncounterCode"
            required={true}
            onChange={setEncounterClass}
            path="Encounter.type"
          />

          <ResourceInput
            name="plandefinition"
            resourceType="PlanDefinition"
            label="Care template"
            onChange={(value) => {
              setPlanDefinitionData(value as PlanDefinition);
            }}
            required={true}
          />
        </Stack>

        {planDefinitionData?.action && planDefinitionData.action.length > 0 && (
          <Card className={classes.planDefinition} p="md">
            <Stack gap="xs">
              <Text fw={600} size="md">Included Tasks</Text>
              {planDefinitionData?.action?.map((action: PlanDefinitionAction) => (
                <Text key={action.id} size="md">• {action.title}</Text>
              ))}
            </Stack>
          </Card>
        )}

        <Button fullWidth mt="xl" size="md" type="submit" loading={isLoading} disabled={isLoading}>
          <IconCirclePlus />{' '}
          <Text ml="xs">
            {isRecurring && recurrenceOccurrences > 1
              ? `Create ${recurrenceOccurrences} Visits`
              : 'Create Visit'}
          </Text>
        </Button>
      </Flex>
    </Form>
  );
}
