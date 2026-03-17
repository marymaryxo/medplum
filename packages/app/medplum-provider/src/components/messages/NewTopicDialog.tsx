// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Button, Modal, Stack, Text, TextInput } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { createReference } from '@medplum/core';
import type { Communication, Patient, Reference } from '@medplum/fhirtypes';
import { ResourceInput, useMedplum, useMedplumProfile } from '@medplum/react';
import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { showErrorNotification } from '../../utils/notifications';

interface NewTopicDialogProps {
  subject: Reference<Patient> | Patient | undefined;
  opened: boolean;
  onClose: () => void;
  onSubmit?: (communication: Communication) => void;
}

export const NewTopicDialog = (props: NewTopicDialogProps): JSX.Element => {
  const { subject, opened, onClose, onSubmit } = props;
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const profileRef = useMemo(() => (profile ? createReference(profile) : undefined), [profile]);

  const [patient, setPatient] = useState<Reference<Patient> | undefined>(
    subject ? createReference(subject as Patient) : undefined
  );
  const [topic, setTopic] = useState('');

  const handleSubmit = async (): Promise<void> => {
    if (!patient) {
      showNotification({
        title: 'Error',
        message: 'Please select a patient',
        color: 'red',
      });
      return;
    }

    // Include current practitioner in recipient so the thread appears in their inbox and they can participate.
    // This allows starting a new thread with any patient, even if a previous thread with that patient was reassigned.
    const recipient = profileRef ? [patient, profileRef] : [patient];
    const communication: Communication = {
      resourceType: 'Communication',
      status: 'in-progress',
      subject: patient,
      sender: profileRef,
      recipient,
      ...(topic.trim() ? { topic: { text: topic.trim() } } : {}),
    };

    try {
      const createdCommunication = await medplum.createResource(communication);
      onSubmit?.(createdCommunication);
      onClose();
    } catch (error) {
      showErrorNotification(error);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="New Message" size="md">
      <Stack gap="xl">
        <Stack gap={0}>
          <Text fw={500}>Patient</Text>
          <Text c="dimmed">Select a patient</Text>

          <ResourceInput
            resourceType="Patient"
            name="patient"
            required={true}
            defaultValue={patient}
            onChange={(value) => {
              setPatient(value ? (createReference(value) as Reference<Patient>) : undefined);
            }}
          />
        </Stack>
        <Stack gap={0}>
          <Text fw={500}>Topic (optional)</Text>
          <TextInput
            placeholder="Enter your topic"
            value={topic}
            onChange={(e) => setTopic(e.currentTarget.value)}
          />
        </Stack>

        <Button onClick={handleSubmit}>Next</Button>
      </Stack>
    </Modal>
  );
};
