import type { SecretCipher } from '@your-bot/contracts';
import { GatewayError } from './validation.js';

/** Stored representation of one secret value: ciphertext tagged with its cipher id, or legacy plaintext. */
export type Sealed = { c: string; v: string } | { p: string };

/**
 * Seals secrets for storage. With a cipher every value is encrypted; without one values stay
 * plaintext (v1 behaviour, documented as not encrypted at rest). Opening ciphertext requires the
 * same cipher id: a missing or different cipher fails closed instead of losing or exposing data.
 */
export class SecretBox {
  constructor(readonly cipher?: SecretCipher) {
    if (cipher) {
      if (typeof cipher.id !== 'string' || !cipher.id || cipher.id.length > 128) throw new GatewayError('INVALID_INPUT', 'Invalid secret cipher id');
      if (typeof cipher.encrypt !== 'function' || typeof cipher.decrypt !== 'function') throw new GatewayError('INVALID_INPUT', 'Invalid secret cipher');
    }
  }
  seal(plaintext: string): Sealed {
    if (!this.cipher) return { p: plaintext };
    const v = this.cipher.encrypt(plaintext);
    if (typeof v !== 'string' || (plaintext.length >= 4 && v.includes(plaintext))) throw new GatewayError('SECRET_CIPHER_FAILED', 'Secret cipher produced invalid ciphertext');
    return { c: this.cipher.id, v };
  }
  open(sealed: Sealed): string {
    if ('p' in sealed) return sealed.p;
    if (!this.cipher) throw new GatewayError('SECRET_CIPHER_REQUIRED', 'Stored secrets are encrypted; configure the secret cipher');
    if (this.cipher.id !== sealed.c) throw new GatewayError('SECRET_CIPHER_MISMATCH', 'Stored secrets use a different cipher');
    let value: unknown;
    try { value = this.cipher.decrypt(sealed.v); } catch { throw new GatewayError('SECRET_CIPHER_FAILED', 'Stored secret cannot be decrypted'); }
    if (typeof value !== 'string') throw new GatewayError('SECRET_CIPHER_FAILED', 'Stored secret cannot be decrypted');
    return value;
  }
  /** True when a stored value should be rewritten (plaintext while a cipher is configured). */
  stale(sealed: Sealed): boolean { return !!this.cipher && 'p' in sealed; }
}

export function isSealed(value: unknown): value is Sealed {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const object = value as Record<string, unknown>;
  return (keys.length === 1 && typeof object.p === 'string') || (keys.length === 2 && typeof object.c === 'string' && typeof object.v === 'string');
}
