// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { useState, useEffect, useCallback, useRef } from 'react';
import type { Communication } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { getReferenceString } from '@medplum/core';

const USER_MARKED_UNREAD_STORAGE_KEY = 'medplum-provider-userMarkedUnreadThreadIds';

function loadUserMarkedUnreadFromStorage(): Set<string> {
  try {
    const stored = sessionStorage.getItem(USER_MARKED_UNREAD_STORAGE_KEY);
    if (stored) {
      const arr = JSON.parse(stored) as string[];
      return new Set(Array.isArray(arr) ? arr : []);
    }
  } catch {
    // ignore parse errors
  }
  return new Set();
}

function saveUserMarkedUnreadToStorage(ids: Set<string>): void {
  try {
    sessionStorage.setItem(USER_MARKED_UNREAD_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage errors
  }
}

export interface UseThreadInboxOptions {
  query: string;
  threadId: string | undefined;
  /** Optional recipient reference used for delegated/read-only inbox views. */
  recipientRefOverride?: string;
  /** When true, do not mutate unread/read state while browsing. */
  readOnlyMode?: boolean;
}

export interface UseThreadInboxReturn {
  loading: boolean;
  error: Error | null;
  // Tuple: [Parent Thread, Last Message in Thread (optional)]
  threadMessages: [Communication, Communication | undefined][];
  selectedThread: Communication | undefined;
  total: number | undefined;
  /** Thread IDs that have unread messages (for the current user) */
  unreadThreadIds: Set<string>;
  /** Thread IDs the user explicitly marked as unread - disable auto-mark-as-read when viewing */
  userMarkedUnreadThreadIds: Set<string>;
  addThreadMessage: (message: Communication) => void;
  handleThreadStatusChange: (newStatus: Communication['status']) => Promise<void>;
  handleMarkThreadAsRead: () => Promise<void>;
  handleMarkThreadAsUnread: () => Promise<void>;
  refreshThreadMessages: () => Promise<void>;
}

/*
useThreadInbox is a hook that fetches all communications and returns the thread messages and selected thread.
All communications returned do not have a partOf field.
It also provides a function to update the status of the selected thread.

@param query - The query to fetch all communications.
@param threadId - The id of the thread to select.
@returns The thread messages and selected thread.
@returns A function to update the status of the selected thread.
*/
export function useThreadInbox({
  query,
  threadId,
  recipientRefOverride,
  readOnlyMode = false,
}: UseThreadInboxOptions): UseThreadInboxReturn {
  const medplum = useMedplum();
  const [loading, setLoading] = useState(true);
  const [threadMessages, setThreadMessages] = useState<[Communication, Communication | undefined][]>([]);
  const [selectedThread, setSelectedThread] = useState<Communication | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [unreadThreadIds, setUnreadThreadIds] = useState<Set<string>>(new Set());
  const [userMarkedUnreadThreadIds, setUserMarkedUnreadThreadIds] = useState<Set<string>>(loadUserMarkedUnreadFromStorage);
  const userMarkedUnreadRef = useRef<Set<string>>(loadUserMarkedUnreadFromStorage());
  userMarkedUnreadRef.current = userMarkedUnreadThreadIds;

  // Persist userMarkedUnreadThreadIds across page navigation (e.g. Messages -> Schedule -> Messages)
  useEffect(() => {
    saveUserMarkedUnreadToStorage(userMarkedUnreadThreadIds);
  }, [userMarkedUnreadThreadIds]);

  const fetchAllCommunications = useCallback(async (): Promise<void> => {
    const searchParams = new URLSearchParams(query);
    const requestedStatus = searchParams.get('status') as Communication['status'] | null;
    const profile = medplum.getProfile();
    const profileRefStr = profile ? getReferenceString(profile) : undefined;
    const isAdminUser = isAdminProfile(profile as { email?: string; username?: string; telecom?: { system?: string; value?: string }[] } | undefined);
    const recipientForQuery = recipientRefOverride ?? profileRefStr;
    const shouldFilterByRecipient =
      !!recipientForQuery &&
      requestedStatus === 'in-progress' &&
      !(isAdminUser && !recipientRefOverride);
    if (shouldFilterByRecipient) {
      // Inbox should only contain threads assigned to current provider.
      // Keep Done behavior aligned with provider experience (not recipient-filtered).
      searchParams.append('recipient', recipientForQuery);
    }
    searchParams.append('identifier:not', 'ai-message-topic');
    searchParams.append('part-of:missing', 'true');
    searchParams.append('_has:Communication:part-of:_id:not', 'null');

    const bundle = await medplum.search('Communication', searchParams.toString(), { cache: 'no-cache' });
    const parents =
      bundle.entry
        ?.map((entry) => entry.resource as Communication)
        .filter((r): r is Communication => r !== undefined) || [];

    if (bundle.total !== undefined) {
      setTotal(bundle.total);
    }

    if (parents.length === 0) {
      setThreadMessages([]);
      return;
    }

    const queryParts = parents.map((parent) => {
      const safeId = parent.id?.replace(/-/g, '') || '';
      const alias = `thread_${safeId}`;
      const ref = getReferenceString(parent);

      return `
          ${alias}: CommunicationList(
            part_of: "${ref}"
            _sort: "-sent"
            _count: 1
          ) {
            id
            meta {
              lastUpdated
            }
            partOf {
              reference
            }
            sender {
              display
              reference
            }
            recipient {
              display
              reference
            }
            identifier {
              system
              value
            }
            payload {
              contentString
            }
            sent
            status
          }
        `;
    });

    const fullQuery = `
        query {
          ${queryParts.join('\n')}
        }
      `;

    const response = await medplum.graphql(fullQuery);

    const threadsWithReplies: [Communication, Communication | undefined][] = parents.map((parent) => {
        const safeId = parent.id?.replace(/-/g, '') || '';
        const alias = `thread_${safeId}`;
        const childList = response.data[alias] as Communication[] | undefined;
        const lastMessage = childList && childList.length > 0 ? childList[0] : undefined;
        return [parent, lastMessage];
      });
    const filteredThreads = requestedStatus
      ? threadsWithReplies.filter(([parent]) => parent.status === requestedStatus)
      : threadsWithReplies;

    const sortedThreads = [...filteredThreads].sort((a, b) => {
      const aTime = getThreadSortTimeMs(a);
      const bTime = getThreadSortTimeMs(b);
      return bTime - aTime;
    });

    setThreadMessages(sortedThreads);

    const unreadForAllThreads = isAdminUser && !recipientRefOverride;
    if (recipientForQuery || unreadForAllThreads) {
      const unreadParams = new URLSearchParams();
      if (!unreadForAllThreads && recipientForQuery) {
        unreadParams.append('recipient', recipientForQuery);
        unreadParams.append('sender:not', recipientForQuery);
      } else if (profileRefStr) {
        // Admin global view: treat messages from others as unread candidates across all threads.
        unreadParams.append('sender:not', profileRefStr);
      }
      unreadParams.append('status:not', 'completed');
      unreadParams.append('part-of:missing', 'false');
      unreadParams.append('_count', '500');
      const unreadBundle = await medplum.search('Communication', unreadParams.toString(), { cache: 'no-cache' });
      const ids = new Set<string>();
      for (const entry of unreadBundle.entry ?? []) {
        const c = entry.resource as Communication | undefined;
        const partOf = c?.partOf?.[0]?.reference;
        if (partOf?.startsWith('Communication/')) {
          ids.add(partOf.replace('Communication/', ''));
        }
      }
      // Always include threads user explicitly marked as unread (e.g. provider sent all, no messages to "unread")
      if (!readOnlyMode) {
        for (const id of userMarkedUnreadRef.current) {
          ids.add(id);
        }
      }
      // In delegated read-only provider view, mirror provider inbox behavior:
      // opening a thread should remove unread styling for that open thread.
      if (readOnlyMode && recipientRefOverride && threadId) {
        ids.delete(threadId);
      }
      setUnreadThreadIds(ids);
    }
  }, [medplum, query, recipientRefOverride, readOnlyMode, threadId]);

  useEffect(() => {
    setLoading(true);
    fetchAllCommunications()
      .catch((err: Error) => {
        setError(err);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [fetchAllCommunications]);

  // When user OPENS a thread (navigates to it), remove from userMarkedUnreadThreadIds so it will
  // become read when they view. Do NOT remove when leaving - thread stays unread until reopened.
  const prevThreadIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const shouldHandleOpenAsRead = !readOnlyMode || !!recipientRefOverride;
    if (!shouldHandleOpenAsRead) {
      return;
    }
    const prevId = prevThreadIdRef.current;
    prevThreadIdRef.current = threadId;
    if (threadId && prevId !== threadId) {
      // User is opening this thread - remove so it will become read when they view
      if (!readOnlyMode) {
        setUserMarkedUnreadThreadIds((prev) => {
          const next = new Set(prev);
          next.delete(threadId);
          return next;
        });
      }
      // Optimistic: immediately show as read in list (don't wait for API)
      setUnreadThreadIds((prev) => {
        const next = new Set(prev);
        next.delete(threadId);
        return next;
      });
    }
  }, [threadId, readOnlyMode, recipientRefOverride]);

  useEffect(() => {
    const fetchThread = async (): Promise<void> => {
      if (threadId) {
        const thread = threadMessages.find((t) => t[0].id === threadId);
        if (thread) {
          setSelectedThread(thread[0]);
        } else {
          try {
            const communication: Communication = await medplum.readResource('Communication', threadId);

            if (communication.partOf === undefined) {
              setSelectedThread(communication);
            } else {
              const parentRef = communication.partOf[0].reference;
              if (parentRef) {
                const parent = await medplum.readReference({ reference: parentRef } as any);
                setSelectedThread(parent as Communication);
              }
            }
          } catch (err) {
            setError(err as Error);
          }
        }
      } else {
        setSelectedThread(undefined);
      }
    };

    fetchThread().catch((err) => {
      setError(err as Error);
    });
  }, [threadId, threadMessages, medplum]);

  const handleThreadStatusChange = async (newStatus: Communication['status']): Promise<void> => {
    if (!selectedThread) {
      return;
    }
    try {
      const updatedThread = await medplum.updateResource({
        ...selectedThread,
        status: newStatus,
      });

      setSelectedThread(updatedThread);
      setThreadMessages((prev) =>
        prev.map(([parent, lastMsg]) => (parent.id === updatedThread.id ? [updatedThread, lastMsg] : [parent, lastMsg]))
      );
    } catch (err) {
      setError(err as Error);
    }
  };

  const addThreadMessage = async (message: Communication): Promise<void> => {
    await fetchAllCommunications();
    setThreadMessages((prev) => [[message, undefined], ...prev]);
  };

  const handleMarkThreadAsRead = async (): Promise<void> => {
    if (!selectedThread?.id) return;
    const profile = medplum.getProfile();
    const profileRefStr = profile ? getReferenceString(profile) : undefined;
    if (!profileRefStr) return;
    const searchParams = new URLSearchParams();
    searchParams.append('part-of', `Communication/${selectedThread.id}`);
    searchParams.append('recipient', profileRefStr);
    searchParams.append('status:not', 'completed');
    const bundle = await medplum.search('Communication', searchParams.toString(), { cache: 'no-cache' });
    const unread = (bundle.entry ?? [])
      .map((e) => e.resource as Communication)
      .filter((c): c is Communication => !!c?.id);
    const now = new Date().toISOString();
    await Promise.all(
      unread.map((c) =>
        medplum.updateResource({
          ...c,
          received: c.received ?? now,
          status: 'completed',
        })
      )
    );
    setUserMarkedUnreadThreadIds((prev) => {
      const next = new Set(prev);
      next.delete(selectedThread.id!);
      return next;
    });
    await fetchAllCommunications();
  };

  const handleMarkThreadAsUnread = async (): Promise<void> => {
    if (!selectedThread?.id) return;
    const profile = medplum.getProfile();
    const profileRefStr = profile ? getReferenceString(profile) : undefined;
    if (!profileRefStr) return;
    // Optimistic update: show unread styling immediately
    const threadIdToMark = selectedThread.id!;
    setUnreadThreadIds((prev) => new Set(prev).add(threadIdToMark));
    setUserMarkedUnreadThreadIds((prev) => {
      const next = new Set(prev).add(threadIdToMark);
      userMarkedUnreadRef.current = next; // Update ref immediately so fetchAllCommunications sees it
      return next;
    });
    const searchParams = new URLSearchParams();
    searchParams.append('part-of', `Communication/${selectedThread.id}`);
    searchParams.append('recipient', profileRefStr);
    searchParams.append('status', 'completed');
    const bundle = await medplum.search('Communication', searchParams.toString(), { cache: 'no-cache' });
    const read = (bundle.entry ?? [])
      .map((e) => e.resource as Communication)
      .filter((c): c is Communication => !!c?.id);
    await Promise.all(
      read.map((c) =>
        medplum.updateResource({
          ...c,
          status: 'in-progress',
        })
      )
    );
    await fetchAllCommunications();
  };

  return {
    loading,
    error,
    threadMessages,
    selectedThread,
    total,
    unreadThreadIds,
    userMarkedUnreadThreadIds,
    addThreadMessage,
    handleThreadStatusChange,
    handleMarkThreadAsRead,
    handleMarkThreadAsUnread,
    refreshThreadMessages: fetchAllCommunications,
  };
}

function getThreadSortTimeMs([parent, lastMessage]: [Communication, Communication | undefined]): number {
  const candidates = [
    lastMessage?.sent,
    lastMessage?.meta?.lastUpdated,
    parent.meta?.lastUpdated,
    parent.sent,
  ];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const ms = new Date(candidate).getTime();
    if (!Number.isNaN(ms)) {
      return ms;
    }
  }
  return 0;
}

function isAdminProfile(
  profile: { email?: string; username?: string; telecom?: { system?: string; value?: string }[] } | undefined
): boolean {
  if (!profile) {
    return false;
  }
  const directEmail = profile.email ?? profile.username;
  if (directEmail?.toLowerCase() === 'admin@example.com') {
    return true;
  }
  const practitionerEmail = profile.telecom?.find((t) => t.system === 'email')?.value;
  return practitionerEmail?.toLowerCase() === 'admin@example.com';
}
