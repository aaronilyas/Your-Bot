import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createGateway } from '@your-bot/core';
import { createAdapters, BubblewrapContainmentLauncher, type AdapterFactoryOptions } from '@your-bot/adapters';
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
    onSettingsChanged: settings => {
      const acpByProvider: NonNullable<AdapterFactoryOptions['acpByProvider']> = Object.fromEntries(settings.providers
        .filter(provider => process.platform === 'linux' && process.arch === 'x64' && provider.kind === 'acp' && provider.args?.length === 1 && /^\/.*\.(mjs|py)$/.test(provider.args[0]))
        .map(provider => [provider.id, { containment: new BubblewrapContainmentLauncher({ scriptPath: provider.args![0] }) }]));
      return createAdapters(settings.providers, { acpByProvider });
    },
    cleanupTimeoutMs: 5000,
  });
};
