/** Device registry and pairing offers in a dedicated owner-only SQLite file. */
import { DatabaseSync } from 'node:sqlite';
import { closeSync, constants, fchmodSync, fstatSync, openSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { CapabilityV2, DeviceInfo } from '@your-bot/contracts';

export interface DeviceRecord extends DeviceInfo { publicKey: string; }
export interface PairingRecord { id: string; name?: string; capabilities: CapabilityV2[]; expiresAt: string; }

export const hashSecret = (secret: string): string => createHash('sha256').update(`yourbot-pairing-v1|${secret}`).digest('hex');

export class DeviceStore {
  private readonly db: DatabaseSync;
  readonly hostId: string;
  constructor(readonly path: string) {
    // Create/tighten the file before SQLite opens it; journals inherit the database mode.
    const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try { if (!fstatSync(fd).isFile()) throw new Error('Device store must be a regular file'); fchmodSync(fd, 0o600); }
    finally { closeSync(fd); }
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key TEXT NOT NULL UNIQUE,
        capabilities TEXT NOT NULL, paired_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS pairings(id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE, name TEXT,
        capabilities TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);`);
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('host_id') as { value: string } | undefined;
    if (row) this.hostId = row.value;
    else { this.hostId = randomUUID(); this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('host_id', this.hostId); }
  }
  addPairing(secretHash: string, input: { name?: string; capabilities: CapabilityV2[]; expiresAt: string }): void {
    this.db.prepare('INSERT INTO pairings(id, secret_hash, name, capabilities, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), secretHash, input.name ?? null, JSON.stringify(input.capabilities), input.expiresAt);
  }
  /** Atomically consumes an unexpired, unused offer. Returns undefined on any mismatch. */
  consumePairing(secretHash: string, now: Date): PairingRecord | undefined {
    const row = this.db.prepare('SELECT id, name, capabilities, expires_at FROM pairings WHERE secret_hash = ? AND used_at IS NULL').get(secretHash) as
      { id: string; name: string | null; capabilities: string; expires_at: string } | undefined;
    if (!row) return undefined;
    // Mark used even when expired: a code is single-use regardless of outcome.
    const changed = this.db.prepare('UPDATE pairings SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now.toISOString(), row.id).changes;
    if (Number(changed) !== 1 || Date.parse(row.expires_at) <= now.getTime()) return undefined;
    return { id: row.id, ...(row.name ? { name: row.name } : {}), capabilities: JSON.parse(row.capabilities), expiresAt: row.expires_at };
  }
  pruneExpiredPairings(now: Date): void {
    this.db.prepare('DELETE FROM pairings WHERE expires_at < ?').run(new Date(now.getTime() - 24 * 3600_000).toISOString());
  }
  addDevice(input: { name: string; publicKey: string; capabilities: CapabilityV2[]; pairedAt: string }): DeviceRecord {
    const device: DeviceRecord = { id: randomUUID(), name: input.name, publicKey: input.publicKey, capabilities: input.capabilities, pairedAt: input.pairedAt };
    this.db.prepare('INSERT INTO devices(id, name, public_key, capabilities, paired_at) VALUES (?, ?, ?, ?, ?)')
      .run(device.id, device.name, device.publicKey, JSON.stringify(device.capabilities), device.pairedAt);
    return device;
  }
  getDevice(id: string): DeviceRecord | undefined {
    const row = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as Row | undefined;
    return row && fromRow(row);
  }
  listDevices(): DeviceRecord[] {
    return (this.db.prepare('SELECT * FROM devices ORDER BY paired_at, id').all() as unknown as Row[]).map(fromRow);
  }
  touch(id: string, at: string): void { this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(at, id); }
  revoke(id: string, at: string): boolean {
    const device = this.getDevice(id);
    if (!device) return false;
    if (!device.revokedAt) this.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(at, id);
    return true;
  }
  close(): void { if (this.db.isOpen) this.db.close(); }
}
interface Row { id: string; name: string; public_key: string; capabilities: string; paired_at: string; last_seen_at: string | null; revoked_at: string | null; }
const fromRow = (row: Row): DeviceRecord => ({
  id: row.id, name: row.name, publicKey: row.public_key, capabilities: JSON.parse(row.capabilities), pairedAt: row.paired_at,
  ...(row.last_seen_at ? { lastSeenAt: row.last_seen_at } : {}), ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
});
