// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Title } from '@mantine/core';
import { Logo, SignInForm } from '@medplum/react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router';

export function SignInPage(): JSX.Element {
  const navigate = useNavigate();
  return (
    <SignInForm
      // Configure according to your settings
      googleClientId="397236612778-c0b5tnjv98frbo1tfuuha5vkme3cmq4s.apps.googleusercontent.com"
      onSuccess={() => navigate('/')?.catch(console.error)}
    >
      <Logo size={32} />
      <Title order={3} py="lg">
        Sign in to Provider
      </Title>
    </SignInForm>
  );
}
