// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { Alert, Loader, Paper, ScrollArea, Table, Text, Title } from '@mantine/core';
import { getDisplayString, getReferenceString } from '@medplum/core';
import type { Communication, Practitioner } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';

interface AdminInboxDashboardProps {
  onSelectProvider: (providerRef: string) => void;
}

interface ProviderRow {
  providerRef: string;
  providerName: string;
  totalActiveThreads: number;
  unansweredThreadCount: number;
  oldestUnansweredSent?: string;
}

export function AdminInboxDashboard(props: AdminInboxDashboardProps): JSX.Element {
  const { onSelectProvider } = props;
  const medplum = useMedplum();
  const [rows, setRows] = useState<ProviderRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let isMounted = true;
    const load = async (): Promise<void> => {
      try {
        setLoading(true);
        setError(undefined);

        const activeThreads = await medplum.searchResources('Communication', {
          'part-of:missing': 'true',
          status: 'in-progress',
          _count: '500',
        });
        const openMessages = await medplum.searchResources('Communication', {
          'part-of:missing': 'false',
          'status:not': 'completed',
          _count: '1000',
        });

        const activeByProvider = new Map<string, number>();
        const unansweredThreadIdsByProvider = new Map<string, Set<string>>();
        const oldestUnansweredByProvider = new Map<string, string>();

        for (const thread of activeThreads) {
          const providerRef = normalizeRef(thread.recipient?.[0]?.reference);
          if (!providerRef) {
            continue;
          }
          activeByProvider.set(providerRef, (activeByProvider.get(providerRef) ?? 0) + 1);
        }

        for (const message of openMessages) {
          const recipientRef = normalizeRef(message.recipient?.[0]?.reference);
          if (!recipientRef) {
            continue;
          }
          const senderRef = normalizeRef(message.sender?.reference);
          if (senderRef && senderRef === recipientRef) {
            continue;
          }
          const parentThreadRef = normalizeRef(message.partOf?.[0]?.reference);
          if (!parentThreadRef) {
            continue;
          }
          const setForProvider = unansweredThreadIdsByProvider.get(recipientRef) ?? new Set<string>();
          setForProvider.add(parentThreadRef);
          unansweredThreadIdsByProvider.set(recipientRef, setForProvider);
          const sent = message.sent;
          if (sent) {
            const currentOldest = oldestUnansweredByProvider.get(recipientRef);
            if (!currentOldest || new Date(sent).getTime() < new Date(currentOldest).getTime()) {
              oldestUnansweredByProvider.set(recipientRef, sent);
            }
          }
        }

        const providerRefs = new Set<string>([
          ...activeByProvider.keys(),
          ...unansweredThreadIdsByProvider.keys(),
        ]);
        const providerNameMap = await loadProviderNames(medplum, providerRefs);
        const nextRows = [...providerRefs]
          .map((providerRef) => ({
            providerRef,
            providerName: resolveProviderName(providerRef, providerNameMap),
            totalActiveThreads: activeByProvider.get(providerRef) ?? 0,
            unansweredThreadCount: unansweredThreadIdsByProvider.get(providerRef)?.size ?? 0,
            oldestUnansweredSent: oldestUnansweredByProvider.get(providerRef),
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
  }, [medplum]);

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
          <Table.Td>{row.unansweredThreadCount}</Table.Td>
          <Table.Td>
            {row.oldestUnansweredSent ? (
              <Text size="sm" c={isOlderThanHours(row.oldestUnansweredSent, 24) ? 'orange.8' : undefined} fw={isOlderThanHours(row.oldestUnansweredSent, 24) ? 600 : undefined}>
                {isOlderThanHours(row.oldestUnansweredSent, 24) ? '⚠ ' : ''}
                {formatRelativeAge(row.oldestUnansweredSent)}
              </Text>
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
        Click a provider row to open that provider&apos;s inbox in read-only mode.
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
                <Table.Th>Total Active Threads</Table.Th>
                <Table.Th>Unanswered Thread Count</Table.Th>
                <Table.Th>Oldest Unanswered</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>{tableRows}</Table.Tbody>
          </Table>
        </ScrollArea>
      )}
    </Paper>
  );
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

function isOlderThanHours(isoString: string, hours: number): boolean {
  const date = new Date(isoString);
  const diffMs = Date.now() - date.getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) {
    return false;
  }
  return diffMs >= hours * 60 * 60 * 1000;
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
