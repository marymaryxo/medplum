// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

export type PortalMode = 'provider' | 'admin';

export const PORTAL_MODE_STORAGE_KEY = 'medplum-provider-portal-mode';

export function getPortalMode(): PortalMode {
  const value = localStorage.getItem(PORTAL_MODE_STORAGE_KEY);
  return value === 'admin' ? 'admin' : 'provider';
}

export function setPortalMode(mode: PortalMode): void {
  localStorage.setItem(PORTAL_MODE_STORAGE_KEY, mode);
}
