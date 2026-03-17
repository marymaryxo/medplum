// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MantineProvider, createTheme } from '@mantine/core';
import '@mantine/core/styles.css';
import { Notifications } from '@mantine/notifications';
import '@mantine/notifications/styles.css';
import '@mantine/spotlight/styles.css';
import '@mantine/tiptap/styles.css';
import { MedplumClient } from '@medplum/core';
import { MedplumProvider } from '@medplum/react';
import '@medplum/react/styles.css';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { App } from './App';

const medplum = new MedplumClient({
  onUnauthenticated: () => (window.location.href = '/'),
  baseUrl: 'https://api.medplum.com',
  clientId: '9a24ff62-4633-4495-8d25-7f026c8c3472',
  cacheTime: 60000,
  autoBatchTime: 100,
});

const theme = createTheme({
  colors: {
    fshNavy: ['#e6edee', '#ccdadd', '#9ab5bb', '#679099', '#356b77', '#1a5563', '#003848', '#002f3f', '#002635', '#001c2c'],
    fshTeal: ['#e6f8f8', '#ccf0f0', '#99e1e1', '#66d2d2', '#33c3c3', '#14bbbb', '#00b4b3', '#00908f', '#006c6b', '#004847'],
  },
  primaryColor: 'fshNavy',
  primaryShade: 6,
  fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  headings: {
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    sizes: {
      h1: {
        fontSize: '1.375rem',
        fontWeight: '600',
        lineHeight: '1.4',
      },
      h2: {
        fontSize: '1.25rem',
        fontWeight: '600',
        lineHeight: '1.4',
      },
    },
  },
  fontSizes: {
    xs: '0.8125rem',  // 13px
    sm: '0.9375rem',  // 15px
    md: '0.9375rem',  // 15px
    lg: '1.0625rem',  // 17px
    xl: '1.1875rem',  // 19px
  },
  focusRing: 'always',
  defaultRadius: 'md',
});

const router = createBrowserRouter([{ path: '*', element: <App /> }]);

const navigate = (path: string): Promise<void> => router.navigate(path);

const container = document.getElementById('root') as HTMLDivElement;
const root = createRoot(container);
root.render(
  <MedplumProvider medplum={medplum} navigate={navigate}>
    <MantineProvider theme={theme}>
      <Notifications position="bottom-right" />
      <RouterProvider router={router} />
    </MantineProvider>
  </MedplumProvider>
);
