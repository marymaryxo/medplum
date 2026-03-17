// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { ActionIcon, Box, Group, Modal, ScrollArea, Stack, Table, Tabs, Text, TextInput, UnstyledButton } from '@mantine/core';
import type { Attachment, Communication } from '@medplum/fhirtypes';
import { useCachedBinaryUrl, useMedplum } from '@medplum/react';
import { useMediaQuery } from '@mantine/hooks';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { IconChevronDown, IconChevronUp, IconDownload, IconFileText, IconPhoto, IconSearch } from '@tabler/icons-react';

const FILENAME_TRUNCATE_LENGTH = 35;
const CELL_ALIGN_STYLE = { verticalAlign: 'middle' as const };

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
  if (Number.isNaN(d.getTime())) {
    return 'Unknown date';
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

type FileCategory = 'all' | 'images' | 'documents';
type DateSortOrder = 'desc' | 'asc';

interface AttachmentWithMeta {
  id: string;
  attachment: Attachment;
  sent: string;
  senderRef?: string;
  senderDisplay?: string;
}

function isImageAttachment(attachment: Attachment): boolean {
  return attachment.contentType?.toLowerCase().startsWith('image/') ?? false;
}

function getDownloadUrl(rawUrl: string | undefined, baseUrl: string): string | undefined {
  if (!rawUrl) {
    return undefined;
  }
  if (rawUrl.startsWith('http')) {
    return rawUrl;
  }
  return `${baseUrl}fhir/R4/${rawUrl.replace(/^\//, '')}`;
}

function getSenderName(item: AttachmentWithMeta): string {
  if (item.senderDisplay?.trim()) {
    return item.senderDisplay.trim();
  }
  if (item.senderRef) {
    return item.senderRef.split('/').pop() ?? item.senderRef;
  }
  return 'Unknown';
}

function FileTypeIcon(props: { attachment: Attachment }): JSX.Element {
  const { attachment } = props;
  return isImageAttachment(attachment) ? <IconPhoto size={16} /> : <IconFileText size={16} />;
}

function FileRow(props: { item: AttachmentWithMeta; medplumBaseUrl: string }): JSX.Element {
  const { item } = props;
  const resolvedUrl = useCachedBinaryUrl(item.attachment.url);
  const href = getDownloadUrl(resolvedUrl ?? item.attachment.url, props.medplumBaseUrl);
  const displayName = getAttachmentDisplayName(item.attachment);
  const truncated = truncateFilename(displayName, FILENAME_TRUNCATE_LENGTH);
  const senderName = getSenderName(item);

  return (
    <Table.Tr>
      <Table.Td style={{ ...CELL_ALIGN_STYLE, width: 44, textAlign: 'center' }}>
        <Group justify="center" wrap="nowrap">
          <FileTypeIcon attachment={item.attachment} />
        </Group>
      </Table.Td>
      <Table.Td style={CELL_ALIGN_STYLE}>
        <Text size="sm" truncate="end" title={displayName}>
          {truncated}
        </Text>
      </Table.Td>
      <Table.Td style={{ ...CELL_ALIGN_STYLE, width: 140 }}>
        <Text size="sm">{formatDate(item.sent)}</Text>
      </Table.Td>
      <Table.Td style={{ ...CELL_ALIGN_STYLE, width: 180 }}>
        <Text size="sm" truncate="end">
          {senderName}
        </Text>
      </Table.Td>
      <Table.Td style={{ ...CELL_ALIGN_STYLE, width: 60, textAlign: 'center' }}>
        <Group justify="center" wrap="nowrap">
          <ActionIcon
            component="a"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            variant="subtle"
            aria-label={href ? `Download ${displayName}` : `No download available for ${displayName}`}
            disabled={!href}
          >
            <IconDownload size={16} />
          </ActionIcon>
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

function MobileFileRow(props: { item: AttachmentWithMeta; medplumBaseUrl: string }): JSX.Element {
  const { item } = props;
  const resolvedUrl = useCachedBinaryUrl(item.attachment.url);
  const href = getDownloadUrl(resolvedUrl ?? item.attachment.url, props.medplumBaseUrl);
  const displayName = getAttachmentDisplayName(item.attachment);
  const senderName = getSenderName(item);

  return (
    <Box
      style={{
        border: '1px solid var(--mantine-color-gray-3)',
        borderRadius: 8,
        padding: 10,
      }}
    >
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
          <FileTypeIcon attachment={item.attachment} />
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Text size="sm" fw={500} truncate="end" title={displayName}>
              {displayName}
            </Text>
            <Text size="xs" c="dimmed">
              Shared on {formatDate(item.sent)}
            </Text>
            <Text size="xs" c="dimmed" truncate="end">
              Sent by {senderName}
            </Text>
          </Stack>
        </Group>
        <ActionIcon
          component="a"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          variant="subtle"
          aria-label={href ? `Download ${displayName}` : `No download available for ${displayName}`}
          disabled={!href}
        >
          <IconDownload size={16} />
        </ActionIcon>
      </Group>
    </Box>
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
  const isMobile = useMediaQuery('(max-width: 768px)');
  const [items, setItems] = useState<AttachmentWithMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [fileTypeFilter, setFileTypeFilter] = useState<FileCategory>('all');
  const [dateSortOrder, setDateSortOrder] = useState<DateSortOrder>('desc');

  const fetchAllCommunications = useCallback(
    async (params: Record<string, string>): Promise<Communication[]> => {
      const count = 500;
      let offset = 0;
      const results: Communication[] = [];
      while (true) {
        const query = new URLSearchParams({ ...params, _count: String(count), _offset: String(offset) });
        const bundle = await medplum.search('Communication', query.toString(), { cache: 'no-cache' });
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
    },
    [medplum]
  );

  const fetchAttachments = useCallback(async (): Promise<void> => {
    if (!thread?.id) return;
    setLoading(true);
    try {
      const subjectRef = thread.subject?.reference;
      const parentThreads = subjectRef
        ? await fetchAllCommunications({
            'part-of:missing': 'true',
            subject: subjectRef,
          })
        : [thread];
      const threadIds = parentThreads.map((t) => t.id).filter((id): id is string => !!id);
      const childBatches = await Promise.all(
        threadIds.map((id) =>
          fetchAllCommunications({
            'part-of': `Communication/${id}`,
          })
        )
      );
      const comms = childBatches.flat();
      const all: AttachmentWithMeta[] = [];
      for (const c of comms) {
        const atts = extractAttachmentsFromPayload(c.payload);
        const senderRef = c.sender?.reference;
        const senderDisplay = c.sender?.display;
        const sent = c.sent ?? '';
        for (const att of atts) {
          all.push({
            id: `${c.id ?? 'unknown'}:${att.url ?? att.title ?? sent}:${all.length}`,
            attachment: att,
            sent,
            senderRef,
            senderDisplay,
          });
        }
      }
      all.sort((a, b) => b.sent.localeCompare(a.sent));
      setItems(all);
    } catch (err) {
      console.error(err);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [fetchAllCommunications, thread]);

  useEffect(() => {
    if (opened && thread?.id) {
      setSearchTerm('');
      setFileTypeFilter('all');
      setDateSortOrder('desc');
      void fetchAttachments();
    }
  }, [opened, thread?.id, fetchAttachments]);

  const filteredItems = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();
    return items.filter((item) => {
      const name = getAttachmentDisplayName(item.attachment).toLowerCase();
      if (normalizedSearch && !name.includes(normalizedSearch)) {
        return false;
      }
      if (fileTypeFilter === 'images' && !isImageAttachment(item.attachment)) {
        return false;
      }
      if (fileTypeFilter === 'documents' && isImageAttachment(item.attachment)) {
        return false;
      }
      return true;
    });
  }, [fileTypeFilter, items, searchTerm]);

  const counts = useMemo(() => {
    let images = 0;
    let documents = 0;
    for (const item of items) {
      if (isImageAttachment(item.attachment)) {
        images++;
      } else {
        documents++;
      }
    }
    return { all: items.length, images, documents };
  }, [items]);

  const sortedItems = useMemo(() => {
    const result = [...filteredItems];
    result.sort((a, b) => {
      const aMs = new Date(a.sent).getTime();
      const bMs = new Date(b.sent).getTime();
      const safeA = Number.isNaN(aMs) ? 0 : aMs;
      const safeB = Number.isNaN(bMs) ? 0 : bMs;
      return dateSortOrder === 'desc' ? safeB - safeA : safeA - safeB;
    });
    return result;
  }, [dateSortOrder, filteredItems]);

  return (
    <Modal opened={opened} onClose={onClose} title="Shared files" size={isMobile ? '100%' : 'xl'} fullScreen={isMobile}>
      {loading ? (
        <Text size="sm" c="dimmed">
          Loading...
        </Text>
      ) : (
        <Stack gap="sm">
          <TextInput
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.currentTarget.value)}
            placeholder="Search files by filename"
            leftSection={<IconSearch size={16} />}
          />
          <Tabs value={fileTypeFilter} onChange={(value) => setFileTypeFilter((value as FileCategory) ?? 'all')}>
            <Tabs.List>
              <Tabs.Tab value="all">All ({counts.all})</Tabs.Tab>
              <Tabs.Tab value="images">Images ({counts.images})</Tabs.Tab>
              <Tabs.Tab value="documents">Documents ({counts.documents})</Tabs.Tab>
            </Tabs.List>
          </Tabs>
          {filteredItems.length === 0 ? (
            <Text size="sm" c="dimmed">
              No shared files found
            </Text>
          ) : (
            <>
              <ScrollArea h={isMobile ? 360 : 420}>
                {isMobile ? (
                  <Stack gap="xs">
                    <Group justify="space-between" align="center" mb={4}>
                      <Text size="sm" fw={600}>
                        Files
                      </Text>
                      <UnstyledButton
                        onClick={() => setDateSortOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'))}
                        aria-label={`Sort shared files by date ${dateSortOrder === 'desc' ? 'oldest first' : 'newest first'}`}
                      >
                        <Group gap={4} wrap="nowrap">
                          <Text size="sm" fw={600}>
                            Shared on
                          </Text>
                          {dateSortOrder === 'desc' ? <IconChevronDown size={14} /> : <IconChevronUp size={14} />}
                        </Group>
                      </UnstyledButton>
                    </Group>
                    {sortedItems.map((item) => (
                      <MobileFileRow key={item.id} item={item} medplumBaseUrl={medplum.getBaseUrl()} />
                    ))}
                  </Stack>
                ) : (
                  <Table striped highlightOnHover withTableBorder style={{ tableLayout: 'fixed' }}>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th style={{ ...CELL_ALIGN_STYLE, width: 44, textAlign: 'center' }}>Type</Table.Th>
                        <Table.Th style={CELL_ALIGN_STYLE}>Filename</Table.Th>
                        <Table.Th style={{ ...CELL_ALIGN_STYLE, width: 140 }}>
                          <UnstyledButton
                            onClick={() => setDateSortOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'))}
                            aria-label={`Sort shared files by date ${dateSortOrder === 'desc' ? 'oldest first' : 'newest first'}`}
                          >
                            <Group gap={4} wrap="nowrap">
                              <Text size="sm" fw={600}>
                                Shared on
                              </Text>
                              {dateSortOrder === 'desc' ? <IconChevronDown size={14} /> : <IconChevronUp size={14} />}
                            </Group>
                          </UnstyledButton>
                        </Table.Th>
                        <Table.Th style={{ ...CELL_ALIGN_STYLE, width: 180 }}>Sent By</Table.Th>
                        <Table.Th style={{ ...CELL_ALIGN_STYLE, width: 60 }} />
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {sortedItems.map((item) => (
                        <FileRow key={item.id} item={item} medplumBaseUrl={medplum.getBaseUrl()} />
                      ))}
                    </Table.Tbody>
                  </Table>
                )}
              </ScrollArea>
              <Group justify="space-between">
                <Text size="xs" c="dimmed">
                  Showing {sortedItems.length} of {items.length} files
                </Text>
              </Group>
            </>
          )}
        </Stack>
      )}
    </Modal>
  );
}
