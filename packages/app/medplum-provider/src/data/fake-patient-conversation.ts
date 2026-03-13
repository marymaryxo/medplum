// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import type { Bundle, Communication, Patient, Reference } from '@medplum/fhirtypes';
import { getReferenceString } from '@medplum/core';
import { SAMPLE_MESSAGES } from './sample-messages';

/**
 * Builds a Communication (topic/thread) for an existing patient.
 * Uses the patient reference directly — no fake patient creation.
 * Topic is omitted (concept removed from UI).
 */
export function buildConversationTopicBundle(
  profileRef: Reference,
  patientRef: Reference<Patient>
): Bundle {
  const now = new Date();
  const practitionerRefStr = getReferenceString(profileRef);

  const topicCommunication: Communication = {
    resourceType: 'Communication',
    status: 'in-progress',
    subject: patientRef,
    recipient: [{ reference: practitionerRefStr }],
    sent: new Date(now.getTime() - 45 * 60 * 1000).toISOString(),
  };

  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [
      {
        resource: topicCommunication,
        request: { method: 'POST' as const, url: 'Communication' },
      },
    ],
  };
}

/**
 * Builds a transaction bundle with message Communications.
 * Uses actual topic and patient references so partOf/sender/recipient resolve correctly.
 */
export function buildConversationMessagesBundle(
  profileRef: Reference,
  topicId: string,
  patientRef: Reference<Patient>
): Bundle {
  const now = new Date();
  const practitionerRefStr = getReferenceString(profileRef);
  const patientRefStr = getReferenceString(patientRef);
  const topicRef = `Communication/${topicId}`;

  const messageResources = SAMPLE_MESSAGES.map((msg) => {
    const sent = new Date(now.getTime() + msg.sentOffsetMinutes * 60 * 1000).toISOString();
    const isFromPatient = msg.sender === 'patient';
    return {
      resourceType: 'Communication' as const,
      status: 'completed' as const,
      partOf: [{ reference: topicRef }],
      sender: isFromPatient ? { reference: patientRefStr } : { reference: practitionerRefStr },
      recipient: isFromPatient ? [{ reference: practitionerRefStr }] : [{ reference: patientRefStr }],
      payload: [{ contentString: msg.text }],
      sent,
      received: sent,
    };
  });

  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: messageResources.map((resource, i) => ({
      fullUrl: `urn:uuid:sample-msg-${i}`,
      resource,
      request: { method: 'POST' as const, url: 'Communication' },
    })),
  };
}
