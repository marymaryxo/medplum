// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { createReference, formatCodeableConcept, getReferenceString } from '@medplum/core';
import type { Attachment, Communication } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile, usePrevious } from '@medplum/react-hooks';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BaseChat } from '../BaseChat/BaseChat';

export interface ThreadChatProps {
  readonly thread: Communication;
  readonly title?: string;
  readonly onMessageSent?: (message: Communication) => void;
  readonly inputDisabled?: boolean;
  readonly excludeHeader?: boolean;
  readonly onError?: (err: Error) => void;
  /** External attachment state - when provided, attachments managed by parent */
  readonly attachments?: Attachment[];
  readonly onAttachmentsChange?: (attachments: Attachment[]) => void;
  /** When true, use polling instead of WebSocket for new messages */
  readonly disableWebSocket?: boolean;
  /** Ref to trigger attachment from outside (e.g. header button) */
  readonly attachmentTriggerRef?: React.Ref<{ trigger: () => void }>;
  /** Ref to trigger form submit from outside (e.g. header send button) */
  readonly submitFormRef?: React.Ref<() => void>;
  /** Callback to register send function for header button */
  readonly onSendReady?: (send: () => void) => void;
  /** Messages sent from outside (e.g. header) - merged into display for immediate feedback */
  readonly injectedMessages?: Communication[];
  /** When true, do not auto-mark messages as read when viewing (e.g. user explicitly marked thread unread) */
  readonly disableAutoMarkAsRead?: boolean;
  /** Called after marking messages as read on load (so parent can refresh unread list) */
  readonly onMessagesMarkedAsRead?: () => void;
}

export function ThreadChat(props: ThreadChatProps): JSX.Element | null {
  const {
    thread,
    title,
    onMessageSent,
    inputDisabled,
    excludeHeader,
    onError,
    attachments,
    onAttachmentsChange,
    attachmentTriggerRef,
    submitFormRef,
    onSendReady,
    injectedMessages = [],
    disableAutoMarkAsRead = false,
    onMessagesMarkedAsRead,
  } = props;
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const prevThreadId = usePrevious<string | undefined>(thread?.id);
  const [communications, setCommunications] = useState<Communication[]>([]);

  const profileRef = useMemo(() => (profile ? createReference(profile) : undefined), [profile]);
  const threadRef = useMemo(() => createReference(thread), [thread]);

  useEffect(() => {
    if (thread?.id !== prevThreadId) {
      setCommunications([]);
    }
  }, [thread?.id, prevThreadId]);

  const sendMessage = useCallback(
    (content: string | Attachment, fileAttachments?: Attachment[]) => {
      const profileRefStr = profileRef ? getReferenceString(profileRef) : undefined;
      if (!profileRefStr) {
        return;
      }
      const messagePayload =
        typeof content === 'string'
          ? content
            ? [{ contentString: content }]
            : []
          : [{ contentAttachment: content }];
      const payload = [...messagePayload, ...(fileAttachments ?? []).map((att) => ({ contentAttachment: att }))];
      if (payload.length === 0) {
        return;
      }
      medplum
        .createResource<Communication>({
          resourceType: 'Communication',
          status: 'in-progress',
          sender: profileRef,
          recipient: thread.recipient?.filter((ref) => getReferenceString(ref) !== profileRefStr) ?? [],
          sent: new Date().toISOString(),
          payload,
          partOf: [threadRef],
        })
        .then((communication) => {
          setCommunications((prev) => [...prev, communication]);
          onMessageSent?.(communication);
        })
        .catch(console.error);
    },
    [medplum, profileRef, thread, threadRef, onMessageSent]
  );

  // Currently we only support `delivered` on chats with 2 participants
  // Normally we would use `useCallback` to memoize a function
  // But in this case we only want to conditionally pass a function if the thread has 2 participants...
  // If the thread has 3 or more participants, we do not pass this function; instead we pass undefined
  const onMessageReceived = useMemo(
    () =>
      !disableAutoMarkAsRead && thread.recipient?.length === 2
        ? (message: Communication): void => {
            if (!(message.received && message.status === 'completed')) {
              medplum
                .updateResource({
                  ...message,
                  received: message.received ?? new Date().toISOString(), // Mark as received if needed
                  status: 'completed', // Mark as 'read'
                  // See: https://www.medplum.com/docs/communications/organizing-communications#:~:text=THE%20Communication%20LIFECYCLE
                  // for more info about recommended `Communication` lifecycle
                })
                .catch(console.error);
            }
          }
        : undefined,
    [medplum, thread.recipient?.length, disableAutoMarkAsRead]
  );

  const mergedCommunications = useMemo(() => {
    const byId = new Map<string, Communication>();
    const injectedById = new Map<string, Communication>();
    for (const c of injectedMessages) {
      if (c.id) injectedById.set(c.id, c);
    }
    for (const c of communications) {
      if (!c.id) continue;
      const injected = injectedById.get(c.id);
      const hasPayload = (p: Communication['payload']) =>
        Array.isArray(p) && p.length > 0 && p.some((item) => item && typeof item === 'object' && 'contentAttachment' in item);
      if (injected && !hasPayload(c.payload) && hasPayload(injected.payload)) {
        byId.set(c.id, { ...c, payload: injected.payload });
      } else {
        byId.set(c.id, c);
      }
    }
    for (const c of injectedMessages) {
      if (c.id && !byId.has(c.id)) byId.set(c.id, c);
    }
    const merged = Array.from(byId.values());
    merged.sort((a, b) => {
      const sa = a.sent ?? '';
      const sb = b.sent ?? '';
      return sa.localeCompare(sb);
    });
    return merged;
  }, [communications, injectedMessages]);

  if (!profile) {
    return null;
  }

  return (
    <BaseChat
      title={title ?? (thread?.topic ? formatCodeableConcept(thread.topic) : '[No thread title]')}
      communications={mergedCommunications}
      setCommunications={setCommunications}
      query={`part-of=Communication/${thread.id as string}`}
      sendMessage={sendMessage}
      onMessageReceived={onMessageReceived}
      inputDisabled={inputDisabled}
      excludeHeader={excludeHeader}
      onError={onError}
      attachments={attachments}
      onAttachmentsChange={onAttachmentsChange}
      attachmentTriggerRef={attachmentTriggerRef}
      submitFormRef={submitFormRef}
      onSendReady={onSendReady}
      disableWebSocket={true}
      onMessagesMarkedAsRead={onMessagesMarkedAsRead}
      subjectRef={thread.subject}
    />
  );
}
