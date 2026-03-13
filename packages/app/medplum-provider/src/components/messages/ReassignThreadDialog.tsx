// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Button, Modal, Stack, Text } from '@mantine/core';
import { createReference, getDisplayString } from '@medplum/core';
import type { Communication, Practitioner, Reference } from '@medplum/fhirtypes';
import { ResourceInput } from '@medplum/react';
import { useState } from 'react';
import type { JSX } from 'react';
import { showErrorNotification } from '../../utils/notifications';

interface ReassignThreadDialogProps {
  thread: Communication | undefined;
  opened: boolean;
  onClose: () => void;
  onReassign: (provider: Reference<Practitioner>, displayName: string) => Promise<void>;
}

export function ReassignThreadDialog(props: ReassignThreadDialogProps): JSX.Element {
  const { onClose, onReassign } = props;
  const [practitioner, setPractitioner] = useState<Practitioner | Reference<Practitioner> | undefined>();
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (): Promise<void> => {
    const practitionerRef = practitioner
      ? typeof practitioner === 'object' && 'reference' in practitioner
        ? practitioner
        : createReference(practitioner as Practitioner)
      : undefined;

    if (!practitionerRef) {
      return;
    }

    const displayName =
      practitioner && typeof practitioner === 'object' && 'reference' in practitioner
        ? (practitioner as Reference<Practitioner>).display ?? 'Unknown provider'
        : getDisplayString(practitioner as Practitioner);

    setSubmitting(true);
    try {
      await onReassign(practitionerRef, displayName);
      setPractitioner(undefined);
      onClose();
    } catch (error) {
      showErrorNotification(error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = (): void => {
    setPractitioner(undefined);
    onClose();
  };

  return (
    <Modal opened={props.opened} onClose={handleClose} title="Reassign thread" size="md">
      <Stack gap="xl">
        <Stack gap={0}>
          <Text fw={500}>Provider</Text>
          <Text c="dimmed">Select a provider to reassign this thread to</Text>
          <ResourceInput
            resourceType="Practitioner"
            name="practitioner"
            required={true}
            defaultValue={practitioner}
            onChange={(value) => setPractitioner(value as Practitioner | undefined)}
          />
        </Stack>

        <Button onClick={handleSubmit} loading={submitting}>
          Reassign
        </Button>
      </Stack>
    </Modal>
  );
}
