import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AppSettings, CommandResult, DesktopEvent, EventPayload, Principal, Session } from '@your-bot/contracts';
import { GatewayError } from './validation.js';

type Row = Record<string, string | number | null>;
export class Store {
  readonly db: DatabaseSync;
  readonly path: string;
  constructor(path: string) {
    if (path === ':memory:') this.path = path;
    else {
      const requested = resolve(path); const directory = dirname(requested);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const directoryStat = lstatSync(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (process.getuid && directoryStat.uid !== process.getuid())) throw new GatewayError('UNSAFE_DATABASE', 'Database directory must be owned by the current user');
      chmodSync(directory, 0o700);
      this.path = resolve(realpathSync(directory), requested.slice(directory.length + 1));
      const fd = openSync(this.path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) throw new GatewayError('UNSAFE_DATABASE', 'Database must be a private regular file');
        fchmodSync(fd, 0o600);
      } finally { closeSync(fd); }
    }
    this.db = new DatabaseSync(this.path);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY;
      CREATE TABLE IF NOT EXISTS principals (id TEXT PRIMARY KEY, kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, owner TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (owner TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_owner ON events(owner, sequence);
      CREATE TABLE IF NOT EXISTS commands (owner TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(owner,id));
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, session_id TEXT NOT NULL, active INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS secrets (value TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    if (this.path !== ':memory:' && (statSync(this.path).mode & 0o077)) throw new GatewayError('UNSAFE_DATABASE', 'Database permissions must be owner only');
  }
  bindLocalIdentity(id: string): void {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('localIdentity') as Row | undefined;
    if (row && row.value !== id) throw new GatewayError('IDENTITY_MISMATCH', 'Database belongs to a different local identity');
    this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)').run('localIdentity', id);
  }
  bind(principal: Principal): void {
    const row = this.db.prepare('SELECT kind FROM principals WHERE id=?').get(principal.id) as Row | undefined;
    if (row && row.kind !== principal.kind) throw new GatewayError('IDENTITY_MISMATCH', 'Principal kind cannot change');
    this.db.prepare('INSERT OR IGNORE INTO principals(id,kind) VALUES (?,?)').run(principal.id, principal.kind);
  }
  getSession(id: string, owner: string): Session {
    const row = this.db.prepare('SELECT value FROM sessions WHERE id=? AND owner=?').get(id, owner) as Row | undefined;
    if (!row) throw new GatewayError('NOT_FOUND', 'Session not found');
    return JSON.parse(row.value as string) as Session;
  }
  sessions(owner: string): Session[] {
    return (this.db.prepare('SELECT value FROM sessions WHERE owner=? ORDER BY rowid').all(owner) as Row[]).map(row => JSON.parse(row.value as string) as Session);
  }
  saveSession(owner: string, session: Session): void {
    this.db.prepare('INSERT INTO sessions(id,owner,value) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value WHERE sessions.owner=excluded.owner').run(session.id, owner, JSON.stringify(session));
  }
  deleteSession(id: string, owner: string): void { this.db.prepare('DELETE FROM sessions WHERE id=? AND owner=?').run(id, owner); }
  settings(owner: string): AppSettings {
    const row = this.db.prepare('SELECT value FROM settings WHERE owner=?').get(owner) as Row | undefined;
    return row ? JSON.parse(row.value as string) as AppSettings : { providers: [] };
  }
  saveSettings(owner: string, settings: AppSettings): void {
    this.db.prepare('INSERT INTO settings(owner,value) VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET value=excluded.value').run(owner, JSON.stringify(settings));
  }
  secrets(): string[] { return (this.db.prepare('SELECT value FROM secrets').all() as Row[]).map(row => row.value as string); }
  rememberSecret(value: string): void { this.db.prepare('INSERT OR IGNORE INTO secrets(value) VALUES (?)').run(value); }
  lastSequence(owner: string): number { return Number((this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS seq FROM events WHERE owner=?').get(owner) as Row).seq); }
  append(owner: string, payload: EventPayload, timestamp: string): DesktopEvent {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const id = Number(this.db.prepare('INSERT INTO events(owner,value) VALUES (?,?)').run(owner, '{}').lastInsertRowid);
      const event: DesktopEvent = { ...payload, version: 1, sequence: id, timestamp, principalId: owner };
      if (event.type === 'state.snapshot') event.snapshot.lastSequence = id;
      this.db.prepare('UPDATE events SET value=? WHERE sequence=?').run(JSON.stringify(event), id);
      this.db.exec('COMMIT'); return event;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  replay(owner: string, after: number): DesktopEvent[] {
    return (this.db.prepare('SELECT value FROM events WHERE owner=? AND sequence>? ORDER BY sequence').all(owner, after) as Row[]).map(row => JSON.parse(row.value as string) as DesktopEvent);
  }
  command(owner: string, id: string): {fingerprint: string; result: CommandResult} | undefined {
    const row = this.db.prepare('SELECT fingerprint,value FROM commands WHERE owner=? AND id=?').get(owner, id) as Row | undefined;
    return row ? { fingerprint: row.fingerprint as string, result: JSON.parse(row.value as string) as CommandResult } : undefined;
  }
  saveCommand(owner: string, id: string, fingerprint: string, result: CommandResult): void {
    this.db.prepare('INSERT INTO commands(owner,id,fingerprint,value) VALUES (?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET value=excluded.value').run(owner, id, fingerprint, JSON.stringify(result));
  }
  startTask(id: string, owner: string, sessionId: string): void { this.db.prepare('INSERT INTO tasks(id,owner,session_id,active) VALUES (?,?,?,1)').run(id, owner, sessionId); }
  finishTask(id: string): void { this.db.prepare('UPDATE tasks SET active=0 WHERE id=?').run(id); }
  interruptedTasks(): {id: string; owner: string; sessionId: string}[] {
    return (this.db.prepare('SELECT id,owner,session_id FROM tasks WHERE active=1').all() as Row[]).map(row => ({ id: row.id as string, owner: row.owner as string, sessionId: row.session_id as string }));
  }
  close(): void { this.db.close(); }
}
