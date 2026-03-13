// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import react from '@vitejs/plugin-react';
import dns from 'dns';
import { existsSync } from 'fs';
import path from 'path';
import type { UserConfig } from 'vite';
import { defineConfig } from 'vitest/config';

dns.setDefaultResultOrder('verbatim');

// Resolve aliases to local packages when working within the monorepo.
const alias: NonNullable<UserConfig['resolve']>['alias'] = Object.fromEntries(
  Object.entries({
    '@medplum/core': path.resolve(__dirname, '../../../packages/core/src'),
    '@medplum/dosespot-react': path.resolve(__dirname, '../../../packages/dosespot-react/src'),
    '@medplum/react': path.resolve(__dirname, '../../../packages/react/src'),
    '@medplum/react/styles.css': path.resolve(__dirname, '../../../packages/react/src/styles.css'),
    '@medplum/react-hooks': path.resolve(__dirname, '../../../packages/react-hooks/src'),
    '@medplum/health-gorilla-core': path.resolve(__dirname, '../../../packages/health-gorilla-core/src'),
    '@medplum/health-gorilla-react': path.resolve(__dirname, '../../../packages/health-gorilla-react/src'),
  }).filter(([, relPath]) => existsSync(relPath))
);

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: 'localhost',
    port: 3000,
    allowedHosts: ['fatlike-painfully-erwin.ngrok-free.dev', '.ngrok-free.dev'],
  },
  preview: {
    host: 'localhost',
    port: 3000,
  },
  resolve: {
    alias: {
      ...alias,
      react: path.resolve(__dirname, 'node_modules/react'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
      '@mantine/core': path.resolve(__dirname, 'node_modules/@mantine/core'),
      '@mantine/hooks': path.resolve(__dirname, 'node_modules/@mantine/hooks'),
      '@mantine/notifications': path.resolve(__dirname, 'node_modules/@mantine/notifications'),
      '@mantine/spotlight': path.resolve(__dirname, 'node_modules/@mantine/spotlight'),
      '@mantine/tiptap': path.resolve(__dirname, 'node_modules/@mantine/tiptap'),
      '@tiptap/react': path.resolve(__dirname, 'node_modules/@tiptap/react'),
      '@tiptap/core': path.resolve(__dirname, 'node_modules/@tiptap/core'),
      '@tiptap/extension-underline': path.resolve(__dirname, 'node_modules/@tiptap/extension-underline'),
      '@tiptap/starter-kit': path.resolve(__dirname, 'node_modules/@tiptap/starter-kit'),
    },
    dedupe: [
      'react',
      'react-dom',
      '@mantine/core',
      '@mantine/hooks',
      '@mantine/notifications',
      '@mantine/spotlight',
      '@mantine/tiptap',
      '@tiptap/react',
      '@tiptap/pm',
      '@tiptap/core',
    ],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test.setup.ts',
  },
});
