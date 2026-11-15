import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SecretCipher } from '@your-bot/contracts';

export interface AesGcmFileCipherOptions {
  keyPath: string;
}

export class AesGcmFileCipher implements SecretCipher {
  readonly id = 'aes-gcm-file';
  private readonly key: Buffer;

  constructor(options: AesGcmFileCipherOptions) {
    if (!options || !options.keyPath) {
      throw new Error('keyPath is required for AesGcmFileCipher');
    }

    const resolvedKeyPath = path.resolve(options.keyPath);
    const dir = path.dirname(resolvedKeyPath);

    // Ensure parent directory exists with mode 0700
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(dir, 0o700);
        } catch {}
      }
    }

    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(resolvedKeyPath);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }

    if (!stat) {
      // Key file does not exist: generate 32 cryptographically random bytes
      const randomKey = crypto.randomBytes(32);
      fs.writeFileSync(resolvedKeyPath, randomKey, { mode: 0o600, flag: 'wx' });
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(resolvedKeyPath, 0o600);
        } catch {}
      }
      this.key = randomKey;
    } else {
      // Existing key file: enforce safety checks
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error('Key file must be a regular file');
      }

      if (process.platform !== 'win32') {
        if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
          throw new Error(`Key file is owned by uid ${stat.uid}, expected current uid ${process.getuid()}`);
        }

        const mode = stat.mode & 0o777;
        if ((mode & 0o044) !== 0) {
          throw new Error(`Key file must not be group- or world-readable (mode: 0${mode.toString(8)})`);
        }
        if ((mode & 0o077) !== 0) {
          throw new Error(`Key file permissions too open: group/world access forbidden (mode: 0${mode.toString(8)})`);
        }
      }

      const existingKey = fs.readFileSync(resolvedKeyPath);
      if (existingKey.length !== 32) {
        throw new Error(`Key file must contain exactly 32 bytes, found ${existingKey.length}`);
      }
      this.key = existingKey;
    }
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
  }

  decrypt(ciphertext: string): string {
    if (typeof ciphertext !== 'string') {
      throw new Error('Ciphertext must be a string');
    }

    const parts = ciphertext.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') {
      throw new Error('Invalid ciphertext format: expected v1.<iv>.<tag>.<ciphertext>');
    }

    if (!parts[1] || !parts[2]) {
      throw new Error('Invalid ciphertext format: missing IV or auth tag');
    }

    const iv = Buffer.from(parts[1], 'base64url');
    if (iv.length !== 12) {
      throw new Error(`Invalid IV length: expected 12 bytes, got ${iv.length}`);
    }

    const tag = Buffer.from(parts[2], 'base64url');
    if (tag.length !== 16) {
      throw new Error(`Invalid auth tag length: expected 16 bytes, got ${tag.length}`);
    }

    const ct = Buffer.from(parts[3], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);

    try {
      const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
      return plaintext.toString('utf8');
    } catch (err: any) {
      throw new Error(`Decryption failed (tampered ciphertext or wrong key): ${err.message}`);
    }
  }
}

export function createFileCipher(options: AesGcmFileCipherOptions): AesGcmFileCipher {
  return new AesGcmFileCipher(options);
}
