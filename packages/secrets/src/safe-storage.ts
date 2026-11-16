import type { SecretCipher } from '@your-bot/contracts';

export interface SafeStorageBackend {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(cipherText: Buffer): string;
}

export class SafeStorageCipher implements SecretCipher {
  readonly id = 'safe-storage';
  private readonly backend: SafeStorageBackend;

  constructor(backend: SafeStorageBackend) {
    if (!backend || typeof backend.isEncryptionAvailable !== 'function' || !backend.isEncryptionAvailable()) {
      throw new Error('SafeStorage encryption is unavailable');
    }
    this.backend = backend;
  }

  encrypt(plaintext: string): string {
    const encrypted = this.backend.encryptString(plaintext);
    return `ss1.${encrypted.toString('base64url')}`;
  }

  decrypt(ciphertext: string): string {
    if (typeof ciphertext !== 'string') {
      throw new Error('Ciphertext must be a string');
    }
    if (!ciphertext.startsWith('ss1.')) {
      throw new Error('Invalid safe-storage ciphertext format: expected ss1.<base64url>');
    }
    const parts = ciphertext.split('.');
    if (parts.length !== 2 || !parts[1]) {
      throw new Error('Invalid safe-storage ciphertext format: missing payload');
    }

    const buf = Buffer.from(parts[1], 'base64url');
    return this.backend.decryptString(buf);
  }
}

export function createSafeStorageCipher(backend: SafeStorageBackend): SafeStorageCipher {
  return new SafeStorageCipher(backend);
}
