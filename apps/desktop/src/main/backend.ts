import { join } from 'node:path';
import { safeStorage } from 'electron';
import type { SecretCipher } from '@your-bot/contracts';
import { createFileCipher, createSafeStorageCipher } from '@your-bot/secrets';
import { createRuntime } from '@your-bot/runtime';
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
  const runtime = await createRuntime({
    dataDir: userDataPath,
    principalId: principal.id,
    secretCipher: ownerCipher(userDataPath),
  });
  return runtime.gateway;
};
