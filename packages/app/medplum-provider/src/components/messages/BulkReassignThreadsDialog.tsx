// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box, Button, Group, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import { createReference, getDisplayString } from '@medplum/core';
import type { Practitioner, Reference } from '@medplum/fhirtypes';
import { ResourceInput } from '@medplum/react';
import { useState } from 'react';
import type { JSX } from 'react';
import { showErrorNotification } from '../../utils/notifications';

interface BulkReassignThreadsDialogProps {
  opened: boolean;
  threadCount: number;
  fromProviderName: string;
  onClose: () => void;
  onReassign: (provider: Reference<Practitioner>, displayName: string, reason?: string) => Promise<void>;
}

export function BulkReassignThreadsDialog(props: BulkReassignThreadsDialogProps): JSX.Element {
  const { opened, threadCount, fromProviderName, onClose, onReassign } = props;
  const [practitioner, setPractitioner] = useState<Practitioner | Reference<Practitioner> | undefined>();
  const [reasonOption, setReasonOption] = useState<string | null>(null);
  const [otherReason, setOtherReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  const targetDisplayName =
    practitioner && typeof practitioner === 'object' && 'reference' in practitioner
      ? (practitioner as Reference<Practitioner>).display ?? 'selected provider'
      : practitioner
        ? getDisplayString(practitioner as Practitioner)
        : '[selected provider]';
  const showConfirmation = !!practitioner && !!reasonOption;

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
      handleClose();
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
    <Modal
      opened={opened}
      onClose={handleClose}
      title={
        <Text fw={600} fz={16} c="#000000">
          Reassign selected threads
        </Text>
      }
      size="md"
    >
      <Stack gap="xl">
        <Stack gap={0}>
          <Text fw={500} c="#000000">
            Provider
          </Text>
          <ResourceInput
            resourceType="Practitioner"
            name="bulk-practitioner"
            required={true}
            searchCriteria={{ _count: '100' }}
            defaultValue={practitioner}
            placeholder="Search by name"
            onChange={(value) => setPractitioner(value as Practitioner | undefined)}
          />
        </Stack>
        <Stack gap={0}>
          <Text fw={500} c="#000000">
            Reason for reassignment
          </Text>
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
        {showConfirmation && (
          <Box
            style={{
              backgroundColor: '#F2F5F6',
              borderRadius: 8,
              padding: '10px 14px',
            }}
          >
            <Text fz={14} fw={500} c="#000000">
              You are reassigning {threadCount} threads from {fromProviderName} to {targetDisplayName}
            </Text>
          </Box>
        )}
        <Group justify="flex-end">
          <Button
            onClick={handleClose}
            disabled={submitting}
            style={{
              backgroundColor: '#FFFFFF',
              border: '1px solid #CCD7DA',
              color: '#000000',
            }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            loading={submitting}
          >
            Confirm
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
