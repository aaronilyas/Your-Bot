import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createGateway } from '@your-bot/core';
import { createAdapters } from '@your-bot/adapters';
import { createToolExecutor } from '@your-bot/executor';
import type { GatewayFactory } from './host';

/** Composition is host-owned. The renderer receives neither dependencies nor identity. */
export const createApplicationGateway: GatewayFactory = async ({ principal, userDataPath }) => {
  await mkdir(userDataPath, { recursive: true, mode: 0o700 });
  const dataRoot = await realpath(userDataPath);
  const executor = createToolExecutor({ environmentRoot: join(dataRoot, 'python') });
  return createGateway({
    databasePath: join(dataRoot, 'gateway', 'history.sqlite'),
    localPrincipalId: principal.id,
    executor,
    onSettingsChanged: settings => createAdapters(settings.providers),
    cleanupTimeoutMs: 5000,
  });
};
