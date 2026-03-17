// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Button, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
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
  onReassign: (provider: Reference<Practitioner>, displayName: string, reason?: string) => Promise<void>;
}

export function ReassignThreadDialog(props: ReassignThreadDialogProps): JSX.Element {
  const { onClose, onReassign } = props;
  const [practitioner, setPractitioner] = useState<Practitioner | Reference<Practitioner> | undefined>();
  const [reasonOption, setReasonOption] = useState<string | null>(null);
  const [otherReason, setOtherReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>();
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

    if (!reasonOption) {
      setReasonError('Reason is required');
      return;
    }
    if (reasonOption === 'other' && !otherReason.trim()) {
      setReasonError('Please specify a reason');
      return;
    }

    const displayName =
      practitioner && typeof practitioner === 'object' && 'reference' in practitioner
        ? (practitioner as Reference<Practitioner>).display ?? 'Unknown provider'
        : getDisplayString(practitioner as Practitioner);
    const resolvedReason = reasonOption === 'other' ? otherReason.trim() : reasonOption;

    setSubmitting(true);
    try {
      await onReassign(practitionerRef, displayName, resolvedReason);
      setPractitioner(undefined);
      setReasonOption(null);
      setOtherReason('');
      setReasonError(undefined);
      onClose();
    } catch (error) {
      showErrorNotification(error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = (): void => {
    setPractitioner(undefined);
    setReasonOption(null);
    setOtherReason('');
    setReasonError(undefined);
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
            searchCriteria={{ _count: '100' }}
            defaultValue={practitioner}
            onChange={(value) => setPractitioner(value as Practitioner | undefined)}
          />
        </Stack>
        <Stack gap={0}>
          <Text fw={500}>Reason for reassignment</Text>
          <Select
            data={[
              { value: 'Member requested change', label: 'Member requested change' },
              { value: 'Provider leaving the company', label: 'Provider leaving the company' },
              { value: 'Provider leave of absence', label: 'Provider leave of absence' },
              {
                value: 'Provider suspended or under review',
                label: 'Provider suspended or under review',
              },
              { value: 'other', label: 'Other' },
            ]}
            value={reasonOption}
            onChange={(value) => {
              setReasonOption(value);
              setReasonError(undefined);
              if (value !== 'other') {
                setOtherReason('');
              }
            }}
            placeholder="Select a reason"
            required
            error={reasonError}
          />
          {reasonOption === 'other' && (
            <>
              <TextInput
                value={otherReason}
                onChange={(e) => {
                  setOtherReason(e.currentTarget.value.slice(0, 140));
                  setReasonError(undefined);
                }}
                placeholder="Please specify"
                maxLength={140}
                required
                mt={8}
              />
              <Text size="xs" c="dimmed" ta="right">
                {otherReason.length}/140
              </Text>
            </>
          )}
        </Stack>

        <Button onClick={handleSubmit} loading={submitting}>
          Reassign
        </Button>
      </Stack>
    </Modal>
  );
}
