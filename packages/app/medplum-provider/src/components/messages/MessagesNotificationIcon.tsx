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

      const unreadCriteria = `recipient=${profileRefStr}&sender:not=${profileRefStr}&part-of:missing=false&_count=500`;
      const unreadBundle = await medplum.search('Communication', unreadCriteria, { cache });
      const unreadParentIds = new Set<string>();
      for (const entry of unreadBundle.entry ?? []) {
        const msg = entry.resource as Communication | undefined;
        if (!msg || msg.received) {
          continue;
        }
        const parentRef = msg?.partOf?.[0]?.reference;
        if (parentRef?.startsWith('Communication/')) {
          unreadParentIds.add(parentRef.replace('Communication/', ''));
        }
      }

      const localUnreadIds = loadUserMarkedUnreadThreadIds(profileRefStr);
      const candidateIds = new Set<string>([...unreadParentIds, ...localUnreadIds]);
      if (candidateIds.size === 0) {
        setUnreadThreadCount(0);
        return;
      }

      const parentThreads = await medplum.searchResources('Communication', {
        _id: [...candidateIds].join(','),
        'part-of:missing': 'true',
        status: 'in-progress',
        _count: String(Math.max(candidateIds.size, 20)),
      });

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
        if (unreadParentIds.has(parent.id) || localUnreadIds.has(parent.id)) {
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
