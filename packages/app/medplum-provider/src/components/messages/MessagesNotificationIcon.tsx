// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { Indicator } from '@mantine/core';
import { getDisplayString, getReferenceString } from '@medplum/core';
import type { Communication } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { useSubscription } from '@medplum/react-hooks';
import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';

const USER_MARKED_UNREAD_STORAGE_KEY = 'medplum-provider-userMarkedUnreadThreadIds';
const OPENED_REASSIGNED_THREAD_MARKERS_STORAGE_KEY = 'medplum-provider-openedReassignedThreadMarkers';

interface MessagesNotificationIconProps {
  readonly iconComponent: JSX.Element;
}

export function MessagesNotificationIcon(props: MessagesNotificationIconProps): JSX.Element {
  const { iconComponent } = props;
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [unreadThreadCount, setUnreadThreadCount] = useState(0);
  const profileRefStr = profile ? getReferenceString(profile) : undefined;
  const profileDisplay = profile ? getDisplayString(profile) : undefined;

  const updateCount = useCallback(
    async (cache: 'default' | 'reload'): Promise<void> => {
      if (!profileRefStr) {
        setUnreadThreadCount(0);
        return;
      }

      const unreadBundle = await searchAllCommunications(
        medplum,
        {
          recipient: profileRefStr,
          'sender:not': profileRefStr,
          'part-of:missing': 'false',
        },
        cache
      );
      const unreadParentIds = new Set<string>();
      for (const msg of unreadBundle) {
        if (!msg || msg.received) {
          continue;
        }
        const parentRef = msg?.partOf?.[0]?.reference;
        if (parentRef?.startsWith('Communication/')) {
          unreadParentIds.add(parentRef.replace('Communication/', ''));
        }
      }

      const localUnreadIds = loadUserMarkedUnreadThreadIds(profileRefStr);
      const openedReassignedThreadMarkers = loadOpenedReassignedThreadMarkers(profileRefStr);

      const parentThreads = await searchAllCommunications(
        medplum,
        {
        'part-of:missing': 'true',
        status: 'in-progress',
          recipient: profileRefStr,
          'identifier:not': 'ai-message-topic',
          '_has:Communication:part-of:_id:not': 'null',
        },
        cache
      );

      let count = 0;
      for (const parent of parentThreads) {
        if (!parent.id) {
          continue;
        }
        const assignedToProfile = !!parent.recipient?.some(
          (r) =>
            referenceMatches(r.reference, profileRefStr) ||
            (profileDisplay ? normalizeName(r.display) === normalizeName(profileDisplay) : false)
        );
        if (!assignedToProfile) {
          continue;
        }
        if (
          unreadParentIds.has(parent.id) ||
          localUnreadIds.has(parent.id) ||
          isUnopenedReassignedArrivalThread(parent, profileRefStr, openedReassignedThreadMarkers)
        ) {
          count++;
        }
      }

      setUnreadThreadCount(count);
    },
    [medplum, profileDisplay, profileRefStr]
  );

  useEffect(() => {
    updateCount('default').catch(console.error);
  }, [updateCount]);

  const subscriptionCriteria = profileRefStr ? `Communication?recipient=${profileRefStr}&part-of:missing=false` : undefined;

  useSubscription(
    subscriptionCriteria,
    () => {
      updateCount('reload').catch(console.error);
    }
  );

  if (unreadThreadCount <= 0) {
    return iconComponent;
  }

  return (
    <Indicator
      inline
      label={unreadThreadCount > 99 ? '99+' : unreadThreadCount.toLocaleString()}
      size={16}
      offset={2}
      position="bottom-end"
      color="red"
    >
      {iconComponent}
    </Indicator>
  );
}

async function searchAllCommunications(
  medplum: ReturnType<typeof useMedplum>,
  params: Record<string, string>,
  cache: 'default' | 'reload'
): Promise<Communication[]> {
  const count = 500;
  let offset = 0;
  const results: Communication[] = [];
  while (true) {
    const query = new URLSearchParams({
      ...params,
      _count: String(count),
      _offset: String(offset),
    });
    const bundle = await medplum.search('Communication', query.toString(), { cache });
    const rows =
      bundle.entry
        ?.map((entry) => entry.resource as Communication | undefined)
        .filter((r): r is Communication => !!r) ?? [];
    results.push(...rows);
    if (rows.length === 0) {
      break;
    }
    offset += rows.length;
    if (bundle.total !== undefined && offset >= bundle.total) {
      break;
    }
    if (rows.length < count) {
      break;
    }
  }
  return results;
}

function getScopedStorageKey(baseKey: string, profileRefStr: string | undefined): string {
  return profileRefStr ? `${baseKey}:${profileRefStr}` : `${baseKey}:anonymous`;
}

function loadUserMarkedUnreadThreadIds(profileRefStr?: string): Set<string> {
  try {
    const stored = sessionStorage.getItem(getScopedStorageKey(USER_MARKED_UNREAD_STORAGE_KEY, profileRefStr));
    if (!stored) {
      return new Set<string>();
    }
    const parsed = JSON.parse(stored) as string[];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set<string>();
  }
}

function loadOpenedReassignedThreadMarkers(profileRefStr?: string): Set<string> {
  try {
    const stored = localStorage.getItem(
      getScopedStorageKey(OPENED_REASSIGNED_THREAD_MARKERS_STORAGE_KEY, profileRefStr)
    );
    if (!stored) {
      return new Set<string>();
    }
    const parsed = JSON.parse(stored) as string[];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set<string>();
  }
}

function isUnopenedReassignedArrivalThread(
  parent: Communication,
  effectiveProfileRefStr: string | undefined,
  openedReassignedThreadMarkers: Set<string>
): boolean {
  if (!parent.id || !effectiveProfileRefStr) {
    return false;
  }
  const marker = getReassignmentOpenMarker(parent);
  if (openedReassignedThreadMarkers.has(marker)) {
    return false;
  }
  const hasReassignedMarker = !!parent.identifier?.some(
    (id) => id.system === 'https://medplum.com/thread-state' && id.value === 'reassigned-to-you'
  );
  if (!hasReassignedMarker || parent.status !== 'in-progress') {
    return false;
  }
  return !!parent.recipient?.some((r) => referenceMatches(r.reference, effectiveProfileRefStr));
}

function getReassignmentOpenMarker(parent: Communication): string {
  const reassignedAt = parent.identifier?.find((id) => id.system === 'https://medplum.com/thread-state/reassigned-at')?.value;
  return reassignedAt ? `${parent.id}:${reassignedAt}` : (parent.id as string);
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

function normalizeName(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}
