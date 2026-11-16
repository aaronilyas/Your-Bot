# @your-bot/secrets

`@your-bot/secrets` provides implementations of the v2 `SecretCipher` interface for encrypting sensitive credentials (such as API keys and MCP environment/header values) at rest.

## Implementations

### `AesGcmFileCipher` / `createFileCipher({ keyPath })`
- **Algorithm**: Authenticated AES-256-GCM using `node:crypto`.
- **Key Storage**: 32-byte cryptographically secure random key file stored at `keyPath`.
  - Automatically created with permissions `0600` (read/write by owner only) inside a directory created with `0700` (rwx by owner only).
  - On POSIX, enforces that existing key files are regular files, owned by the current `uid`, and not group- or world-readable (`chmod 0600`).
- **Initialization Vector**: Random 12-byte IV generated per encryption invocation.
- **Wire / Storage Format**: `v1.<iv>.<tag>.<ciphertext>` where `<iv>`, `<tag>` (16-byte auth tag), and `<ciphertext>` are base64url-encoded segments.
- **Tamper Detection**: Throws if ciphertext, IV, auth tag, or key is corrupted or mismatched.
- **Identifier**: `id = 'aes-gcm-file'`.

### `SafeStorageCipher` / `createSafeStorageCipher(backend)`
- Wraps an Electron-compatible `safeStorage` backend (`{ isEncryptionAvailable(): boolean; encryptString(s): Buffer; decryptString(b: Buffer): string }`).
- Throws on construction if encryption is unavailable on the host system.
- **Format**: `ss1.<base64url>`.
- **Identifier**: `id = 'safe-storage'`.

## Helpers

- `isEncrypted(value: unknown): boolean`: Returns `true` if `value` is a valid encrypted string matching either `v1.<iv>.<tag>.<ciphertext>` or `ss1.<base64url>`.

## Usage

```typescript
import { createFileCipher, isEncrypted } from '@your-bot/secrets';

const cipher = createFileCipher({
  keyPath: '/home/user/.your-bot/secrets/master.key',
});

// Encrypt plaintext
const encrypted = cipher.encrypt('sk-ant-api03-...');
console.log(isEncrypted(encrypted)); // true
console.log(encrypted); // v1.<iv>.<tag>.<ciphertext>

// Decrypt
const decrypted = cipher.decrypt(encrypted);
console.log(decrypted); // 'sk-ant-api03-...'
```
