// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { PaperProps } from '@mantine/core';
import {
  ActionIcon,
  Box,
  Button,
  Group,
  Image,
  Loader,
  LoadingOverlay,
  Modal,
  Paper,
  ScrollArea,
  Skeleton,
  Stack,
  Text,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { RichTextEditor, Link as TiptapLink } from '@mantine/tiptap';
import { useEditor } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import Underline from '@tiptap/extension-underline';
import StarterKit from '@tiptap/starter-kit';
import { useResizeObserver } from '@mantine/hooks';
import { showNotification } from '@mantine/notifications';
import type { ProfileResource, WithId } from '@medplum/core';
import { getDisplayString, getReferenceString, normalizeErrorString } from '@medplum/core';
import type { Attachment, Bundle, Communication, Reference } from '@medplum/fhirtypes';
import { useCachedBinaryUrl, useMedplum, useResource, useSubscription } from '@medplum/react-hooks';
import { IconArrowRight, IconDownload, IconFile, IconFileText, IconFileTypePdf, IconPaperclip } from '@tabler/icons-react';
import type { JSX, LegacyRef, MouseEvent } from 'react';
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import cx from 'clsx';
import { Form } from '../../Form/Form';
import { ResourceAvatar } from '../../ResourceAvatar/ResourceAvatar';
import classes from './BaseChat.module.css';

function showError(message: string): void {
  showNotification({
    color: 'red',
    title: 'Error',
    message,
    autoClose: false,
  });
}

/** Compare references that may be short (Patient/123) or full URL - extracts ResourceType/id from each */
function referenceMatches(refStr: string | undefined, otherRefStr: string | undefined): boolean {
  if (!refStr || !otherRefStr) return false;
  const normalize = (s: string): string => {
    const parts = s.split('/').filter(Boolean);
    return parts.length >= 2 ? parts.slice(-2).join('/') : s;
  };
  return normalize(refStr) === normalize(otherRefStr);
}

/** Base64-encode UTF-8 string for FHIR Attachment.data (FHIR R4 compliant) */
function base64EncodeUtf8(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Escape string for safe use in HTML attribute */
function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** URL regexes for http(s) and www-prefixed domains */
const URL_REGEX = /(https?:\/\/[^\s<>"']+)/g;
const WWW_REGEX = /(^|[\s>])(www\.[^\s<>"']+)/g;

/** Split trailing punctuation from a matched URL so dots in domains are preserved. */
function splitTrailingPunctuation(url: string): { core: string; trailing: string } {
  const trimmed = url.match(/^(.*?)([.,;:!?)\]'"`]+)?$/);
  const core = trimmed?.[1] ?? url;
  const trailing = trimmed?.[2] ?? '';
  return { core, trailing };
}

/** Convert bare URLs in text to clickable links. Used for both plain text and HTML. */
function convertUrlsToLinks(text: string): string {
  if (!text) return '';
  let out = text;
  out = out.replace(URL_REGEX, (url) => {
    const { core, trailing } = splitTrailingPunctuation(url);
    return `<a href="${escapeHtmlAttr(core)}" target="_blank" rel="noopener noreferrer">${escapeHtmlAttr(core)}</a>${escapeHtmlAttr(trailing)}`;
  });
  out = out.replace(WWW_REGEX, (_, before, url) => {
    const { core, trailing } = splitTrailingPunctuation(url);
    return `${before}<a href="${escapeHtmlAttr('https://' + core)}" target="_blank" rel="noopener noreferrer">${escapeHtmlAttr(core)}</a>${escapeHtmlAttr(trailing)}`;
  });
  return out;
}

/** Convert plain text with [text](url) and bare URLs to HTML with clickable links. Output is sanitized. */
function plainTextToHtmlWithLinks(text: string): string {
  if (!text) return '';
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  // [text](url) - only allow http/https URLs
  const withMarkdownLinks = escaped.replace(
    /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
    (_, linkText, url) =>
      `<a href="${escapeHtmlAttr(url)}" target="_blank" rel="noopener noreferrer">${linkText || url}</a>`
  );
  // Bare URLs - only in text parts, not inside existing tags
  const parts = withMarkdownLinks.split(/(<[^>]+>)/);
  const withBareUrls = parts
    .map((part) => {
      if (part.startsWith('<')) return part;
      return convertUrlsToLinks(part);
    })
    .join('');
  return DOMPurify.sanitize(withBareUrls, {
    ADD_ATTR: ['target', 'rel'],
    ALLOWED_URI_REGEXP: /^(https?|mailto):/i,
  });
}

/** Convert bare URLs in HTML content to clickable links (without breaking existing tags). */
function htmlWithUrlsToLinks(html: string): string {
  if (!html) return '';
  const parts = html.split(/(<[^>]+>)/);
  const withLinks = parts
    .map((part) => {
      if (part.startsWith('<')) return part;
      return convertUrlsToLinks(part);
    })
    .join('');
  return DOMPurify.sanitize(withLinks, {
    ADD_ATTR: ['target', 'rel'],
    ALLOWED_URI_REGEXP: /^(https?|mailto):/i,
  });
}

function parseSentTime(communication: Communication): string {
  return new Date(communication.sent ?? 0).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function upsertCommunications(
  communications: Communication[],
  received: Communication[],
  setCommunications: (communications: Communication[]) => void
): void {
  const newCommunications = [...communications];
  let foundNew = false;
  for (const comm of received) {
    const existingIdx = newCommunications.findIndex((c) => c.id === comm.id);
    if (existingIdx !== -1) {
      newCommunications[existingIdx] = comm;
    } else {
      newCommunications.push(comm);
      foundNew = true;
    }
  }

  if (foundNew) {
    newCommunications.sort((a, b) => {
      if (!a.sent && !b.sent) {
        return 0;
      }
      if (!a.sent) {
        return -1;
      }
      if (!b.sent) {
        return 1;
      }
      return a.sent.localeCompare(b.sent);
    });
  }

  setCommunications(newCommunications);
}

export interface BaseChatProps extends PaperProps {
  readonly title: string;
  readonly communications: Communication[];
  readonly setCommunications: (communications: Communication[]) => void;
  readonly query: string;
  readonly sendMessage: (content: string | Attachment, attachments?: Attachment[]) => void;
  readonly onMessageReceived?: (message: Communication) => void;
  readonly onMessageUpdated?: (message: Communication) => void;
  readonly inputDisabled?: boolean;
  readonly excludeHeader?: boolean;
  readonly onError?: (err: Error) => void;
  /** External attachment state - when provided, used instead of internal state */
  readonly attachments?: Attachment[];
  readonly onAttachmentsChange?: (attachments: Attachment[]) => void;
  /** Ref to trigger attachment from outside (e.g. header button) */
  readonly attachmentTriggerRef?: React.Ref<{ trigger: () => void }>;
  /** Ref to trigger form submit from outside (e.g. header send button) */
  readonly submitFormRef?: React.Ref<() => void>;
  /** Callback to register send function for header button (avoids ref timing issues) */
  readonly onSendReady?: (send: () => void) => void;
  /** When true, use polling instead of WebSocket for new messages */
  readonly disableWebSocket?: boolean;
  /** Called after marking messages as read on load (so parent can refresh unread list) */
  readonly onMessagesMarkedAsRead?: () => void;
  /** Thread subject (e.g. Patient) - when sender matches this, message gets patient (red) bubble styling */
  readonly subjectRef?: Reference;
  /** When true, hide compose area entirely (read-only thread view). */
  readonly hideInput?: boolean;
}

interface PendingUpload {
  id: string;
  file: File;
  status: 'uploading' | 'failed';
  error?: string;
}

/**
 * BaseChat component for displaying and managing communications.
 *
 * **NOTE: The component automatically filters `Communication` resources where the `sent` property is `undefined`.**
 *
 * @param props - The BaseChat React props.
 * @returns The BaseChat React node.
 */
export function BaseChat(props: BaseChatProps): JSX.Element | null {
  const {
    title,
    communications,
    setCommunications,
    query,
    sendMessage,
    onMessageReceived,
    onMessageUpdated,
    inputDisabled,
    onError,
    excludeHeader = false,
    attachments: externalAttachments,
    onAttachmentsChange,
    attachmentTriggerRef,
    submitFormRef,
    onSendReady,
    disableWebSocket = false,
    onMessagesMarkedAsRead,
    subjectRef,
    hideInput = false,
    ...paperProps
  } = props;
  const medplum = useMedplum();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const hiddenSubmitRef = useRef<HTMLButtonElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const scrollToBottomRef = useRef<boolean>(true);
  const [internalAttachments, setInternalAttachments] = useState<Attachment[]>([]);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const sendRef = useRef<() => void>(() => {});

  const enterToSend = useMemo(
    () =>
      Extension.create({
        name: 'enterToSend',
        addKeyboardShortcuts() {
          return {
            Enter: () => {
              // Preserve normal Enter behavior while editing lists.
              if (
                this.editor.isActive('listItem') ||
                this.editor.isActive('bulletList') ||
                this.editor.isActive('orderedList')
              ) {
                return false;
              }
              sendRef.current();
              return true;
            },
          };
        },
      }),
    []
  );

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: false }),
      TiptapLink.configure({ openOnClick: false }),
      Underline,
      enterToSend,
    ],
    content: '',
    editable: !inputDisabled,
  });

  const useExternalAttachments = externalAttachments !== undefined && onAttachmentsChange !== undefined;
  const attachments = useExternalAttachments ? externalAttachments : internalAttachments;
  const setAttachments = useExternalAttachments ? onAttachmentsChange : setInternalAttachments;
  const attachmentsRef = useRef<Attachment[]>(attachments);
  attachmentsRef.current = attachments;
  const isUploading = pendingUploads.some((p) => p.status === 'uploading');
  const firstScrollRef = useRef(true);
  const initialLoadRef = useRef(true);
  const shouldAutoScrollRef = useRef(true);

  useImperativeHandle(attachmentTriggerRef, () => ({ trigger: () => fileInputRef.current?.click() }), []);

  /** Direct send - bypasses form entirely for reliable attachment sending */
  const performSend = useCallback(() => {
    if (inputDisabled || !editor) return;
    if (isUploading) return;
    const text = editor.getText().trim();
    if (!text && attachments.length === 0) return;
    const html = editor.getHTML();
    const stripped = html.replace(/<\/?p>/g, '').trim();
    const hasFormatting = /<[a-z][\s\S]*?>/i.test(stripped);
    const content: string | Attachment = hasFormatting
      ? { contentType: 'text/html', data: base64EncodeUtf8(html) }
      : text;
    sendMessage(content, attachments.length > 0 ? attachments : undefined);
    editor.commands.clearContent();
    if (useExternalAttachments && onAttachmentsChange) {
      onAttachmentsChange([]);
    } else {
      setInternalAttachments([]);
    }
    scrollToBottomRef.current = true;
  }, [inputDisabled, editor, isUploading, attachments, sendMessage, useExternalAttachments, onAttachmentsChange]);

  useEffect(() => {
    sendRef.current = performSend;
  }, [performSend]);

  useEffect(() => {
    if (editor) {
      editor.setEditable(!inputDisabled);
    }
  }, [editor, inputDisabled]);

  useEffect(() => {
    onSendReady?.(performSend);
    if (!submitFormRef || !('current' in submitFormRef)) return;
    const ref = submitFormRef as React.MutableRefObject<(() => void) | null>;
    ref.current = performSend;
    return () => {
      ref.current = null;
    };
  }, [submitFormRef, performSend, onSendReady]);

  const [profile, setProfile] = useState(medplum.getProfile());
  const [reconnecting, setReconnecting] = useState(false);
  const [loading, setLoading] = useState(true);

  if (!loading) {
    initialLoadRef.current = false;
  }

  const profileRefStr = useMemo<string>(
    () => (profile ? getReferenceString(medplum.getProfile() as WithId<ProfileResource>) : ''),
    [profile, medplum]
  );

  const searchMessages = useCallback(async (showLoading = true): Promise<void> => {
    if (showLoading) {
      setLoading(true);
    }
    try {
      const searchParams = new URLSearchParams(query);
      searchParams.append('_sort', '-sent');
      searchParams.append('sent:missing', 'false');
      const searchResult = await medplum.searchResources('Communication', searchParams, { cache: 'no-cache' });
      upsertCommunications(communicationsRef.current, searchResult, setCommunications);
      // Mark messages as read when recipient views thread (not just when new message arrives via WebSocket)
      let markedAny = false;
      if (onMessageReceived && profileRefStr) {
        for (const comm of searchResult) {
          const fromSomeoneElse = comm.sender?.reference && getReferenceString(comm.sender as Reference) !== profileRefStr;
          const notYetRead = !(comm.received && comm.status === 'completed');
          if (fromSomeoneElse && notYetRead) {
            onMessageReceived(comm);
            markedAny = true;
          }
        }
      }
      if (markedAny) {
        onMessagesMarkedAsRead?.();
      }
    } finally {
      // Always clear loading after explicit load cycles so the composer stays visible.
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [medplum, setCommunications, query, onMessageReceived, onMessagesMarkedAsRead, profileRefStr]);

  useEffect(() => {
    searchMessages(initialLoadRef.current).catch((err) =>
      showNotification({ color: 'red', message: normalizeErrorString(err) })
    );
  }, [searchMessages]);

  const subscriptionCallback = useCallback(
    (bundle: Bundle) => {
      const communication = bundle.entry?.[1]?.resource as Communication;
      upsertCommunications(communicationsRef.current, [communication], setCommunications);
      if (getReferenceString(communication.sender as Reference) === profileRefStr) {
        return;
      }
      if (communicationsRef.current.find((c) => c.id === communication.id)) {
        onMessageUpdated?.(communication);
      } else {
        onMessageReceived?.(communication);
      }
    },
    [profileRefStr, onMessageUpdated, onMessageReceived]
  );

  useSubscription(
    disableWebSocket ? undefined : `Communication?${query}`,
    subscriptionCallback,
    disableWebSocket
      ? undefined
      : {
          onWebSocketClose: useCallback(() => {
            if (!reconnecting) {
              setReconnecting(true);
            }
            showNotification({ color: 'red', message: 'Live chat disconnected. Attempting to reconnect...' });
          }, [reconnecting]),
          onWebSocketOpen: useCallback(() => {
            if (reconnecting) {
              showNotification({ color: 'green', message: 'Live chat reconnected.' });
            }
          }, [reconnecting]),
          onSubscriptionConnect: useCallback(() => {
            if (reconnecting) {
              searchMessages().catch((err) => showNotification({ color: 'red', message: normalizeErrorString(err) }));
              setReconnecting(false);
            }
          }, [reconnecting, searchMessages]),
          onError: useCallback(
            (err: Error) => {
              if (onError) {
                onError(err);
              } else {
                showError(normalizeErrorString(err));
              }
            },
            [onError]
          ),
        }
  );

  // Polling when WebSocket is disabled
  useEffect(() => {
    if (!disableWebSocket) {
      return;
    }
    const interval = setInterval(() => {
      searchMessages(false).catch((err) => showNotification({ color: 'red', message: normalizeErrorString(err) }));
    }, 5000);
    return () => clearInterval(interval);
  }, [disableWebSocket, searchMessages]);

  const sendMessageInternal = useCallback(
    (_formData: Record<string, string>) => {
      performSend();
    },
    [performSend]
  );

  const uploadFile = useCallback(
    async (pendingId: string, file: File): Promise<void> => {
      try {
        const attachment = await medplum.createAttachment({
          data: file,
          contentType: file.type || 'application/octet-stream',
          filename: file.name,
        });
        if (useExternalAttachments) {
          onAttachmentsChange!([...(attachmentsRef.current ?? []), attachment]);
        } else {
          setInternalAttachments((prev) => [...prev, attachment]);
        }
        setPendingUploads((prev) => prev.filter((p) => p.id !== pendingId));
      } catch (err) {
        setPendingUploads((prev) =>
          prev.map((p) =>
            p.id === pendingId
              ? { ...p, status: 'failed', error: normalizeErrorString(err as Error) }
              : p
          )
        );
      }
    },
    [medplum, useExternalAttachments, onAttachmentsChange]
  );

  const enqueueFiles = useCallback(
    (files: FileList): void => {
      if (inputDisabled || files.length === 0) {
        return;
      }
      const pending: PendingUpload[] = Array.from(files).map((file) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        status: 'uploading',
      }));
      setPendingUploads((prev) => [...prev, ...pending]);
      for (const item of pending) {
        void uploadFile(item.id, item.file);
      }
    },
    [inputDisabled, uploadFile]
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files?.length) {
        return;
      }
      enqueueFiles(files);
      e.target.value = '';
    },
    [enqueueFiles]
  );

  const removeAttachment = useCallback(
    (index: number) => {
      setAttachments(attachments.filter((_, i) => i !== index));
    },
    [attachments, setAttachments]
  );

  const retryPendingUpload = useCallback(
    (pendingId: string): void => {
      const pending = pendingUploads.find((p) => p.id === pendingId);
      if (!pending) {
        return;
      }
      setPendingUploads((prev) => prev.map((p) => (p.id === pendingId ? { ...p, status: 'uploading', error: undefined } : p)));
      void uploadFile(pendingId, pending.file);
    },
    [pendingUploads, uploadFile]
  );

  const removePendingUpload = useCallback((pendingId: string): void => {
    setPendingUploads((prev) => prev.filter((p) => p.id !== pendingId));
  }, []);

  // Disabled because we can make sure this will trigger an update when local profile !== medplum.getProfile()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const latestProfile = medplum.getProfile();
    if (profile?.id !== latestProfile?.id) {
      setProfile(latestProfile);
      setCommunications([]);
    }
  });

  const [parentRef, parentRect] = useResizeObserver<HTMLDivElement>();

  const communicationsRef = useRef<Communication[]>(communications);
  communicationsRef.current = communications;
  const prevCommunicationsRef = useRef<Communication[]>(communications);
  const visibleCommunications = useMemo(
    () =>
      communications.filter(
        (c) =>
          !c.identifier?.some((id) => {
            if (id.system !== 'https://medplum.com/thread-event') {
              return false;
            }
            return id.value === 'reassigned-to-you' || id.value === 'ownership-change';
          })
      ),
    [communications]
  );
  const lastOutgoingMessageId = useMemo(() => {
    for (let i = visibleCommunications.length - 1; i >= 0; i--) {
      const comm = visibleCommunications[i];
      if (referenceMatches(getReferenceString(comm.sender as Reference), profileRefStr)) {
        return comm.id;
      }
    }
    return undefined;
  }, [visibleCommunications, profileRefStr]);

  const handleScrollPositionChange = useCallback(
    ({ y }: { x: number; y: number }): void => {
      const viewport = scrollAreaRef.current;
      if (!viewport) {
        return;
      }
      if (viewport.clientHeight === 0) {
        shouldAutoScrollRef.current = true;
        return;
      }
      const distanceFromBottom = viewport.scrollHeight - y - viewport.clientHeight;
      shouldAutoScrollRef.current = distanceFromBottom <= 96;
    },
    []
  );

  useEffect(() => {
    // When switching threads/queries, reset initial scroll behavior for the new conversation.
    firstScrollRef.current = true;
    scrollToBottomRef.current = true;
    shouldAutoScrollRef.current = true;
  }, [query]);

  useEffect(() => {
    if (communications !== prevCommunicationsRef.current) {
      scrollToBottomRef.current = firstScrollRef.current || shouldAutoScrollRef.current;
    }
    prevCommunicationsRef.current = communications;
  }, [communications]);

  useEffect(() => {
    if (scrollToBottomRef.current) {
      if (scrollAreaRef.current?.scrollTo) {
        scrollAreaRef.current.scrollTo({
          top: scrollAreaRef.current.scrollHeight,
          // We want to skip scrolling through the whole chat on initial load,
          // Then every time after we will do the "smooth scroll"
          ...(firstScrollRef.current ? { duration: 0 } : { behavior: 'smooth' }),
        });
        firstScrollRef.current = false;
        shouldAutoScrollRef.current = true;
        scrollToBottomRef.current = false;
      }
    }
  });

  /** For provider's messages: show "Read" or "Unread" based on whether recipient (patient) has read it */
  const getReadStatus = useCallback(
    (comm: Communication): 'read' | 'unread' | null => {
      if (comm.sender?.reference !== profileRefStr) return null; // not my message
      if (comm.received && comm.status === 'completed') return 'read';
      return 'unread';
    },
    [profileRefStr]
  );

  if (!profile) {
    return null;
  }

  return (
    <Paper className={classes.chatPaper} p={0} radius="md" {...paperProps}>
      {!excludeHeader && (
        <Title order={2} className={classes.chatTitle}>
          {title}
        </Title>
      )}
      <div className={classes.chatBody} ref={parentRef as LegacyRef<HTMLDivElement>}>
        {initialLoadRef.current ? (
          <Stack key="skeleton-chat-messages" align="stretch" mt="lg">
            <Group justify="flex-start" align="flex-end" gap="xs" mb="sm">
              <Skeleton height={38} circle ml="md" />
              <ChatBubbleSkeleton alignment="left" parentWidth={parentRect.width} />
            </Group>
            <Group justify="flex-end" align="flex-end" gap="xs" mb="sm">
              <ChatBubbleSkeleton alignment="right" parentWidth={parentRect.width} />
              <Skeleton height={38} circle mr="md" />
            </Group>
            <Group justify="flex-start" align="flex-end" gap="xs" mb="sm">
              <Skeleton height={38} circle ml="md" />
              <ChatBubbleSkeleton alignment="left" parentWidth={parentRect.width} />
            </Group>
          </Stack>
        ) : (
          <ScrollArea
            viewportRef={scrollAreaRef}
            className={classes.chatScrollArea}
            onScrollPositionChange={handleScrollPositionChange}
          >
            {/* We don't wrap our scrollarea or scrollarea children with this overlay since it seems to break the rendering of the virtual scroll element */}
            {/* Instead we manually set the width and height to match the parent and use absolute positioning */}
            <LoadingOverlay
              visible={loading || reconnecting}
              style={{ width: parentRect.width, height: parentRect.height, position: 'absolute', zIndex: 1 }}
            />
            {visibleCommunications.map((c, i) => {
              const prevCommunication = i > 0 ? visibleCommunications[i - 1] : undefined;
              const prevCommTime = prevCommunication ? parseSentTime(prevCommunication) : undefined;
              const currCommTime = parseSentTime(c);
              const readStatus = getReadStatus(c);
              return (
                <Stack key={`${c.id}--${c.meta?.versionId ?? 'no-version'}`} align="stretch">
                  {(!prevCommTime || currCommTime !== prevCommTime) && (
                    <Text fz="xs" ta="center">
                      {currCommTime}
                    </Text>
                  )}
                  {referenceMatches(
                    getReferenceString(c.sender as Reference),
                    profileRefStr
                  ) ? (
                    <Group justify="flex-end" align="flex-end" gap="xs" mb="sm">
                      <ChatBubble
                        alignment="right"
                        communication={c}
                        readStatus={readStatus}
                        showReadReceipt={c.id === lastOutgoingMessageId}
                      />
                      <ResourceAvatar
                        radius="xl"
                        color="orange"
                        value={c.sender}
                        mb={!readStatus ? 'sm' : undefined}
                      />
                    </Group>
                  ) : (
                    <div data-chat-side="patient">
                      <Group justify="flex-start" align="flex-end" gap="xs" mb="sm">
                        <ResourceAvatar radius="xl" value={c.sender} mb="sm" />
                        <ChatBubble
                          alignment="left"
                          communication={c}
                          readStatus={readStatus}
                          showReadReceipt={false}
                          isPatientBubble={
                            (!!subjectRef &&
                              referenceMatches(
                                getReferenceString(c.sender as Reference),
                                getReferenceString(subjectRef as Reference)
                              )) ||
                            (!!profileRefStr &&
                              !!c.recipient?.some((r) =>
                                referenceMatches(getReferenceString(r as Reference), profileRefStr)
                              ))
                          }
                        />
                      </Group>
                    </div>
                  )}
                </Stack>
              );
            })}
          </ScrollArea>
        )}
        {!hideInput && <div className={classes.chatInputContainer}>
          <Form onSubmit={sendMessageInternal}>
          <button
            ref={hiddenSubmitRef}
            type="submit"
            style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}
            tabIndex={-1}
            aria-hidden
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileSelect}
            accept="*/*"
            disabled={inputDisabled}
          />
          <Box style={{ flex: 1, minWidth: 0 }} className={classes.composeUnifiedContainer}>
                  <RichTextEditor
                    editor={editor}
                    variant="subtle"
                    className={cx(inputDisabled && classes.richTextDisabled)}
                    classNames={{ root: classes.richTextRoot, content: classes.richTextContent, toolbar: classes.richTextToolbar }}
                  >
                    <RichTextEditor.Toolbar>
                      <RichTextEditor.ControlsGroup>
                        <RichTextEditor.Bold />
                        <RichTextEditor.Italic />
                        <RichTextEditor.Underline />
                        <RichTextEditor.BulletList />
                        <RichTextEditor.OrderedList />
                        <RichTextEditor.Link />
                      </RichTextEditor.ControlsGroup>
                    </RichTextEditor.Toolbar>
                    <RichTextEditor.Content />
                    {(attachments.length > 0 || pendingUploads.length > 0) && (
                      <Group className={classes.editorAttachmentChips} gap={6} wrap="wrap">
                        {attachments.map((att, i) => (
                          <Group key={i} gap={4} className={classes.attachmentChip}>
                            <span className={classes.attachmentChipIcon}>{getAttachmentTypeIcon(att)}</span>
                            <Text size="xs" truncate maw={180}>
                              {getAttachmentDisplayName(att)}
                            </Text>
                            {formatFileSize(att.size) && (
                              <Text size="xs" className={cx(classes.attachmentChipSize, classes.secondaryText)}>
                                {formatFileSize(att.size)}
                              </Text>
                            )}
                            {!inputDisabled && (
                              <ActionIcon
                                size="xs"
                                variant="subtle"
                                color="gray"
                                aria-label="Remove attachment"
                                onClick={() => removeAttachment(i)}
                              >
                                ×
                              </ActionIcon>
                            )}
                          </Group>
                        ))}
                        {pendingUploads.map((pending) => (
                          <Group
                            key={pending.id}
                            gap={4}
                            className={cx(classes.attachmentChip, pending.status === 'failed' && classes.attachmentChipFailed)}
                          >
                            {pending.status === 'uploading' ? (
                              <Loader size={12} />
                            ) : (
                              <span className={classes.attachmentChipIcon}>
                                {getAttachmentTypeIcon({
                                  contentType: pending.file.type || 'application/octet-stream',
                                } as Attachment)}
                              </span>
                            )}
                            <Text size="xs" truncate maw={180}>
                              {pending.file.name}
                            </Text>
                            {pending.status !== 'uploading' && (
                              <Text size="xs" className={cx(classes.attachmentChipSize, classes.secondaryText)}>
                                {formatFileSize(pending.file.size)}
                              </Text>
                            )}
                            {pending.status === 'failed' && (
                              <Text
                                size="xs"
                                c="red"
                                style={{ cursor: 'pointer', textDecoration: 'underline' }}
                                onClick={() => retryPendingUpload(pending.id)}
                              >
                                Retry
                              </Text>
                            )}
                            {!inputDisabled && (
                              <ActionIcon
                                size="xs"
                                variant="subtle"
                                color="gray"
                                aria-label="Remove upload"
                                onClick={() => removePendingUpload(pending.id)}
                              >
                                ×
                              </ActionIcon>
                            )}
                          </Group>
                        ))}
                      </Group>
                    )}
                  </RichTextEditor>
                {!inputDisabled && (
                  <Group justify="space-between" align="center" className={classes.composeActionRow} wrap="nowrap">
                    <Tooltip label="Attach file" withArrow>
                      <ActionIcon
                        type="button"
                        size={44}
                        radius="xl"
                        variant="subtle"
                        className={classes.composeAttachButton}
                        aria-label="Attach file"
                        disabled={isUploading}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <IconPaperclip size={20} stroke={1.8} className={classes.composeAttachIcon} />
                      </ActionIcon>
                    </Tooltip>
                    <ActionIcon
                      type="button"
                      size={44}
                      radius="xl"
                      color="blue"
                      variant="filled"
                      aria-label="Send message"
                      onClick={performSend}
                      disabled={isUploading}
                    >
                      <IconArrowRight size="1.15rem" stroke={1.5} />
                    </ActionIcon>
                  </Group>
                )}
              </Box>
        </Form>
        </div>}
      </div>
    </Paper>
  );
}

/** Derive a display name from attachment when title is missing */
function getAttachmentDisplayName(attachment: Attachment): string {
  if (attachment.title?.trim()) {
    return attachment.title.trim();
  }
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

function AttachmentItem(props: { attachment: Attachment; index: number; attachmentOnly?: boolean }): JSX.Element {
  const { attachment, index, attachmentOnly } = props;
  const resolvedUrl = useCachedBinaryUrl(attachment.url);
  const medplum = useMedplum();
  const [previewOpened, setPreviewOpened] = useState(false);
  const rawUrl = resolvedUrl ?? attachment.url;
  const href = rawUrl
    ? rawUrl.startsWith('http')
      ? rawUrl
      : `${medplum.getBaseUrl()}fhir/R4/${rawUrl.replace(/^\//, '')}`
    : undefined;
  const displayName = getAttachmentDisplayName(attachment);
  const isImage = isImageAttachment(attachment, displayName);
  const fileSize = formatFileSize(attachment.size);

  const openAttachment = (): void => {
    if (!href) {
      return;
    }
    if (isImage) {
      setPreviewOpened(true);
      return;
    }
    window.open(href, '_blank', 'noopener,noreferrer');
  };

  const downloadAttachment = (e: MouseEvent): void => {
    e.stopPropagation();
    if (!href) {
      return;
    }
    window.open(href, '_blank', 'noopener,noreferrer');
  };

  if (!href) {
    return (
      <div key={index} className={classes.fileChip}>
        <Group gap={6} wrap="nowrap">
          <span className={classes.fileChipIcon}>{getAttachmentTypeIcon(attachment)}</span>
          <Text size="xs" truncate maw={220} fw={500}>
            {displayName}
          </Text>
        </Group>
      </div>
    );
  }

  if (isImage) {
    return (
      <>
        <UnstyledButton key={index} onClick={openAttachment} className={classes.inlineImageButton}>
          <Image
            src={href}
            alt={displayName}
            className={classes.inlineImage}
            radius="sm"
            fallbackSrc=""
          />
        </UnstyledButton>
        <Modal
          opened={previewOpened}
          onClose={() => setPreviewOpened(false)}
          fullScreen
          centered
          withCloseButton
          title={displayName}
        >
          <Box className={classes.fullscreenImageWrap}>
            <Image src={href} alt={displayName} className={classes.fullscreenImage} fit="contain" />
          </Box>
        </Modal>
      </>
    );
  }

  return (
    <UnstyledButton
      key={index}
      onClick={openAttachment}
      className={cx(classes.fileChip, attachmentOnly && classes.fileChipAttachmentOnly)}
    >
      <Group justify="space-between" gap={8} wrap="nowrap">
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <span className={classes.fileChipIcon}>{getAttachmentTypeIcon(attachment)}</span>
          <Text size="xs" truncate maw={220} fw={500}>
            {displayName}
          </Text>
          {fileSize && (
            <Text size="xs" className={cx(classes.fileChipSize, classes.secondaryText)}>
              {fileSize}
            </Text>
          )}
        </Group>
        <ActionIcon
          size="sm"
          variant="subtle"
          color="gray"
          className={classes.fileChipDownload}
          aria-label={`Download ${displayName}`}
          onClick={downloadAttachment}
        >
          <IconDownload size={14} />
        </ActionIcon>
      </Group>
    </UnstyledButton>
  );
}

interface ChatBubbleProps {
  readonly communication: Communication;
  readonly alignment: 'left' | 'right';
  /** 'read' | 'unread' | null - for provider's messages, show if recipient has read */
  readonly readStatus?: 'read' | 'unread' | null;
  /** When true, render a receipt for this message. */
  readonly showReadReceipt?: boolean;
  /** When true, apply patient (red) bubble styling */
  readonly isPatientBubble?: boolean;
}

/** Message body: plain text (contentString) or HTML (contentAttachment text/html) */
function extractMessageContent(payload: Communication['payload']): { type: 'plain' | 'html'; value: string } | null {
  const items = payload ?? [];
  const contentString = items.find((p): p is { contentString: string } => 'contentString' in p && !!p.contentString)
    ?.contentString;
  if (contentString) {
    return { type: contentString.includes('<') ? 'html' : 'plain', value: contentString };
  }
  for (const p of items) {
    const raw = (p as { contentAttachment?: Attachment }).contentAttachment;
    if (raw && typeof raw === 'object' && raw.contentType?.toLowerCase() === 'text/html' && raw.data) {
      try {
        const decoded = atob(raw.data);
        const bytes = new Uint8Array(decoded.length);
        for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
        const value = new TextDecoder().decode(bytes);
        return { type: 'html', value };
      } catch {
        continue;
      }
    }
  }
  return null;
}

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

/** True if payload has any contentAttachment items (even malformed) */
function hasAttachmentPayload(payload: Communication['payload']): boolean {
  const items = payload ?? [];
  return items.some((p) => p && typeof p === 'object' && 'contentAttachment' in p);
}

function ChatBubble(props: ChatBubbleProps): JSX.Element {
  const { communication, alignment, readStatus, showReadReceipt = false, isPatientBubble = false } = props;
  const showPatientStyling = alignment === 'left' || isPatientBubble;
  const payloadItems = communication.payload ?? [];
  const messageContent = extractMessageContent(communication.payload);
  const content = messageContent?.value ?? '';
  const isHtml = messageContent?.type === 'html';
  const attachmentItems = extractAttachmentsFromPayload(communication.payload);
  const payloadHasItems = Array.isArray(payloadItems) && payloadItems.length > 0;
  const hasAttachments =
    attachmentItems.length > 0 ||
    (hasAttachmentPayload(communication.payload) && !content) ||
    (!content && payloadHasItems);
  const sentTime = new Date(communication.sent ?? -1);
  const senderResource = useResource(communication.sender);

  return (
    <div className={classes.chatBubbleOuterWrap}>
      <Text
        fz="xs"
        mb="xs"
        fw={500}
        className={alignment === 'right' ? classes.chatBubbleNameRight : undefined}
        aria-label="Sender name"
      >
        {senderResource ? getDisplayString(senderResource) : '[Unknown sender]'}
        &nbsp;&middot;&nbsp;
        <Text span fz="xs" className={classes.secondaryText}>
          {Number.isNaN(sentTime.getTime())
            ? ''
            : sentTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        </Text>
      </Text>
      <div
        className={
          alignment === 'left' ? classes.chatBubbleLeftAlignedInnerWrap : classes.chatBubbleRightAlignedInnerWrap
        }
      >
        <div
          className={cx(classes.chatBubble, showPatientStyling && classes.chatBubblePatient)}
          {...(showPatientStyling && { 'data-chat-sender': 'patient' })}
        >
          {(content || hasAttachments) && (
            <>
              {content && (
                <div
                  className={classes.chatBubbleContent}
                  dangerouslySetInnerHTML={{
                    __html: isHtml
                      ? htmlWithUrlsToLinks(
                          DOMPurify.sanitize(content, {
                            ADD_ATTR: ['target', 'rel'],
                            ALLOWED_URI_REGEXP: /^(https?|mailto):/i,
                          })
                        )
                      : plainTextToHtmlWithLinks(content),
                  }}
                />
              )}
              {attachmentItems.length > 0 ? (
                <Stack gap={4} mt={content ? 'xs' : 0}>
                  {attachmentItems.map((att, i) => (
                    <AttachmentItem key={i} attachment={att} index={i} attachmentOnly={!content} />
                  ))}
                </Stack>
              ) : null}
            </>
          )}
        </div>
      </div>
      {readStatus === 'read' && showReadReceipt && (
        <Text fz="xs" className={classes.secondaryText} style={{ textAlign: 'right' }} aria-label="Read by recipient">
          {formatReadReceipt(communication)}
        </Text>
      )}
      {readStatus === 'unread' && showReadReceipt && (
        <Text fz="xs" className={classes.secondaryText} style={{ textAlign: 'right' }} aria-label="Unread by recipient">
          Sent
        </Text>
      )}
    </div>
  );
}

function formatReadReceipt(communication: Communication): string {
  const received = communication.received ? new Date(communication.received) : undefined;
  if (!received || Number.isNaN(received.getTime())) {
    return 'Read';
  }
  const now = new Date();
  const isToday =
    received.getFullYear() === now.getFullYear() &&
    received.getMonth() === now.getMonth() &&
    received.getDate() === now.getDate();
  if (isToday) {
    return `Read ${received.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  return `Read ${received.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

function isImageAttachment(attachment: Attachment, displayName: string): boolean {
  if (attachment.contentType?.toLowerCase().startsWith('image/')) {
    return true;
  }
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(displayName);
}

function getAttachmentTypeIcon(attachment: Attachment): JSX.Element {
  const type = attachment.contentType?.toLowerCase() ?? '';
  if (type.includes('pdf')) {
    return <IconFileTypePdf size={14} />;
  }
  if (
    type.includes('word') ||
    type.includes('officedocument') ||
    type.includes('text') ||
    type.includes('rtf')
  ) {
    return <IconFileText size={14} />;
  }
  return <IconFile size={14} />;
}

function formatFileSize(size: number | undefined): string | undefined {
  if (!size || size <= 0) {
    return undefined;
  }
  if (size < 1024) {
    return `${size} B`;
  }
  const kb = size / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

export interface ChatBubbleSkeletonProps {
  readonly alignment: 'left' | 'right';
  readonly parentWidth: number;
}

function ChatBubbleSkeleton(props: ChatBubbleSkeletonProps): JSX.Element {
  const { alignment, parentWidth } = props;
  return (
    <div className={classes.chatBubbleOuterWrap}>
      <div className={classes.chatBubbleName} aria-label="Placeholder sender name">
        <div style={{ position: 'relative' }}>
          <Skeleton
            height={14}
            width="100px"
            radius="l"
            ml={alignment === 'left' ? 'sm' : undefined}
            style={alignment === 'right' ? { position: 'absolute', right: 5, top: -15 } : undefined}
          />
        </div>
      </div>
      <div
        className={
          alignment === 'left' ? classes.chatBubbleLeftAlignedInnerWrap : classes.chatBubbleRightAlignedInnerWrap
        }
      >
        <div
          className={cx(classes.chatBubble, alignment === 'left' && classes.chatBubblePatient)}
          {...(alignment === 'left' && { 'data-chat-sender': 'patient' })}
        >
          <Skeleton height={14} width={parentWidth * 0.5} radius="l" />
        </div>
      </div>
    </div>
  );
}
