import { afterEach, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AesGcmFileCipher,
  createFileCipher,
  createSafeStorageCipher,
  isEncrypted,
  SafeStorageCipher,
  type SafeStorageBackend,
} from './index.js';

describe('packages/secrets', () => {
  const tempDirs: string[] = [];

  function createTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `your-bot-test-secrets-${prefix}-`));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    tempDirs.length = 0;
  });

  describe('AesGcmFileCipher / createFileCipher', () => {
    it('creates key file with mode 0600 in directory with mode 0700', () => {
      const parentDir = createTempDir('key-perm');
      const keyDir = path.join(parentDir, 'sub', 'secrets');
      const keyPath = path.join(keyDir, 'master.key');

      const cipher = createFileCipher({ keyPath });
      expect(cipher.id).toBe('aes-gcm-file');
      expect(fs.existsSync(keyPath)).toBe(true);

      const keyStat = fs.statSync(keyPath);
      expect(keyStat.size).toBe(32);

      if (process.platform !== 'win32') {
        const keyMode = keyStat.mode & 0o777;
        expect(keyMode).toBe(0o600);

        const dirStat = fs.statSync(keyDir);
        const dirMode = dirStat.mode & 0o777;
        expect(dirMode).toBe(0o700);
      }
    });

    it('performs encryption/decryption round trip for various plaintexts', () => {
      const tempDir = createTempDir('round-trip');
      const keyPath = path.join(tempDir, 'key.bin');
      const cipher = new AesGcmFileCipher({ keyPath });

      const testCases = [
        'hello world',
        '',
        'secret-api-key-1234567890!@#$%^&*()',
        'Unicode 🔑 🚀 日本語 testing',
        'A'.repeat(5000),
      ];

      for (const plain of testCases) {
        const encrypted = cipher.encrypt(plain);
        expect(isEncrypted(encrypted)).toBe(true);
        expect(encrypted.startsWith('v1.')).toBe(true);

        const decrypted = cipher.decrypt(encrypted);
        expect(decrypted).toBe(plain);
      }
    });

    it('generates unique IV per encryption', () => {
      const tempDir = createTempDir('unique-iv');
      const keyPath = path.join(tempDir, 'key.bin');
      const cipher = createFileCipher({ keyPath });

      const plaintext = 'constant plaintext';
      const c1 = cipher.encrypt(plaintext);
      const c2 = cipher.encrypt(plaintext);
      const c3 = cipher.encrypt(plaintext);

      expect(c1).not.toBe(c2);
      expect(c2).not.toBe(c3);

      const iv1 = c1.split('.')[1];
      const iv2 = c2.split('.')[1];
      const iv3 = c3.split('.')[1];

      expect(iv1).not.toBe(iv2);
      expect(iv2).not.toBe(iv3);
      expect(Buffer.from(iv1, 'base64url').length).toBe(12);
      expect(Buffer.from(iv2, 'base64url').length).toBe(12);
      expect(Buffer.from(iv3, 'base64url').length).toBe(12);
    });

    it('detects tampering and throws on corrupted ciphertext, IV or tag', () => {
      const tempDir = createTempDir('tamper');
      const keyPath = path.join(tempDir, 'key.bin');
      const cipher = createFileCipher({ keyPath });

      const encrypted = cipher.encrypt('sensitive message');
      const parts = encrypted.split('.');
      expect(parts).toHaveLength(4);

      // Tampered ciphertext payload
      const badCt = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3]}x`;
      expect(() => cipher.decrypt(badCt)).toThrow();

      // Tampered auth tag
      const rawTag = Buffer.from(parts[2], 'base64url');
      rawTag[0] ^= 0xff; // flip bits
      const badTag = `${parts[0]}.${parts[1]}.${rawTag.toString('base64url')}.${parts[3]}`;
      expect(() => cipher.decrypt(badTag)).toThrow();

      // Tampered IV
      const rawIv = Buffer.from(parts[1], 'base64url');
      rawIv[0] ^= 0xff;
      const badIv = `${parts[0]}.${rawIv.toString('base64url')}.${parts[2]}.${parts[3]}`;
      expect(() => cipher.decrypt(badIv)).toThrow();

      // Malformed format
      expect(() => cipher.decrypt('invalid.format')).toThrow(/Invalid ciphertext format/);
      expect(() => cipher.decrypt('v2.a.b.c')).toThrow(/Invalid ciphertext format/);
    });

    it('throws when decrypting with the wrong key', () => {
      const tempDir = createTempDir('wrong-key');
      const keyPath1 = path.join(tempDir, 'key1.bin');
      const keyPath2 = path.join(tempDir, 'key2.bin');

      const cipher1 = createFileCipher({ keyPath: keyPath1 });
      const cipher2 = createFileCipher({ keyPath: keyPath2 });

      const encrypted = cipher1.encrypt('secret text');
      expect(() => cipher2.decrypt(encrypted)).toThrow();
    });

    it('refuses to use a world-readable or group-readable key file on posix', () => {
      if (process.platform === 'win32') {
        return;
      }

      const tempDir = createTempDir('perm-checks');
      const keyPath = path.join(tempDir, 'insecure.key');

      // Create a 32-byte key file
      fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600 });

      // Make it world-readable (0644)
      fs.chmodSync(keyPath, 0o644);
      expect(() => createFileCipher({ keyPath })).toThrow(/Key file must not be group- or world-readable/);

      // Make it group-readable (0640)
      fs.chmodSync(keyPath, 0o640);
      expect(() => createFileCipher({ keyPath })).toThrow(/Key file must not be group- or world-readable/);

      // Make it world-readable only (0604)
      fs.chmodSync(keyPath, 0o604);
      expect(() => createFileCipher({ keyPath })).toThrow(/Key file must not be group- or world-readable/);

      // Secure permissions (0600) works
      fs.chmodSync(keyPath, 0o600);
      const cipher = createFileCipher({ keyPath });
      expect(cipher.id).toBe('aes-gcm-file');
    });

    it('refuses to use a symlinked key file or non-file', () => {
      const tempDir = createTempDir('symlink-key');
      const realKeyPath = path.join(tempDir, 'real.key');
      fs.writeFileSync(realKeyPath, crypto.randomBytes(32), { mode: 0o600 });

      const symlinkKeyPath = path.join(tempDir, 'symlink.key');
      fs.symlinkSync(realKeyPath, symlinkKeyPath);

      expect(() => createFileCipher({ keyPath: symlinkKeyPath })).toThrow(/Key file must be a regular file/);

      // Non-file (directory as keyPath)
      const dirKeyPath = path.join(tempDir, 'dir-as-key');
      fs.mkdirSync(dirKeyPath, { mode: 0o700 });
      expect(() => createFileCipher({ keyPath: dirKeyPath })).toThrow(/Key file must be a regular file/);
    });

    it('refuses key files that are not 32 bytes', () => {
      const tempDir = createTempDir('bad-key-size');
      const shortKeyPath = path.join(tempDir, 'short.key');
      fs.writeFileSync(shortKeyPath, crypto.randomBytes(16), { mode: 0o600 });

      expect(() => createFileCipher({ keyPath: shortKeyPath })).toThrow(/must contain exactly 32 bytes/);
    });
  });

  describe('SafeStorageCipher', () => {
    function createFakeSafeStorage(available = true): SafeStorageBackend {
      return {
        isEncryptionAvailable: () => available,
        encryptString: (plainText: string) => {
          // Simple fake encryption: prefix + reverse buffer
          const buf = Buffer.from(plainText, 'utf8');
          const transformed = Buffer.alloc(buf.length);
          for (let i = 0; i < buf.length; i++) {
            transformed[i] = buf[buf.length - 1 - i] ^ 0x42;
          }
          return transformed;
        },
        decryptString: (cipherText: Buffer) => {
          const restored = Buffer.alloc(cipherText.length);
          for (let i = 0; i < cipherText.length; i++) {
            restored[i] = cipherText[cipherText.length - 1 - i] ^ 0x42;
          }
          return restored.toString('utf8');
        },
      };
    }

    it('throws on construction if encryption is unavailable', () => {
      const unavailableBackend = createFakeSafeStorage(false);
      expect(() => new SafeStorageCipher(unavailableBackend)).toThrow(
        /SafeStorage encryption is unavailable/,
      );
      expect(() => createSafeStorageCipher(unavailableBackend)).toThrow(
        /SafeStorage encryption is unavailable/,
      );
    });

    it('encrypts to format ss1.<base64url> and round-trips correctly', () => {
      const backend = createFakeSafeStorage(true);
      const cipher = createSafeStorageCipher(backend);

      expect(cipher.id).toBe('safe-storage');

      const plain = 'my secret token 12345';
      const encrypted = cipher.encrypt(plain);

      expect(encrypted.startsWith('ss1.')).toBe(true);
      expect(isEncrypted(encrypted)).toBe(true);

      const decrypted = cipher.decrypt(encrypted);
      expect(decrypted).toBe(plain);
    });

    it('rejects invalid ciphertext formats for SafeStorageCipher', () => {
      const backend = createFakeSafeStorage(true);
      const cipher = new SafeStorageCipher(backend);

      expect(() => cipher.decrypt('v1.invalid')).toThrow(/Invalid safe-storage ciphertext format/);
      expect(() => cipher.decrypt('ss1.')).toThrow(/Invalid safe-storage ciphertext format/);
      expect(() => cipher.decrypt('ss1.a.b')).toThrow(/Invalid safe-storage ciphertext format/);
    });
  });

  describe('isEncrypted helper', () => {
    it('recognizes valid v1 and ss1 ciphertext formats', () => {
      expect(isEncrypted('v1.aXZwYXNzd29yZA.dGFnMTIzNDU2Nzg5MDEy.Y2lwaGVydGV4dA')).toBe(true);
      expect(isEncrypted('ss1.ZW5jcnlwdGVk')).toBe(true);
    });

    it('returns false for plaintexts, invalid types, or broken formats', () => {
      expect(isEncrypted(null)).toBe(false);
      expect(isEncrypted(undefined)).toBe(false);
      expect(isEncrypted(12345)).toBe(false);
      expect(isEncrypted({})).toBe(false);
      expect(isEncrypted('plain text api key')).toBe(false);
      expect(isEncrypted('v1.')).toBe(false);
      expect(isEncrypted('v1.iv.tag')).toBe(false);
      expect(isEncrypted('v1.iv.tag.ct.extra')).toBe(false);
      expect(isEncrypted('ss1.')).toBe(false);
      expect(isEncrypted('ss1.a.b')).toBe(false);
    });
  });
});
