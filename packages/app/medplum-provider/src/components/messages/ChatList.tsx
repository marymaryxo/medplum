// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Checkbox, Divider, Group, Stack, Text } from '@mantine/core';
import type { Communication } from '@medplum/fhirtypes';
import { Fragment } from 'react';
import type { JSX } from 'react';
import { ChatListItem } from './ChatListItem';

interface ChatListProps {
  threads: [Communication, Communication | undefined][];
  selectedCommunication: Communication | undefined;
  getThreadUri: (topic: Communication) => string;
  unreadThreadIds?: Set<string>;
  currentProfileRefStr?: string;
  selectionMode?: boolean;
  selectedThreadIds?: Set<string>;
  onToggleThread?: (threadId: string, checked: boolean) => void;
  onToggleAll?: (checked: boolean) => void;
}

function isReassignedToYouMessage(
  thread: Communication,
  message: Communication | undefined
): boolean {
  return (
    !!thread.identifier?.some((id) => id.system === 'https://medplum.com/thread-state' && id.value === 'reassigned-to-you') ||
    !!message?.identifier?.some((id) => id.system === 'https://medplum.com/thread-event' && id.value === 'reassigned-to-you')
  );
}

export const ChatList = (props: ChatListProps): JSX.Element => {
  const {
    threads,
    selectedCommunication,
    getThreadUri,
    unreadThreadIds = new Set(),
    currentProfileRefStr,
    selectionMode = false,
    selectedThreadIds = new Set(),
    onToggleThread,
    onToggleAll,
  } = props;
  const selectableThreadIds = threads.map(([thread]) => thread.id).filter((id): id is string => !!id);
  const selectedCount = selectableThreadIds.filter((id) => selectedThreadIds.has(id)).length;
  const allSelected = selectableThreadIds.length > 0 && selectedCount === selectableThreadIds.length;
  const someSelected = selectedCount > 0 && !allSelected;

  return (
    <Stack gap={0}>
      {selectionMode && (
        <>
          <Group px="sm" py="xs" justify="space-between" wrap="nowrap">
            <Checkbox
              checked={allSelected}
              indeterminate={someSelected}
              onChange={(event) => onToggleAll?.(event.currentTarget.checked)}
              aria-label="Select all threads"
            />
            <Text size="xs" c="dimmed">
              Select all
            </Text>
          </Group>
          <Divider />
        </>
      )}
      {threads.map((thread: [Communication, Communication | undefined]) => {
        const topicCommunication = thread[0];
        const lastCommunication = thread[1];
        const isSelected = selectedCommunication?.id === topicCommunication.id;
        const isUnread = topicCommunication.id ? unreadThreadIds.has(topicCommunication.id) : false;
        const isReassignedThread = isReassignedToYouMessage(topicCommunication, lastCommunication);
        const reassignedRecipient = topicCommunication.recipient?.[0];
        const isReassignedToYou =
          isReassignedThread &&
          !!currentProfileRefStr &&
          referenceMatches(reassignedRecipient?.reference, currentProfileRefStr);
        const reassignedLabel = isReassignedThread
          ? isReassignedToYou
            ? 'Reassigned to you'
            : `Reassigned to ${reassignedRecipient?.display ?? reassignedRecipient?.reference?.split('/').pop() ?? 'another provider'}`
          : undefined;
        return (
          <Fragment key={topicCommunication.id}>
            <ChatListItem
              topic={topicCommunication}
              lastCommunication={lastCommunication}
              isSelected={isSelected}
              isUnread={isUnread}
              reassignedLabel={reassignedLabel}
              selectionMode={selectionMode}
              isChecked={!!topicCommunication.id && selectedThreadIds.has(topicCommunication.id)}
              onToggleChecked={onToggleThread}
              getThreadUri={getThreadUri}
            />
            <Divider />
          </Fragment>
        );
      })}
    </Stack>
  );
};

function referenceMatches(refStr: string | undefined, otherRefStr: string | undefined): boolean {
  if (!refStr || !otherRefStr) {
    return false;
  }
  const normalize = (s: string): string => {
    const parts = s.split('/').filter(Boolean);
    return parts.length >= 2 ? parts.slice(-2).join('/') : s;
  };
  return normalize(refStr) === normalize(otherRefStr);
}
