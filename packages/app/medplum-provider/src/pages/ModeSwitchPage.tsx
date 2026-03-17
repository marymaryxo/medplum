// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { Loading } from '@medplum/react';
import type { JSX } from 'react';
import { useEffect } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import type { PortalMode } from '../utils/portal-mode';
import { setPortalMode } from '../utils/portal-mode';

interface ModeSwitchPageProps {
  canUseAdminMode: boolean;
}

export function ModeSwitchPage(props: ModeSwitchPageProps): JSX.Element {
  const { canUseAdminMode } = props;
  const { mode } = useParams();
  const navigate = useNavigate();

  useEffect(() => {
    const requestedMode = mode as PortalMode | undefined;
    if (requestedMode === 'provider') {
      setPortalMode('provider');
    } else if (requestedMode === 'admin' && canUseAdminMode) {
      setPortalMode('admin');
    }
    navigate('/', { replace: true })?.catch(console.error);
  }, [canUseAdminMode, mode, navigate]);

  if (mode !== 'provider' && mode !== 'admin') {
    return <Navigate to="/" replace />;
  }

  return <Loading />;
}
