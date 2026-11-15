/**
 * Wire protocol `yourbot-remote/1` (see README). JSON text frames over TLS WebSocket.
 * Server→client: challenge, paired, ready, result, event, error.
 * Client→server: pair | auth (exactly one, before anything else), then command frames.
 */
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { CapabilityV2, CommandResultV2, DesktopCommandV2, DesktopEventV2 } from '@your-bot/contracts';
import { normalizeFingerprint } from './certificate.js';

export const PROTOCOL = 'yourbot-remote/1';
export const WS_PATH = '/ws';
export const MAX_FRAME_BYTES = 1024 * 1024;
export const PAIRING_PREFIX = 'ybp1.';

/** Every v2 capability. Defaults for a paired device exclude settings, library.install and network. */
export const ALL_CAPABILITIES_V2: readonly CapabilityV2[] = ['conversation', 'settings', 'tool.execute', 'file.read', 'file.write', 'file.delete', 'library.install', 'network', 'process.spawn', 'mcp.call'];
export const DEFAULT_DEVICE_CAPABILITIES: readonly CapabilityV2[] = ALL_CAPABILITIES_V2.filter(c => c !== 'settings' && c !== 'library.install' && c !== 'network');

/** Close codes (4000–4999 are application defined). */
export const CLOSE = {
  normal: 1000, tooBig: 1009, tryAgain: 1013,
  authFailed: 4001, authTimeout: 4002, revoked: 4003, protocol: 4008, tooManyConnections: 4009, slowConsumer: 4010, shutdown: 4011,
} as const;
/** Clients must not reconnect after these. */
export const PERMANENT_CLOSE_CODES: ReadonlySet<number> = new Set([CLOSE.authFailed, CLOSE.revoked, CLOSE.protocol]);

export type ServerFrame =
  | { t: 'challenge'; protocol: typeof PROTOCOL; hostId: string; fp: string; nonce: string }
  | { t: 'paired'; deviceId: string; hostId: string; hostName: string; capabilities: CapabilityV2[] }
  | { t: 'ready'; deviceId: string; hostId: string; hostName: string; principalId: string; capabilities: CapabilityV2[] }
  | { t: 'result'; id: string; result: CommandResultV2 }
  | { t: 'event'; event: DesktopEventV2 }
  | { t: 'error'; code: string; message: string };
export type ClientFrame =
  | { t: 'pair'; secret: string; name: string; publicKey: string }
  | { t: 'auth'; deviceId: string; signature: string }
  | { t: 'command'; command: DesktopCommandV2 };

/** Exact bytes a device signs to authenticate one connection. */
export function authMessage(hostId: string, fingerprint: string, nonce: string): Buffer {
  return Buffer.from(`yourbot-auth-v1|${hostId}|${fingerprint}|${nonce}`, 'utf8');
}
export function verifyAuth(publicKey: KeyObject, hostId: string, fingerprint: string, nonce: string, signature: string): boolean {
  const bytes = Buffer.from(signature, 'base64url');
  if (bytes.length !== 64) return false;
  try { return verify(null, authMessage(hostId, fingerprint, nonce), publicKey, bytes); } catch { return false; }
}
/** Parses a device public key (base64url SPKI DER); only Ed25519 is accepted. */
export function parseDevicePublicKey(value: string): KeyObject {
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(value)) throw new Error('Invalid public key');
  const key = createPublicKey({ key: Buffer.from(value, 'base64url'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Device key must be Ed25519');
  return key;
}

export interface PairingPayload { v: 1; urls: string[]; fp: string; secret: string; }
export function encodePairingCode(payload: PairingPayload): string {
  return PAIRING_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}
export function decodePairingCode(code: string): PairingPayload {
  const trimmed = code.trim();
  if (!trimmed.startsWith(PAIRING_PREFIX) || trimmed.length > 4096) throw new Error('Not a Your Bot pairing code');
  let value: unknown;
  try { value = JSON.parse(Buffer.from(trimmed.slice(PAIRING_PREFIX.length), 'base64url').toString('utf8')); }
  catch { throw new Error('Malformed pairing code'); }
  const v = value as Partial<PairingPayload> | null;
  if (!v || typeof v !== 'object' || v.v !== 1 || typeof v.fp !== 'string' || typeof v.secret !== 'string' || !Array.isArray(v.urls) || !v.urls.length || v.urls.length > 16) throw new Error('Malformed pairing code');
  if (!/^[A-Za-z0-9_-]{22}$/.test(v.secret)) throw new Error('Malformed pairing secret');
  const urls = v.urls.map(url => {
    if (typeof url !== 'string') throw new Error('Malformed pairing URL');
    const parsed = new URL(url);
    if (parsed.protocol !== 'wss:' || parsed.username || parsed.password) throw new Error('Pairing URLs must be wss:// without credentials');
    return parsed.href;
  });
  return { v: 1, urls, fp: normalizeFingerprint(v.fp), secret: v.secret };
}
