// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Enables websocket-subscriptions on all projects.
 * Run with: npx tsx src/scripts/enable-websocket-subscriptions.ts
 */
import type { Project } from '@medplum/fhirtypes';
import { loadConfig } from '../config/loader';
import { closeDatabase, DatabaseMode, getDatabasePool, initDatabase, withPoolClient } from '../database';
import { getSystemRepo } from '../fhir/repo';
import { globalLogger } from '../logger';
import { indexStructureDefinitionsAndSearchParameters } from '../migrations/migrate';
async function main(): Promise<void> {
  const configName = process.argv[2] ?? 'file:medplum.config.json';
  globalLogger.info('Loading config', { configName });
  const config = await loadConfig(configName);

  if (!config.defaultProjectFeatures?.includes('websocket-subscriptions')) {
    globalLogger.info('Adding websocket-subscriptions to defaultProjectFeatures for this run');
    config.defaultProjectFeatures = [...(config.defaultProjectFeatures ?? []), 'websocket-subscriptions'];
  }

  globalLogger.info('Loading structure definitions...');
  indexStructureDefinitionsAndSearchParameters();

  globalLogger.info('Initializing database...');
  await initDatabase(config);

  await withPoolClient(async (client) => {
    const systemRepo = getSystemRepo(client);
    const projects = await systemRepo.searchResources<Project>({ resourceType: 'Project' });
    for (const project of projects) {
      const features = project.features ?? [];
      if (!features.includes('websocket-subscriptions')) {
        await systemRepo.updateResource<Project>({
          ...project,
          features: [...features, 'websocket-subscriptions'],
        });
        globalLogger.info('Enabled websocket-subscriptions', { projectId: project.id, projectName: project.name });
      }
    }
  }, getDatabasePool(DatabaseMode.WRITER));

  await closeDatabase();
  globalLogger.info('Done. Websocket-subscriptions enabled on all projects.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
