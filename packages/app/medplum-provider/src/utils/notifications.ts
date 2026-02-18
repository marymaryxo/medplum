// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import { IconCircleOff } from '@tabler/icons-react';
import React from 'react';

/**
 * Shows a standardized error notification.
 *
 * UX refinement: We intentionally suppress errors that are caused by an
 * aborted fetch/AbortController signal, since those are expected during
 * fast user interactions (e.g. switching filters, closing modals) and
 * are not actionable for the user.
 */
export const showErrorNotification = (err: unknown): void => {
  // Suppress AbortError / aborted-signal cases
  if (err instanceof DOMException && err.name === 'AbortError') {
    return;
  }

  const message = normalizeErrorString(err);
  if (message.toLowerCase().includes('signal is aborted')) {
    return;
  }

  notifications.show({
    color: 'red',
    icon: React.createElement(IconCircleOff),
    title: 'Error',
    message,
  });
};
