// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Flex,
  Paper,
  ScrollArea,
  Stack,
  Text,
  ActionIcon,
  Divider,
  Button,
  Center,
  ThemeIcon,
  Menu,
  Skeleton,
  Box,
  Pagination,
  Group,
} from '@mantine/core';
import type { Attachment, Communication, Patient, Practitioner, Reference } from '@medplum/fhirtypes';
import { PatientSummary, ThreadChat, useMedplum, useResource } from '@medplum/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import {
  IconMessageCircle,
  IconChevronDown,
  IconFolder,
  IconPlus,
} from '@tabler/icons-react';
import { getDisplayString, getReferenceString, parseSearchRequest } from '@medplum/core';
import { useMedplumProfile } from '@medplum/react';
import type { SearchRequest } from '@medplum/core';
import { ChatList } from './ChatList';
import { NewTopicDialog } from './NewTopicDialog';
import { ReassignThreadDialog } from './ReassignThreadDialog';
import { SharedFilesDialog } from './SharedFilesDialog';
import { useThreadInbox } from '../../hooks/useThreadInbox';
import classes from './ThreadInbox.module.css';
import { useDisclosure } from '@mantine/hooks';
import { showErrorNotification } from '../../utils/notifications';
import { showNotification } from '@mantine/notifications';
import cx from 'clsx';
import { Link } from 'react-router';

const REASSIGNED_OPENED_THREAD_IDS_STORAGE_KEY = 'medplum-provider-reassignedOpenedThreadIds';

function loadOpenedReassignedThreadIds(): Set<string> {
  try {
    const raw = sessionStorage.getItem(REASSIGNED_OPENED_THREAD_IDS_STORAGE_KEY);
    if (!raw) {
      return new Set();
    }
    const parsed = JSON.parse(raw) as string[];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

/**
 * ThreadInbox is a component that displays a list of threads and allows the user to select a thread to view.
 * @param query - The query to fetch all communications.
 * @param threadId - The id of the thread to select.
 * @param subject - The default subject when creating a new thread.
 * @param showPatientSummary - Whether to show the patient summary.
 * @param onNew - A function to handle a new thread.
 * @param getThreadUri - A function to build thread URIs.
 * @param onChange - A function to handle search changes.
 * @param inProgressUri - The URI for in-progress threads.
 * @param completedUri - The URI for completed threads.
 */

interface ThreadInboxProps {
  query: string;
  threadId: string | undefined;
  subject?: Reference<Patient> | Patient | undefined;
  showPatientSummary?: boolean | undefined;
  onNew: (message: Communication) => void;
  getThreadUri: (topic: Communication) => string;
  onChange: (search: SearchRequest) => void;
  inProgressUri: string;
  completedUri: string;
}

export function ThreadInbox(props: ThreadInboxProps): JSX.Element {
  const {
    query,
    threadId,
    subject,
    showPatientSummary = false,
    onNew,
    getThreadUri,
    onChange,
    inProgressUri,
    completedUri,
  } = props;

  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [modalOpened, { open: openModal, close: closeModal }] = useDisclosure(false);
  const [sharedFilesOpened, { open: openSharedFiles, close: closeSharedFiles }] = useDisclosure(false);
  const [reassignOpened, { open: openReassign, close: closeReassign }] = useDisclosure(false);
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [openedReassignedThreadIds, setOpenedReassignedThreadIds] = useState<Set<string>>(loadOpenedReassignedThreadIds);

  const currentSearch = useMemo(() => parseSearchRequest(`Communication?${query}`), [query]);

  const searchParams = useMemo(() => new URLSearchParams(query), [query]);
  const itemsPerPage = Number.parseInt(searchParams.get('_count') || '20', 10);
  const currentOffset = Number.parseInt(searchParams.get('_offset') || '0', 10);
  const currentPage = Math.floor(currentOffset / itemsPerPage) + 1;
  const status = (searchParams.get('status') as Communication['status']) || 'in-progress';

  const {
    loading,
    error,
    threadMessages,
    selectedThread,
    total,
    unreadThreadIds,
    userMarkedUnreadThreadIds,
    handleThreadStatusChange,
    handleMarkThreadAsUnread,
    addThreadMessage,
    refreshThreadMessages,
  } = useThreadInbox({
    query,
    threadId,
  });

  useEffect(() => {
    if (error) {
      showErrorNotification(error);
    }
  }, [error]);

  useEffect(() => {
    setPendingAttachments([]);
  }, [selectedThread?.id]);

  const handleTopicStatusChangeWithErrorHandling = async (newStatus: Communication['status']): Promise<void> => {
    try {
      await handleThreadStatusChange(newStatus);
      await refreshThreadMessages();
    } catch (error) {
      showErrorNotification(error);
    }
  };

  const handleNewTopicCompletion = (message: Communication): void => {
    addThreadMessage(message);
    onNew(message);
  };

  const profileRefStr = profile ? getReferenceString(profile) : undefined;
  const isReassignedAway =
    !!selectedThread &&
    !!profileRefStr &&
    !selectedThread.recipient?.some((r) => referenceMatches(r.reference, profileRefStr));

  const newPractitionerRef = isReassignedAway ? selectedThread?.recipient?.[0] : undefined;
  const newPractitioner = useResource(newPractitionerRef);
  const reassignedToName = newPractitioner
    ? getDisplayString(newPractitioner)
    : newPractitionerRef?.display || 'another provider';
  const selectedPatient = useResource(selectedThread?.subject as Reference<Patient> | undefined);
  const selectedThreadLastMessage = useMemo(
    () => threadMessages.find(([parent]) => parent.id === selectedThread?.id)?.[1],
    [threadMessages, selectedThread?.id]
  );
  const isSelectedThreadReassignedToMe =
    !!selectedThread?.identifier?.some(
      (id) => id.system === 'https://medplum.com/thread-state' && id.value === 'reassigned-to-you'
    ) &&
    !!profileRefStr &&
    !!selectedThread?.recipient?.some((r) => referenceMatches(r.reference, profileRefStr));
  const assignerResource = useResource(selectedThreadLastMessage?.sender);
  const assignerNameFromThreadState = selectedThread?.identifier?.find(
    (id) => id.system === 'https://medplum.com/thread-state/assigner-display'
  )?.value;
  const assignerName =
    assignerNameFromThreadState ||
    (assignerResource && getDisplayString(assignerResource)) ||
    selectedThreadLastMessage?.sender?.display ||
    'A provider';
  const selectedPatientName =
    (selectedPatient && getDisplayString(selectedPatient)) ||
    selectedThread?.subject?.display ||
    'Patient';
  const isSelectedThreadReassigned =
    !!selectedThread?.identifier?.some(
      (id) => id.system === 'https://medplum.com/thread-state' && id.value === 'reassigned-to-you'
    );

  const handleReassign = useCallback(
    async (providerRef: Reference<Practitioner>, displayName: string): Promise<void> => {
      if (!selectedThread || !profile || !profileRefStr) return;
      const patientName =
        (selectedThread.subject && typeof selectedThread.subject === 'object' && selectedThread.subject.display) ||
        'Patient';
      const fromProviderName = getDisplayString(profile);
      const reassignmentMessage = `${fromProviderName} reassigned ${patientName}'s thread to you.`;

      await medplum.updateResource({
        ...selectedThread,
        recipient: [{ ...providerRef, display: displayName }],
        status: 'completed',
        identifier: [
          ...(selectedThread.identifier ?? []).filter(
            (id) =>
              !(
                (id.system === 'https://medplum.com/thread-state' && id.value === 'reassigned-to-you') ||
                id.system === 'https://medplum.com/thread-state/assigner-display'
              )
          ),
          { system: 'https://medplum.com/thread-state', value: 'reassigned-to-you' },
          { system: 'https://medplum.com/thread-state/assigner-display', value: fromProviderName },
        ],
      });
      await medplum.createResource<Communication>({
        resourceType: 'Communication',
        status: 'in-progress',
        sender: profileRefStr ? { reference: profileRefStr, display: fromProviderName } : undefined,
        recipient: [{ reference: providerRef.reference, display: displayName }],
        partOf: [{ reference: `Communication/${selectedThread.id}` }],
        identifier: [{ system: 'https://medplum.com/thread-event', value: 'reassigned-to-you' }],
        payload: [{ contentString: reassignmentMessage }],
        sent: new Date().toISOString(),
      });
      showNotification({
        color: 'green',
        message: `Thread reassigned to ${displayName}. You can no longer reply.`,
      });
      await refreshThreadMessages();
      closeReassign();
    },
    [selectedThread, profile, profileRefStr, medplum, refreshThreadMessages, closeReassign]
  );

  useEffect(() => {
    if (!selectedThread?.id || !isSelectedThreadReassigned) {
      return;
    }
    setOpenedReassignedThreadIds((prev) => {
      if (prev.has(selectedThread.id as string)) {
        return prev;
      }
      const next = new Set(prev).add(selectedThread.id as string);
      try {
        sessionStorage.setItem(REASSIGNED_OPENED_THREAD_IDS_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  }, [selectedThread?.id, isSelectedThreadReassigned]);

  const skeletonTitleWidths = [80, 72, 68, 64];
  const skeletonSubtitleWidths = [85, 78, 70, 60];

  return (
    <>
      <div className={classes.container}>
        <Flex direction="row" h="100%" w="100%">
          {/* Left sidebar - Messages list */}
          <Flex direction="column" w={380} h="100%" className={classes.rightBorder}>
            <Paper h="100%" style={{ display: 'flex', flexDirection: 'column' }}>
              <ScrollArea style={{ flex: 1 }} scrollbarSize={10} type="hover" scrollHideDelay={250}>
                <Flex h={64} align="center" justify="space-between" p="md">
                  <Group gap="xs">
                    <Button
                      component={Link}
                      to={inProgressUri}
                      className={cx(classes.button, { [classes.selected]: status === 'in-progress' })}
                      h={32}
                      radius="xl"
                    >
                      Inbox
                    </Button>
                    <Button
                      component={Link}
                      to={completedUri}
                      className={cx(classes.button, { [classes.selected]: status === 'completed' })}
                      h={32}
                      radius="xl"
                    >
                      Done
                    </Button>
                  </Group>
                  <ActionIcon radius="50%" variant="filled" color="blue" onClick={openModal}>
                    <IconPlus size={16} />
                  </ActionIcon>
                </Flex>
                <Divider />
                {loading ? (
                  <Stack gap="md" p="md">
                    {Array.from({ length: 10 }).map((_, index) => {
                      const titleWidth = skeletonTitleWidths[index % skeletonTitleWidths.length];
                      const subtitleWidth = skeletonSubtitleWidths[index % skeletonSubtitleWidths.length];
                      return (
                        <Flex key={index} gap="sm" align="flex-start">
                          <Skeleton height={40} width={40} radius="50%" />
                          <Box style={{ flex: 1 }}>
                            <Flex direction="column" gap="xs">
                              <Skeleton height={16} width={`${titleWidth}%`} />
                              <Skeleton height={14} width={`${subtitleWidth}%`} />
                            </Flex>
                          </Box>
                        </Flex>
                      );
                    })}
                  </Stack>
                ) : (
                  threadMessages.length > 0 && (
                    <ChatList
                      threads={threadMessages}
                      selectedCommunication={selectedThread}
                      getThreadUri={getThreadUri}
                      unreadThreadIds={unreadThreadIds}
                      currentProfileRefStr={profileRefStr}
                      openedReassignedThreadIds={openedReassignedThreadIds}
                    />
                  )
                )}
                {threadMessages.length === 0 && !loading && <EmptyMessagesState />}
              </ScrollArea>
              {!loading && total !== undefined && total > itemsPerPage && (
                <Box p="md">
                  <Center>
                    <Pagination
                      value={currentPage}
                      total={Math.ceil(total / itemsPerPage)}
                      onChange={(page) => {
                        const offset = (page - 1) * itemsPerPage;
                        onChange({
                          ...currentSearch,
                          offset,
                        });
                      }}
                      size="sm"
                      siblings={1}
                      boundaries={1}
                    />
                  </Center>
                </Box>
              )}
            </Paper>
          </Flex>

          {selectedThread ? (
            <>
              {/* Main chat area */}
              <Flex direction="column" style={{ flex: 1, minHeight: 0 }} h="100%" className={classes.rightBorder}>
                <Paper h="100%" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
                  <Stack h="100%" gap={0} style={{ minHeight: 0 }}>
                    <Flex h={64} align="center" justify="space-between" p="md">
                      <Text fw={800} truncate fz="lg">
                        {selectedThread.topic?.text ?? 'Messages'}
                      </Text>

                      <Group gap="xs">
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          size="lg"
                          aria-label="View all shared files"
                          onClick={openSharedFiles}
                        >
                          <IconFolder size={20} stroke={1.5} />
                        </ActionIcon>
                        <Menu position="bottom-end" shadow="md">
                        <Menu.Target>
                          <Button
                            variant="light"
                            color={getStatusColor(selectedThread.status)}
                            rightSection={<IconChevronDown size={16} />}
                            radius="xl"
                            size="sm"
                          >
                            {getStatusLabel(selectedThread.status)}
                          </Button>
                        </Menu.Target>

                        <Menu.Dropdown>
                          <Menu.Item
                            onClick={() => handleTopicStatusChangeWithErrorHandling('in-progress')}
                            disabled={selectedThread.status === 'in-progress'}
                          >
                            Move to inbox
                          </Menu.Item>
                          <Menu.Item
                            onClick={() => handleTopicStatusChangeWithErrorHandling('completed')}
                            disabled={selectedThread.status === 'completed'}
                          >
                            Mark as done
                          </Menu.Item>
                          {!isReassignedAway && (
                            <>
                              <Menu.Divider />
                              <Menu.Item onClick={openReassign}>
                                Reassign to provider
                              </Menu.Item>
                            </>
                          )}
                          <Menu.Item onClick={() => handleMarkThreadAsUnread()}>Mark as unread</Menu.Item>
                        </Menu.Dropdown>
                        </Menu>
                      </Group>
                    </Flex>
                    <Divider />
                    {isReassignedAway && (
                      <Alert
                        color="blue"
                        variant="light"
                        m="md"
                        mb={0}
                        style={{ flexShrink: 0 }}
                        styles={{ body: { overflow: 'visible', minHeight: 'auto' } }}
                      >
                        Thread reassigned to {reassignedToName}. You can no longer reply.
                      </Alert>
                    )}
                    {!isReassignedAway && isSelectedThreadReassignedToMe && selectedThread.status === 'in-progress' && (
                      <Alert
                        color="blue"
                        variant="light"
                        m="md"
                        mb={0}
                        style={{ flexShrink: 0 }}
                        styles={{ body: { overflow: 'visible', minHeight: 'auto' } }}
                      >
                        {assignerName} reassigned {selectedPatientName}'s thread to you.
                      </Alert>
                    )}
                    <Flex direction="column" style={{ flex: 1, minHeight: 0 }} h="100%">
                      <ThreadChat
                        key={`${getReferenceString(selectedThread)}`}
                        title={'Messages'}
                        thread={selectedThread}
                        excludeHeader={true}
                        inputDisabled={isReassignedAway}
                        // @ts-expect-error ThreadChat supports attachments - see ThreadChatProps in source
                        attachments={pendingAttachments}
                        onAttachmentsChange={(attachments: Attachment[]) => setPendingAttachments(attachments)}
                        disableAutoMarkAsRead={
                          selectedThread.id ? userMarkedUnreadThreadIds.has(selectedThread.id) : false
                        }
                        onMessagesMarkedAsRead={refreshThreadMessages}
                      />
                    </Flex>
                  </Stack>
                </Paper>
              </Flex>

              {/* Right sidebar - Patient summary */}
              {selectedThread.subject && showPatientSummary && (
                <Flex direction="column" w={300} h="100%">
                  <ScrollArea p={0} h="100%" scrollbarSize={10} type="hover" scrollHideDelay={250}>
                    <PatientSummary key={selectedThread.id} patient={selectedThread.subject as Reference<Patient>} />
                  </ScrollArea>
                </Flex>
              )}
            </>
          ) : (
            <Flex direction="column" style={{ flex: 1 }} h="100%">
              <NoMessages />
            </Flex>
          )}
        </Flex>
      </div>
      <NewTopicDialog subject={subject} opened={modalOpened} onClose={closeModal} onSubmit={handleNewTopicCompletion} />
      <SharedFilesDialog thread={selectedThread} opened={sharedFilesOpened} onClose={closeSharedFiles} />
      <ReassignThreadDialog
        thread={selectedThread}
        opened={reassignOpened}
        onClose={closeReassign}
        onReassign={handleReassign}
      />
    </>
  );
}

function NoMessages(): JSX.Element {
  return (
    <Center h="100%" w="100%">
      <Stack align="center" gap="md">
        <ThemeIcon size={64} variant="light" color="gray">
          <IconMessageCircle size={32} />
        </ThemeIcon>
        <Stack align="center" gap="xs">
          <Text size="sm" c="dimmed" ta="center">
            Select a message from the list to view details
          </Text>
        </Stack>
      </Stack>
    </Center>
  );
}

/** Returns user-facing label for thread status */
function getStatusLabel(status: Communication['status']): string {
  if (status === 'in-progress') return 'Inbox';
  if (status === 'completed') return 'Done';
  if (status === 'stopped') return 'Stopped';
  return status?.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') ?? '';
}

function getStatusColor(status: Communication['status']): string {
  if (status === 'completed') {
    return 'green';
  }
  if (status === 'stopped') {
    return 'red';
  }
  return 'blue';
}

function EmptyMessagesState(): JSX.Element {
  return (
    <Flex direction="column" h="100%" justify="center" align="center">
      <Stack align="center" gap="md" pt="xl">
        <IconMessageCircle size={64} color="var(--mantine-color-gray-4)" />
        <Text size="lg" c="dimmed" fw={500}>
          No messages found
        </Text>
      </Stack>
    </Flex>
  );
}

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
