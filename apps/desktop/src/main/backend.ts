import { join } from 'node:path';
import { safeStorage } from 'electron';
import type { CommandResultV2, SecretCipher } from '@your-bot/contracts';
import { ensureControlToken, readControlToken, startControlServer, tokenPath } from '@your-bot/host';
import { createFileCipher, createSafeStorageCipher } from '@your-bot/secrets';
import { createRuntime } from '@your-bot/runtime';
import { hydrateProcessPath } from '@your-bot/providers';
import type { GatewayFactory } from './host';

/**
 * Electron safeStorage when the OS keystore is available; otherwise the file cipher whose key
 * lives in `<userData>/keys` (not beside the database). Remote pairing stays off.
 * `createRuntime` replaces `gateway.close` with the runtime close.
 */
function ownerCipher(userDataPath: string): SecretCipher {
  if (safeStorage.isEncryptionAvailable()) return createSafeStorageCipher(safeStorage);
  return createFileCipher({ keyPath: join(userDataPath, 'keys', 'secret.key') });
}

/** Composition is host-owned. The renderer receives neither dependencies nor identity. */
export const createApplicationGateway: GatewayFactory = async ({ principal, userDataPath }) => {
  // Launched from a desktop entry, the app inherits a short PATH; use the login shell's PATH so host-launched
  // agent CLIs (and the `node` their shims need) resolve exactly as they do in a terminal. Agents read PATH when
  // they launch, so this runs in the background instead of delaying the window by up to the shell timeout.
  void hydrateProcessPath().catch(() => undefined);
  const runtime = await createRuntime({
    dataDir: userDataPath,
    principalId: principal.id,
    secretCipher: ownerCipher(userDataPath),
  });
  // The installed `your-bot` command reaches this process on the owner control socket. A failure here
  // (path too long, another instance) must not stop the window from opening.
  try {
    const file = tokenPath(userDataPath);
    await ensureControlToken(file);
    const control = await startControlServer({
      dataDir: userDataPath,
      token: await readControlToken(file),
      dispatch: command => runtime.gateway.dispatch(command, runtime.principal) as Promise<CommandResultV2>,
      subscribe: listener => runtime.gateway.subscribe(listener, runtime.principal, { contractVersion: 2 }),
    });
    const closeGateway = runtime.gateway.close.bind(runtime.gateway);
    runtime.gateway.close = async () => {
      try { await control.close(); }
      finally { await closeGateway(); }
    };
  } catch (error) {
    console.error('Owner control channel did not start:', error instanceof Error ? error.message : error);
  }
  return runtime.gateway;
};
