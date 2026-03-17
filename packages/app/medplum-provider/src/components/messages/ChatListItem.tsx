// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box, Checkbox, Group, Stack, Text } from '@mantine/core';
import type { Communication, HumanName, Patient, Reference } from '@medplum/fhirtypes';
import { MedplumLink, ResourceAvatar, useResource } from '@medplum/react';
import type { JSX } from 'react';
import { formatHumanName, getDisplayString, isValidDate } from '@medplum/core';
import classes from './ChatListItem.module.css';
import cx from 'clsx';

function formatChatTimestamp(dateTime: string | undefined): string {
  if (!dateTime) return '';
  const d = new Date(dateTime);
  if (!isValidDate(d)) return '';

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const dateOnly = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const timeStr = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });

  if (dateOnly.getTime() === today.getTime()) {
    return `Today ${timeStr}`;
  }
  if (dateOnly.getTime() === yesterday.getTime()) {
    return 'Yesterday';
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

interface ChatListItemProps {
  topic: Communication;
  lastCommunication: Communication | undefined;
  isSelected: boolean;
  isUnread?: boolean;
  reassignedLabel?: string;
  selectionMode?: boolean;
  isChecked?: boolean;
  onToggleChecked?: (threadId: string, checked: boolean) => void;
  getThreadUri: (topic: Communication) => string;
}

export const ChatListItem = (props: ChatListItemProps): JSX.Element => {
  const {
    topic,
    lastCommunication,
    isSelected,
    isUnread = false,
    reassignedLabel,
    selectionMode = false,
    isChecked = false,
    onToggleChecked,
    getThreadUri,
  } = props;
  const patientResource = useResource(topic.subject as Reference<Patient>);
  const patientName = formatHumanName(patientResource?.name?.[0] as HumanName);
  const refId = topic.subject?.reference?.split('/').pop();
  const resourceDisplay = patientResource ? getDisplayString(patientResource) : null;
  const refDisplay = topic.subject?.display;
  /** Treat "Patient" or "Patient/123" as non-names - we must show an explicit patient name, not a generic label */
  const isGenericPatientLabel =
    resourceDisplay === 'Patient' || (resourceDisplay?.startsWith('Patient/') ?? false);
  const hasExplicitName =
    patientName ||
    (resourceDisplay && !isGenericPatientLabel) ||
    (refDisplay && refDisplay !== 'Patient');
  const primaryTitle = hasExplicitName
    ? (patientName || resourceDisplay || refDisplay)
    : refId
      ? `Patient name not available (ID: ${refId})`
      : 'Patient name not available';
  const lastMsg = lastCommunication?.payload?.[0]?.contentString;
  const trimmedMsg = lastMsg?.length && lastMsg.length > 100 ? lastMsg.slice(0, 100) + '...' : lastMsg;
  const senderName = lastCommunication?.sender?.display ? `${lastCommunication?.sender?.display}: ` : '';
  const isOwnershipChangeEvent = !!lastCommunication?.identifier?.some(
    (id) => id.system === 'https://medplum.com/thread-event' && id.value === 'ownership-change'
  );
  const isJsonLikeMessage = !!trimmedMsg && /^\s*\{[\s\S]*\}\s*$/.test(trimmedMsg);
  const safePreview = isOwnershipChangeEvent || isJsonLikeMessage ? 'Thread reassigned' : trimmedMsg;
  const previewContent = safePreview ? `${senderName}${safePreview}` : `No messages available`;

  const rowContent = (
    <Group
      p="xs"
      align="center"
      wrap="nowrap"
      className={cx(classes.contentContainer, {
        [classes.selected]: isSelected,
        [classes.unread]: isUnread,
      })}
      onClick={() => {
        if (selectionMode && topic.id) {
          onToggleChecked?.(topic.id, !isChecked);
        }
      }}
      style={selectionMode ? { cursor: 'pointer' } : undefined}
    >
      {selectionMode && topic.id && (
        <Checkbox
          checked={isChecked}
          onChange={(event) => onToggleChecked?.(topic.id as string, event.currentTarget.checked)}
          onClick={(event) => event.stopPropagation()}
          aria-label={`Select ${primaryTitle}`}
        />
      )}
      <ResourceAvatar value={topic.subject as Reference<Patient>} radius="xl" size={36} />
      <Stack gap={0}>
        <Group gap="xs" wrap="nowrap" align="center">
          {isUnread && <Box className={classes.unreadDot} aria-hidden />}
          <Text size="sm" fw={isUnread ? 800 : 400} truncate="end">
            {primaryTitle}
          </Text>
        </Group>
        <Text size="sm" fw={isUnread ? 600 : 400} lineClamp={2} className={cx(classes.content, classes.secondaryText)}>
          {previewContent}
        </Text>
        {reassignedLabel && (
          <Text className={classes.reassignedLabel} lineClamp={1}>
            {reassignedLabel}
          </Text>
        )}
        <Text size="xs" style={{ marginTop: 2 }} fw={isUnread ? 600 : 400} className={classes.secondaryText}>
          {lastCommunication ? formatChatTimestamp(lastCommunication.sent) : ''}
        </Text>
      </Stack>
    </Group>
  );

  if (selectionMode) {
    return rowContent;
  }

  return (
    <MedplumLink to={getThreadUri(topic)} underline="never">
      {rowContent}
    </MedplumLink>
  );
};
