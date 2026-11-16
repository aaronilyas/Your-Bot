import { AesGcmFileCipher, createFileCipher, type AesGcmFileCipherOptions } from './aes-gcm.js';
import { SafeStorageCipher, createSafeStorageCipher, type SafeStorageBackend } from './safe-storage.js';

export {
  AesGcmFileCipher,
  createFileCipher,
  type AesGcmFileCipherOptions,
  SafeStorageCipher,
  createSafeStorageCipher,
  type SafeStorageBackend,
};

export type { SecretCipher } from '@your-bot/contracts';

/**
 * Check whether a value is an encrypted secret string produced by a SecretCipher.
 * Recognizes v1.<iv>.<tag>.<ciphertext> and ss1.<base64url>.
 */
export function isEncrypted(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  if (value.startsWith('v1.')) {
    const parts = value.split('.');
    return parts.length === 4 && parts[1].length > 0 && parts[2].length > 0;
  }
  if (value.startsWith('ss1.')) {
    const parts = value.split('.');
    return parts.length === 2 && parts[1].length > 0;
  }
  return false;
}
