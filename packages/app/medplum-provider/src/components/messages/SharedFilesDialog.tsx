// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Anchor, Divider, Group, Modal, ScrollArea, Stack, Text } from '@mantine/core';
import type { Attachment, Communication } from '@medplum/fhirtypes';
import { useCachedBinaryUrl, useMedplum, useResource } from '@medplum/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { getDisplayString } from '@medplum/core';

const FILENAME_TRUNCATE_LENGTH = 35;

/** Extract file attachments from payload; excludes text/html contentAttachment (message body) */
function extractAttachmentsFromPayload(payload: Communication['payload']): Attachment[] {
  const items = payload ?? [];
  const result: Attachment[] = [];
  for (const p of items) {
    if (!p || typeof p !== 'object') continue;
    const raw = (p as { contentAttachment?: Attachment & { reference?: string } | string }).contentAttachment;
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'string') {
      result.push({ url: raw, title: 'Attachment' });
      continue;
    }
    if (typeof raw !== 'object') continue;
    if (raw.contentType?.toLowerCase() === 'text/html') continue;
    const url = raw.url ?? (raw as Attachment & { reference?: string }).reference;
    const normalized: Attachment = url ? { ...raw, url } : raw;
    result.push(normalized);
  }
  return result;
}

function getAttachmentDisplayName(attachment: Attachment): string {
  if (attachment.title?.trim()) return attachment.title.trim();
  if (attachment.url) {
    const match = attachment.url.match(/\/([^/?#]+)(?:[?#]|$)/);
    if (match?.[1]) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }
  }
  if (attachment.contentType) {
    const subtype = attachment.contentType.split('/')[1];
    if (subtype) return `Attachment (.${subtype})`;
  }
  return 'Attachment';
}

function truncateFilename(name: string, maxLen: number): string {
  if (name.length <= maxLen) return name;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  const base = name.slice(0, name.length - ext.length);
  const keep = maxLen - ext.length - 3;
  return keep > 0 ? `${base.slice(0, keep)}...${ext}` : name.slice(0, maxLen);
}

function formatDate(sent: string): string {
  const d = new Date(sent);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(sent: string): string {
  const d = new Date(sent);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

interface AttachmentWithMeta {
  attachment: Attachment;
  sent: string;
  senderRef: string;
}

function FileRow(props: { item: AttachmentWithMeta }): JSX.Element {
  const { item } = props;
  const resolvedUrl = useCachedBinaryUrl(item.attachment.url);
  const medplum = useMedplum();
  const rawUrl = resolvedUrl ?? item.attachment.url;
  const href = rawUrl
    ? rawUrl.startsWith('http')
      ? rawUrl
      : `${medplum.getBaseUrl()}fhir/R4/${rawUrl.replace(/^\//, '')}`
    : undefined;
  const displayName = getAttachmentDisplayName(item.attachment);
  const truncated = truncateFilename(displayName, FILENAME_TRUNCATE_LENGTH);
  const senderResource = useResource(item.senderRef ? { reference: item.senderRef } : undefined);
  const senderName = senderResource ? getDisplayString(senderResource) : item.senderRef?.split('/')[1] ?? 'Unknown';

  if (!href) {
    return (
      <Group gap="sm" wrap="nowrap">
        <Text size="sm" truncate maw={180} title={displayName}>
          {truncated}
        </Text>
        <Text size="xs" c="dimmed">
          {senderName} · {formatTime(item.sent)}
        </Text>
      </Group>
    );
  }

  return (
    <Group gap="sm" wrap="nowrap">
      <Anchor
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        size="sm"
        fw={500}
        c="blue"
        underline="always"
        style={{ textUnderlineOffset: 2 }}
        truncate
        maw={180}
        title={displayName}
      >
        {truncated}
      </Anchor>
      <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
        {senderName} · {formatTime(item.sent)}
      </Text>
    </Group>
  );
}

interface SharedFilesDialogProps {
  thread: Communication | undefined;
  opened: boolean;
  onClose: () => void;
}

export function SharedFilesDialog(props: SharedFilesDialogProps): JSX.Element {
  const { thread, opened, onClose } = props;
  const medplum = useMedplum();
  const [items, setItems] = useState<AttachmentWithMeta[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchAttachments = useCallback(async (): Promise<void> => {
    if (!thread?.id) return;
    setLoading(true);
    try {
      const bundle = await medplum.search(
        'Communication',
        `part-of=Communication/${thread.id}`,
        { cache: 'no-cache' }
      );
      const comms = (bundle.entry ?? [])
        .map((e) => e.resource as Communication)
        .filter((c): c is Communication => !!c?.id);
      const all: AttachmentWithMeta[] = [];
      for (const c of comms) {
        const atts = extractAttachmentsFromPayload(c.payload);
        const senderRef = c.sender?.reference ?? '';
        const sent = c.sent ?? '';
        for (const att of atts) {
          all.push({ attachment: att, sent, senderRef });
        }
      }
      all.sort((a, b) => b.sent.localeCompare(a.sent));
      setItems(all);
    } finally {
      setLoading(false);
    }
  }, [medplum, thread?.id]);

  useEffect(() => {
    if (opened && thread?.id) {
      void fetchAttachments();
    }
  }, [opened, thread?.id, fetchAttachments]);

  const byDate = useMemo(() => {
    const map = new Map<string, AttachmentWithMeta[]>();
    for (const item of items) {
      const dateKey = formatDate(item.sent);
      const list = map.get(dateKey) ?? [];
      list.push(item);
      map.set(dateKey, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.sent.localeCompare(b.sent));
    }
    return Array.from(map.entries()).sort(([, listA], [, listB]) => {
      const sentA = listA[listA.length - 1]?.sent ?? '';
      const sentB = listB[listB.length - 1]?.sent ?? '';
      return sentB.localeCompare(sentA);
    });
  }, [items]);

  return (
    <Modal opened={opened} onClose={onClose} title="Shared files" size="md">
      {loading ? (
        <Text size="sm" c="dimmed">
          Loading...
        </Text>
      ) : items.length === 0 ? (
        <Text size="sm" c="dimmed">
          No shared files in this thread
        </Text>
      ) : (
        <ScrollArea h={400}>
          <Stack gap="md">
            {byDate.map(([dateStr, dateItems]) => (
              <Stack key={dateStr} gap="xs">
                <Text fw={600} size="sm" c="dimmed">
                  {dateStr}
                </Text>
                <Stack gap={4} pl="sm">
                  {dateItems.map((item, i) => (
                    <FileRow key={i} item={item} />
                  ))}
                </Stack>
                <Divider />
              </Stack>
            ))}
          </Stack>
        </ScrollArea>
      )}
    </Modal>
  );
}
