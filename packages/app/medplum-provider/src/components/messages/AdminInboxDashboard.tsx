// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { Alert, Loader, Paper, ScrollArea, Table, Text, Title } from '@mantine/core';
import { getDisplayString, getReferenceString } from '@medplum/core';
import type { Communication, Practitioner } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';

const USER_MARKED_UNREAD_STORAGE_KEY = 'medplum-provider-userMarkedUnreadThreadIds';
const OPENED_REASSIGNED_THREAD_MARKERS_STORAGE_KEY = 'medplum-provider-openedReassignedThreadMarkers';

interface AdminInboxDashboardProps {
  onSelectProvider: (providerRef: string) => void;
}

interface ProviderRow {
  providerRef: string;
  providerName: string;
  totalActiveThreads: number;
  unreadThreadCount: number;
  oldestUnreadSent?: string;
}

export function AdminInboxDashboard(props: AdminInboxDashboardProps): JSX.Element {
  const { onSelectProvider } = props;
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const adminProfileRef = normalizeRef(getReferenceString(profile as Practitioner));
  const [rows, setRows] = useState<ProviderRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let isMounted = true;
    const load = async (): Promise<void> => {
      try {
        setLoading(true);
        setError(undefined);

        const inboxThreads = await searchAllCommunications(medplum, {
          'part-of:missing': 'true',
          status: 'in-progress',
          // Keep this aligned with useThreadInbox inbox eligibility.
          'identifier:not': 'ai-message-topic',
          '_has:Communication:part-of:_id:not': 'null',
        });
        const unreadMessages = await searchAllCommunications(medplum, {
          'part-of:missing': 'false',
          'received:missing': 'true',
        });

        const activeByProvider = new Map<string, number>();
        const activeThreadIdsByProvider = new Map<string, Set<string>>();
        const unreadThreadIdsByProvider = new Map<string, Set<string>>();
        const oldestUnreadByProvider = new Map<string, string>();
        const threadTimestampById = new Map<string, string>();

        for (const thread of inboxThreads) {
          const threadId = thread.id;
          if (!threadId) {
            continue;
          }
          const threadTimestamp = thread.meta?.lastUpdated ?? thread.sent;
          if (threadTimestamp) {
            threadTimestampById.set(threadId, threadTimestamp);
          }
          const recipientRefs = getRecipientRefs(thread);
          for (const providerRef of recipientRefs) {
            activeByProvider.set(providerRef, (activeByProvider.get(providerRef) ?? 0) + 1);
            const activeThreadIds = activeThreadIdsByProvider.get(providerRef) ?? new Set<string>();
            activeThreadIds.add(threadId);
            activeThreadIdsByProvider.set(providerRef, activeThreadIds);
          }

          // Mirror provider inbox: reassigned-to-you threads are unread until opened once by that provider.
          const isReassignedToYou = !!thread.identifier?.some(
            (id) => id.system === 'https://medplum.com/thread-state' && id.value === 'reassigned-to-you'
          );
          if (isReassignedToYou && thread.status === 'in-progress') {
            const reassignedMarker = getReassignmentOpenMarker(thread);
            const reassignedAt = thread.identifier?.find(
              (id) => id.system === 'https://medplum.com/thread-state/reassigned-at'
            )?.value;
            for (const providerRef of recipientRefs) {
              const openedMarkers = loadOpenedReassignedFromStorage(providerRef);
              if (openedMarkers.has(reassignedMarker)) {
                continue;
              }
              const setForProvider = unreadThreadIdsByProvider.get(providerRef) ?? new Set<string>();
              setForProvider.add(threadId);
              unreadThreadIdsByProvider.set(providerRef, setForProvider);
              setOldestTimestamp(oldestUnreadByProvider, providerRef, reassignedAt ?? threadTimestampById.get(threadId));
            }
          }
        }

        for (const message of unreadMessages) {
          const recipientRefs = getRecipientRefs(message);
          if (recipientRefs.size === 0) {
            continue;
          }
          const senderRef = normalizeRef(message.sender?.reference);
          const parentThreadId = getReferenceId(message.partOf?.[0]?.reference);
          if (!parentThreadId) {
            continue;
          }

          for (const recipientRef of recipientRefs) {
            if (senderRef && senderRef === recipientRef) {
              continue;
            }
            const activeThreadIds = activeThreadIdsByProvider.get(recipientRef);
            if (!activeThreadIds || !activeThreadIds.has(parentThreadId)) {
              continue;
            }
            const setForProvider = unreadThreadIdsByProvider.get(recipientRef) ?? new Set<string>();
            setForProvider.add(parentThreadId);
            unreadThreadIdsByProvider.set(recipientRef, setForProvider);
            setOldestTimestamp(oldestUnreadByProvider, recipientRef, message.sent);
          }
        }

        // Mirror provider inbox: explicit "Mark as unread" threads are unread even without unread child messages.
        for (const [providerRef, activeThreadIds] of activeThreadIdsByProvider) {
          const userMarkedUnreadThreadIds = loadUserMarkedUnreadFromStorage(providerRef);
          for (const threadId of userMarkedUnreadThreadIds) {
            if (!activeThreadIds.has(threadId)) {
              continue;
            }
            const setForProvider = unreadThreadIdsByProvider.get(providerRef) ?? new Set<string>();
            setForProvider.add(threadId);
            unreadThreadIdsByProvider.set(providerRef, setForProvider);
            setOldestTimestamp(oldestUnreadByProvider, providerRef, threadTimestampById.get(threadId));
          }
        }

        const providerRefs = new Set<string>([
          ...activeByProvider.keys(),
          ...unreadThreadIdsByProvider.keys(),
        ]);
        if (adminProfileRef) {
          providerRefs.add(adminProfileRef);
        }
        const providerNameMap = new Map<string, string>();
        const practitioners = await searchAllPractitioners(medplum);
        for (const practitioner of practitioners) {
          const practitionerRef = normalizeRef(getReferenceString(practitioner));
          if (!practitionerRef) {
            continue;
          }
          providerRefs.add(practitionerRef);
          providerNameMap.set(practitionerRef, getDisplayString(practitioner));
        }
        const unresolvedProviderRefs = new Set<string>([...providerRefs].filter((ref) => !providerNameMap.has(ref)));
        if (unresolvedProviderRefs.size > 0) {
          const loadedProviderNames = await loadProviderNames(medplum, unresolvedProviderRefs);
          for (const [ref, name] of loadedProviderNames) {
            providerNameMap.set(ref, name);
          }
        }
        const nextRows = [...providerRefs]
          .map((providerRef) => ({
            providerRef,
            providerName: resolveProviderName(providerRef, providerNameMap),
            totalActiveThreads: activeByProvider.get(providerRef) ?? 0,
            unreadThreadCount: unreadThreadIdsByProvider.get(providerRef)?.size ?? 0,
            oldestUnreadSent: oldestUnreadByProvider.get(providerRef),
          }))
          .sort((a, b) => a.providerName.localeCompare(b.providerName));

        if (isMounted) {
          setRows(nextRows);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Failed to load provider dashboard');
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };
    load().catch(console.error);
    return () => {
      isMounted = false;
    };
  }, [adminProfileRef, medplum]);

  const tableRows = useMemo(
    () =>
      rows.map((row) => (
        <Table.Tr
          key={row.providerRef}
          style={{ cursor: 'pointer' }}
          onClick={() => onSelectProvider(row.providerRef)}
          aria-label={`Open ${row.providerName} inbox`}
        >
          <Table.Td>
            <Text fw={600}>{row.providerName}</Text>
          </Table.Td>
          <Table.Td>{row.totalActiveThreads}</Table.Td>
          <Table.Td>{row.unreadThreadCount}</Table.Td>
          <Table.Td>
            {row.oldestUnreadSent ? (
              <Text size="sm">{formatRelativeAge(row.oldestUnreadSent)}</Text>
            ) : (
              'N/A'
            )}
          </Table.Td>
        </Table.Tr>
      )),
    [onSelectProvider, rows]
  );

  return (
    <Paper withBorder radius="md" p="md" m="md" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Title order={3} mb="xs">
        Provider Inbox Dashboard
      </Title>
      <Text size="sm" c="dimmed" mb="md">
        Click a provider row to open that provider&apos;s inbox in reassign-only mode.
      </Text>
      {loading ? (
        <Loader size="sm" />
      ) : error ? (
        <Alert color="red">{error}</Alert>
      ) : rows.length === 0 ? (
        <Text c="dimmed">No provider inbox data available.</Text>
      ) : (
        <ScrollArea type="hover" style={{ flex: 1 }}>
          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Provider</Table.Th>
                <Table.Th>Inbox Threads</Table.Th>
                <Table.Th>Unread Threads</Table.Th>
                <Table.Th>Oldest Unread</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>{tableRows}</Table.Tbody>
          </Table>
        </ScrollArea>
      )}
    </Paper>
  );
}

async function searchAllCommunications(
  medplum: ReturnType<typeof useMedplum>,
  params: Record<string, string>
): Promise<Communication[]> {
  const count = 500;
  let offset = 0;
  const results: Communication[] = [];

  while (true) {
    const pageParams = new URLSearchParams({
      ...params,
      _count: String(count),
      _offset: String(offset),
    });
    const bundle = await medplum.search('Communication', pageParams.toString(), { cache: 'no-cache' });
    const pageRows =
      bundle.entry
        ?.map((entry) => entry.resource as Communication | undefined)
        .filter((r): r is Communication => !!r) ?? [];
    results.push(...pageRows);

    if (pageRows.length === 0) {
      break;
    }
    offset += pageRows.length;
    if (bundle.total !== undefined && offset >= bundle.total) {
      break;
    }
    if (pageRows.length < count) {
      break;
    }
  }

  return results;
}

async function searchAllPractitioners(medplum: ReturnType<typeof useMedplum>): Promise<Practitioner[]> {
  const count = 200;
  let offset = 0;
  const results: Practitioner[] = [];

  while (true) {
    const params = new URLSearchParams({
      _count: String(count),
      _offset: String(offset),
      _sort: '-_lastUpdated',
    });
    const bundle = await medplum.search('Practitioner', params.toString(), { cache: 'no-cache' });
    const pageRows =
      bundle.entry
        ?.map((entry) => entry.resource as Practitioner | undefined)
        .filter((r): r is Practitioner => !!r) ?? [];
    results.push(...pageRows);
    if (pageRows.length === 0) {
      break;
    }
    offset += pageRows.length;
    if (bundle.total !== undefined && offset >= bundle.total) {
      break;
    }
    if (pageRows.length < count) {
      break;
    }
  }

  return results;
}

async function loadProviderNames(
  medplum: ReturnType<typeof useMedplum>,
  providerRefs: Set<string>
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const practitionerIds = [...providerRefs]
    .map((ref) => {
      const [resourceType, id] = ref.split('/');
      return resourceType === 'Practitioner' ? id : undefined;
    })
    .filter((id): id is string => !!id);
  if (practitionerIds.length === 0) {
    return result;
  }
  const practitioners = await medplum.searchResources('Practitioner', {
    _id: practitionerIds.join(','),
    _count: String(Math.max(practitionerIds.length, 20)),
  });
  for (const practitioner of practitioners) {
    const ref = normalizeRef(getReferenceString(practitioner));
    if (!ref) {
      continue;
    }
    result.set(ref, getDisplayString(practitioner));
  }
  return result;
}

function normalizeRef(ref: string | undefined): string | undefined {
  if (!ref) {
    return undefined;
  }
  const parts = ref.split('/').filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function getReferenceId(ref: string | undefined): string | undefined {
  if (!ref) {
    return undefined;
  }
  const parts = ref.split('/').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 1] : undefined;
}

function getRecipientRefs(resource: Communication): Set<string> {
  const refs = new Set<string>();
  for (const recipient of resource.recipient ?? []) {
    const normalized = normalizeRef(recipient.reference);
    if (normalized) {
      refs.add(normalized);
    }
  }
  return refs;
}

function getScopedStorageKey(baseKey: string, profileRefStr: string | undefined): string {
  return profileRefStr ? `${baseKey}:${profileRefStr}` : `${baseKey}:anonymous`;
}

function loadUserMarkedUnreadFromStorage(profileRefStr?: string): Set<string> {
  try {
    const stored = sessionStorage.getItem(getScopedStorageKey(USER_MARKED_UNREAD_STORAGE_KEY, profileRefStr));
    if (stored) {
      const arr = JSON.parse(stored) as string[];
      return new Set(Array.isArray(arr) ? arr : []);
    }
  } catch {
    // ignore parse/storage errors
  }
  return new Set();
}

function loadOpenedReassignedFromStorage(profileRefStr?: string): Set<string> {
  try {
    const stored = localStorage.getItem(
      getScopedStorageKey(OPENED_REASSIGNED_THREAD_MARKERS_STORAGE_KEY, profileRefStr)
    );
    if (stored) {
      const arr = JSON.parse(stored) as string[];
      return new Set(Array.isArray(arr) ? arr : []);
    }
  } catch {
    // ignore parse/storage errors
  }
  return new Set();
}

function getReassignmentOpenMarker(parent: Communication): string {
  const reassignedAt = parent.identifier?.find((id) => id.system === 'https://medplum.com/thread-state/reassigned-at')?.value;
  return reassignedAt ? `${parent.id}:${reassignedAt}` : (parent.id as string);
}

function setOldestTimestamp(byProvider: Map<string, string>, providerRef: string, candidate: string | undefined): void {
  if (!candidate) {
    return;
  }
  const candidateMs = new Date(candidate).getTime();
  if (Number.isNaN(candidateMs)) {
    return;
  }
  const current = byProvider.get(providerRef);
  if (!current) {
    byProvider.set(providerRef, candidate);
    return;
  }
  const currentMs = new Date(current).getTime();
  if (Number.isNaN(currentMs) || candidateMs < currentMs) {
    byProvider.set(providerRef, candidate);
  }
}

function formatRelativeAge(isoString: string): string {
  const date = new Date(isoString);
  const now = Date.now();
  const diffMs = now - date.getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) {
    return 'N/A';
  }
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ${minutes % 60}m`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function resolveProviderName(providerRef: string, providerNameMap: Map<string, string>): string {
  const resolved = providerNameMap.get(providerRef);
  if (resolved) {
    return resolved;
  }
  const id = providerRef.split('/').pop() ?? providerRef;
  if (looksLikeUuid(id)) {
    return generateProviderAlias(id);
  }
  return id;
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function generateProviderAlias(seed: string): string {
  const firstNames = ['Avery', 'Jordan', 'Casey', 'Taylor', 'Riley', 'Morgan', 'Jamie', 'Alex'];
  const lastNames = ['Johnson', 'Lee', 'Patel', 'Rivera', 'Nguyen', 'Smith', 'Brown', 'Garcia'];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 33 + seed.charCodeAt(i)) >>> 0;
  }
  const first = firstNames[hash % firstNames.length];
  const last = lastNames[(hash >>> 4) % lastNames.length];
  return `${first} ${last}`;
}
