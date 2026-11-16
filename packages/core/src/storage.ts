import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  AnyCommandResult, AppSettingsV2, Bot, ChatMessage, DesktopEventV2, EventPayloadV2, GrantAuditEntry, JsonValue, McpServerConfig, MemoryEntry,
  OwnerNotification, Principal, PrincipalV2, Routine, RoutineRun, SessionV2, StandingGrant,
} from '@your-bot/contracts';
import { GatewayError } from './validation.js';
import { isSealed, SecretBox, type Sealed } from './secrets.js';
import { eventVersion } from './versioning.js';

/** Secrets of one bot, stored apart from the bot JSON: serverId -> env/header name -> sealed value. */
type BotSecrets = Record<string, { env?: Record<string, Sealed>; headers?: Record<string, Sealed> }>;

type Row = Record<string, string | number | null>;
export class Store {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly box: SecretBox;
  constructor(path: string, box: SecretBox = new SecretBox()) {
    this.box = box;
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
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS sealed_secrets (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, owner TEXT NOT NULL, default_agent TEXT, value TEXT NOT NULL, secrets TEXT NOT NULL DEFAULT '{}');
      CREATE UNIQUE INDEX IF NOT EXISTS bots_default ON bots(owner, default_agent) WHERE default_agent IS NOT NULL;
      CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, owner TEXT NOT NULL, bot_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS grants_bot ON grants(owner, bot_id);
      CREATE TABLE IF NOT EXISTS audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, bot_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_owner ON audit(owner, sequence);
      CREATE TABLE IF NOT EXISTS adapter_state (owner TEXT NOT NULL, session_id TEXT NOT NULL, adapter_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(owner, session_id, adapter_id));
      CREATE TABLE IF NOT EXISTS memory (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, bot_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_bot ON memory(owner, bot_id, seq);
      CREATE TABLE IF NOT EXISTS archived_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, session_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS archived_session ON archived_messages(owner, session_id, seq);
      CREATE TABLE IF NOT EXISTS routines (id TEXT PRIMARY KEY, owner TEXT NOT NULL, bot_id TEXT NOT NULL, anchor INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS routine_runs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, routine_id TEXT NOT NULL, status TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS routine_runs_routine ON routine_runs(routine_id, seq);
      CREATE INDEX IF NOT EXISTS routine_runs_status ON routine_runs(status);
      CREATE TABLE IF NOT EXISTS notifications (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS notifications_owner ON notifications(owner, acknowledged, seq);`);
    // v2: events may target one principal (snapshots, replays) instead of every subscriber of the owner.
    const columns = (this.db.prepare('PRAGMA table_info(events)').all() as Row[]).map(row => row.name);
    if (!columns.includes('target')) this.db.exec('ALTER TABLE events ADD COLUMN target TEXT');
    // v2: events that must not reach v1 subscribers although their type is a v1 type
    // (e.g. permission.resolved for an mcp.call request).
    if (!columns.includes('v2_only')) this.db.exec('ALTER TABLE events ADD COLUMN v2_only INTEGER NOT NULL DEFAULT 0');
    // Windows has no POSIX modes (always reports 0666); there the per-user data directory's inherited
    // ACL is the protection (see docs/security.md). Ownership/regular-file/link checks still apply.
    if (this.path !== ':memory:' && process.platform !== 'win32' && (statSync(this.path).mode & 0o077)) throw new GatewayError('UNSAFE_DATABASE', 'Database permissions must be owner only');
  }
  bindLocalIdentity(id: string): void {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('localIdentity') as Row | undefined;
    if (row && row.value !== id) throw new GatewayError('IDENTITY_MISMATCH', 'Database belongs to a different local identity');
    this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)').run('localIdentity', id);
  }
  bind(principal: Principal | PrincipalV2): void {
    const row = this.db.prepare('SELECT kind FROM principals WHERE id=?').get(principal.id) as Row | undefined;
    if (row && row.kind !== principal.kind) throw new GatewayError('IDENTITY_MISMATCH', 'Principal kind cannot change');
    this.db.prepare('INSERT OR IGNORE INTO principals(id,kind) VALUES (?,?)').run(principal.id, principal.kind);
  }
  getSession(id: string, owner: string): SessionV2 {
    const row = this.db.prepare('SELECT value FROM sessions WHERE id=? AND owner=?').get(id, owner) as Row | undefined;
    if (!row) throw new GatewayError('NOT_FOUND', 'Session not found');
    return JSON.parse(row.value as string) as SessionV2;
  }
  sessions(owner: string): SessionV2[] {
    return (this.db.prepare('SELECT value FROM sessions WHERE owner=? ORDER BY rowid').all(owner) as Row[]).map(row => JSON.parse(row.value as string) as SessionV2);
  }
  /** Every stored session with its owner (startup migration only). */
  allSessions(): {owner: string; session: SessionV2}[] {
    return (this.db.prepare('SELECT owner,value FROM sessions ORDER BY rowid').all() as Row[]).map(row => ({ owner: row.owner as string, session: JSON.parse(row.value as string) as SessionV2 }));
  }
  saveSession(owner: string, session: SessionV2): void {
    this.db.prepare('INSERT INTO sessions(id,owner,value) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value WHERE sessions.owner=excluded.owner').run(session.id, owner, JSON.stringify(session));
  }
  deleteSession(id: string, owner: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM sessions WHERE id=? AND owner=?').run(id, owner);
      this.db.prepare('DELETE FROM adapter_state WHERE session_id=? AND owner=?').run(id, owner);
      this.db.prepare('DELETE FROM archived_messages WHERE session_id=? AND owner=?').run(id, owner);
    });
  }
  settings(owner: string): AppSettingsV2 {
    const row = this.db.prepare('SELECT value FROM settings WHERE owner=?').get(owner) as Row | undefined;
    if (!row) return { providers: [] };
    const stored = JSON.parse(row.value as string) as {providers: (Record<string, unknown>)[]};
    return { providers: stored.providers.map(provider => {
      const { apiKeySealed, ...rest } = provider;
      return (isSealed(apiKeySealed) ? { ...rest, apiKey: this.box.open(apiKeySealed) } : rest) as unknown as AppSettingsV2['providers'][number];
    }) };
  }
  saveSettings(owner: string, settings: AppSettingsV2): void {
    // Without a cipher the v1 plaintext format is kept unchanged; with one, keys are sealed.
    const stored = this.box.cipher ? { providers: settings.providers.map(({ apiKey, ...rest }) => apiKey === undefined ? rest : { ...rest, apiKeySealed: this.box.seal(apiKey) }) } : settings;
    this.db.prepare('INSERT INTO settings(owner,value) VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET value=excluded.value').run(owner, JSON.stringify(stored));
  }
  secrets(): string[] {
    const plain = (this.db.prepare('SELECT value FROM secrets').all() as Row[]).map(row => row.value as string);
    const sealed = (this.db.prepare('SELECT value FROM sealed_secrets').all() as Row[]).map(row => this.box.open(JSON.parse(row.value as string) as Sealed));
    return [...new Set([...plain, ...sealed])];
  }
  rememberSecret(value: string): void {
    if (this.box.cipher) this.db.prepare('INSERT INTO sealed_secrets(value) VALUES (?)').run(JSON.stringify(this.box.seal(value)));
    else this.db.prepare('INSERT OR IGNORE INTO secrets(value) VALUES (?)').run(value);
  }
  /**
   * With a cipher configured, rewrite every plaintext secret (provider keys, redaction registry,
   * MCP env/header values) as ciphertext, then VACUUM so no plaintext remains in the file.
   * Encrypted values without the matching cipher fail closed on read.
   */
  migrateSecrets(): boolean {
    if (!this.box.cipher) {
      // Fail closed early when encrypted data exists but no cipher was supplied.
      this.secrets(); for (const row of this.db.prepare('SELECT owner FROM settings').all() as Row[]) this.settings(row.owner as string);
      return false;
    }
    let changed = false;
    this.transaction(() => {
      for (const row of this.db.prepare('SELECT owner,value FROM settings').all() as Row[]) {
        const stored = JSON.parse(row.value as string) as {providers: Record<string, unknown>[]};
        if (stored.providers.some(provider => typeof provider.apiKey === 'string')) { this.saveSettings(row.owner as string, this.settings(row.owner as string)); changed = true; }
      }
      for (const row of this.db.prepare('SELECT value FROM secrets').all() as Row[]) {
        this.db.prepare('INSERT INTO sealed_secrets(value) VALUES (?)').run(JSON.stringify(this.box.seal(row.value as string))); changed = true;
      }
      this.db.exec('DELETE FROM secrets');
      for (const row of this.db.prepare('SELECT id,secrets FROM bots').all() as Row[]) {
        const secrets = JSON.parse(row.secrets as string) as BotSecrets; let stale = false;
        for (const server of Object.values(secrets)) for (const map of [server.env, server.headers]) for (const [key, sealed] of Object.entries(map ?? {})) {
          if (this.box.stale(sealed)) { map![key] = this.box.seal(this.box.open(sealed)); stale = true; }
        }
        if (stale) { this.db.prepare('UPDATE bots SET secrets=? WHERE id=?').run(JSON.stringify(secrets), row.id); changed = true; }
      }
      for (const row of this.db.prepare('SELECT value FROM sealed_secrets').all() as Row[]) this.box.open(JSON.parse(row.value as string) as Sealed);
    });
    if (changed && this.path !== ':memory:') this.db.exec('VACUUM');
    return changed;
  }
  private depth = 0;
  /** Synchronous, re-entrant transaction (nested calls join the outer one). */
  transaction<T>(body: () => T): T {
    if (this.depth) { this.depth++; try { return body(); } finally { this.depth--; } }
    this.db.exec('BEGIN IMMEDIATE'); this.depth = 1;
    try { const result = body(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.depth = 0; }
  }

  /* ---------------------------------------------------------------- bots */
  /** Bot with plaintext MCP secrets (core-internal use only; never emit directly). */
  private readBot(row: Row): Bot {
    const bot = JSON.parse(row.value as string) as Bot; const secrets = JSON.parse(row.secrets as string) as BotSecrets;
    bot.mcpServers = bot.mcpServers.map(server => {
      const stored = secrets[server.id];
      if (server.transport === 'stdio' && stored?.env) return { ...server, env: Object.fromEntries(Object.entries(stored.env).map(([key, value]) => [key, this.box.open(value)])) };
      if (server.transport === 'http' && stored?.headers) return { ...server, headers: Object.fromEntries(Object.entries(stored.headers).map(([key, value]) => [key, this.box.open(value)])) };
      return server;
    });
    return bot;
  }
  getBot(id: string, owner: string): Bot {
    const row = this.db.prepare('SELECT value,secrets FROM bots WHERE id=? AND owner=?').get(id, owner) as Row | undefined;
    if (!row) throw new GatewayError('NOT_FOUND', 'Bot not found');
    return this.readBot(row);
  }
  findBot(id: string, owner: string): Bot | undefined { try { return this.getBot(id, owner); } catch { return undefined; } }
  botOwners(): string[] { return (this.db.prepare('SELECT DISTINCT owner FROM bots').all() as Row[]).map(row => row.owner as string); }
  bots(owner: string): Bot[] { return (this.db.prepare('SELECT value,secrets FROM bots WHERE owner=? ORDER BY rowid').all(owner) as Row[]).map(row => this.readBot(row)); }
  defaultBot(owner: string, agentId: string): Bot | undefined {
    const row = this.db.prepare('SELECT value,secrets FROM bots WHERE owner=? AND default_agent=?').get(owner, agentId) as Row | undefined;
    return row ? this.readBot(row) : undefined;
  }
  isDefaultBot(id: string): boolean { return !!(this.db.prepare('SELECT 1 AS x FROM bots WHERE id=? AND default_agent IS NOT NULL').get(id) as Row | undefined); }
  saveBot(owner: string, bot: Bot, defaultAgent?: string): void {
    const secrets: BotSecrets = {};
    const servers: McpServerConfig[] = bot.mcpServers.map(server => {
      if (server.transport === 'stdio' && server.env) {
        secrets[server.id] = { env: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, this.box.seal(value)])) };
        return { ...server, env: Object.fromEntries(Object.keys(server.env).map(key => [key, ''])) };
      }
      if (server.transport === 'http' && server.headers) {
        secrets[server.id] = { headers: Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, this.box.seal(value)])) };
        return { ...server, headers: Object.fromEntries(Object.keys(server.headers).map(key => [key, ''])) };
      }
      return server;
    });
    const value = JSON.stringify({ ...bot, mcpServers: servers });
    this.db.prepare('INSERT INTO bots(id,owner,default_agent,value,secrets) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, secrets=excluded.secrets WHERE bots.owner=excluded.owner')
      .run(bot.id, owner, defaultAgent ?? null, value, JSON.stringify(secrets));
  }
  deleteBot(id: string, owner: string): void { this.db.prepare('DELETE FROM bots WHERE id=? AND owner=?').run(id, owner); }

  /* -------------------------------------------------------------- grants */
  grants(owner: string, botId?: string): StandingGrant[] {
    const rows = (botId ? this.db.prepare('SELECT value FROM grants WHERE owner=? AND bot_id=? ORDER BY rowid').all(owner, botId) : this.db.prepare('SELECT value FROM grants WHERE owner=? ORDER BY rowid').all(owner)) as Row[];
    return rows.map(row => JSON.parse(row.value as string) as StandingGrant);
  }
  getGrant(id: string, owner: string): StandingGrant {
    const row = this.db.prepare('SELECT value FROM grants WHERE id=? AND owner=?').get(id, owner) as Row | undefined;
    if (!row) throw new GatewayError('NOT_FOUND', 'Grant not found');
    return JSON.parse(row.value as string) as StandingGrant;
  }
  saveGrant(owner: string, grant: StandingGrant): void {
    this.db.prepare('INSERT INTO grants(id,owner,bot_id,value) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value WHERE grants.owner=excluded.owner').run(grant.id, owner, grant.botId, JSON.stringify(grant));
  }

  /* --------------------------------------------------------------- audit */
  appendAudit(owner: string, entry: GrantAuditEntry): void {
    this.db.prepare('INSERT INTO audit(id,owner,bot_id,value) VALUES (?,?,?,?)').run(entry.id, owner, entry.botId, JSON.stringify(entry));
  }
  audit(owner: string, options: {botId?: string; limit: number; beforeId?: string}): GrantAuditEntry[] {
    let before = Number.MAX_SAFE_INTEGER;
    if (options.beforeId !== undefined) {
      const row = this.db.prepare('SELECT sequence FROM audit WHERE id=? AND owner=?').get(options.beforeId, owner) as Row | undefined;
      if (!row) throw new GatewayError('INVALID_CURSOR', 'Audit cursor not found');
      before = Number(row.sequence);
    }
    const rows = (options.botId
      ? this.db.prepare('SELECT value FROM audit WHERE owner=? AND bot_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?').all(owner, options.botId, before, options.limit)
      : this.db.prepare('SELECT value FROM audit WHERE owner=? AND sequence<? ORDER BY sequence DESC LIMIT ?').all(owner, before, options.limit)) as Row[];
    return rows.map(row => JSON.parse(row.value as string) as GrantAuditEntry);
  }

  /* -------------------------------------------------------------- memory */
  /** Newest first. */
  memory(owner: string, botId: string): MemoryEntry[] {
    return (this.db.prepare('SELECT value FROM memory WHERE owner=? AND bot_id=? ORDER BY seq DESC').all(owner, botId) as Row[]).map(row => JSON.parse(row.value as string) as MemoryEntry);
  }
  memoryCount(owner: string, botId: string): number { return Number((this.db.prepare('SELECT COUNT(*) AS n FROM memory WHERE owner=? AND bot_id=?').get(owner, botId) as Row).n); }
  addMemory(owner: string, entry: MemoryEntry): void { this.db.prepare('INSERT INTO memory(id,owner,bot_id,value) VALUES (?,?,?,?)').run(entry.id, owner, entry.botId, JSON.stringify(entry)); }
  deleteMemory(owner: string, botId: string, id: string): boolean { return Number(this.db.prepare('DELETE FROM memory WHERE owner=? AND bot_id=? AND id=?').run(owner, botId, id).changes) > 0; }
  deleteBotMemory(owner: string, botId: string): void { this.db.prepare('DELETE FROM memory WHERE owner=? AND bot_id=?').run(owner, botId); }

  /* --------------------------------------------------------- compaction */
  /** Moves `archived` to the archive table and saves the compacted session, atomically. */
  compactSession(owner: string, session: SessionV2, archived: ChatMessage[]): void {
    this.transaction(() => {
      const insert = this.db.prepare('INSERT INTO archived_messages(owner,session_id,value) VALUES (?,?,?)');
      for (const message of archived) insert.run(owner, session.id, JSON.stringify(message));
      this.saveSession(owner, session);
    });
  }
  archivedMessages(owner: string, sessionId: string): ChatMessage[] {
    return (this.db.prepare('SELECT value FROM archived_messages WHERE owner=? AND session_id=? ORDER BY seq').all(owner, sessionId) as Row[]).map(row => JSON.parse(row.value as string) as ChatMessage);
  }

  /* ------------------------------------------------------------ routines */
  routines(owner?: string): {owner: string; routine: Routine; anchor: number}[] {
    const rows = (owner === undefined ? this.db.prepare('SELECT owner,anchor,value FROM routines ORDER BY rowid').all() : this.db.prepare('SELECT owner,anchor,value FROM routines WHERE owner=? ORDER BY rowid').all(owner)) as Row[];
    return rows.map(row => ({ owner: row.owner as string, anchor: Number(row.anchor), routine: JSON.parse(row.value as string) as Routine }));
  }
  getRoutine(id: string, owner: string): {routine: Routine; anchor: number} {
    const row = this.db.prepare('SELECT anchor,value FROM routines WHERE id=? AND owner=?').get(id, owner) as Row | undefined;
    if (!row) throw new GatewayError('NOT_FOUND', 'Routine not found');
    return { routine: JSON.parse(row.value as string) as Routine, anchor: Number(row.anchor) };
  }
  findRoutine(id: string, owner: string): {routine: Routine; anchor: number} | undefined { try { return this.getRoutine(id, owner); } catch { return undefined; } }
  saveRoutine(owner: string, routine: Routine, anchor: number): void {
    this.db.prepare('INSERT INTO routines(id,owner,bot_id,anchor,value) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET bot_id=excluded.bot_id, anchor=excluded.anchor, value=excluded.value WHERE routines.owner=excluded.owner')
      .run(routine.id, owner, routine.botId, anchor, JSON.stringify(routine));
  }
  deleteRoutine(id: string, owner: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM routine_runs WHERE routine_id=? AND owner=?').run(id, owner);
      this.db.prepare('DELETE FROM routines WHERE id=? AND owner=?').run(id, owner);
    });
  }
  saveRun(owner: string, run: RoutineRun): void {
    this.db.prepare('INSERT INTO routine_runs(id,owner,routine_id,status,value) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, value=excluded.value WHERE routine_runs.owner=excluded.owner')
      .run(run.id, owner, run.routineId, run.status, JSON.stringify(run));
  }
  getRun(id: string): {owner: string; run: RoutineRun} | undefined {
    const row = this.db.prepare('SELECT owner,value FROM routine_runs WHERE id=?').get(id) as Row | undefined;
    return row ? { owner: row.owner as string, run: JSON.parse(row.value as string) as RoutineRun } : undefined;
  }
  /** Newest first. */
  runs(owner: string, routineId: string, limit: number): RoutineRun[] {
    return (this.db.prepare('SELECT value FROM routine_runs WHERE owner=? AND routine_id=? ORDER BY seq DESC LIMIT ?').all(owner, routineId, limit) as Row[]).map(row => JSON.parse(row.value as string) as RoutineRun);
  }
  /** Runs in the given statuses, oldest first (every owner when `owner` is undefined). */
  runsWithStatus(statuses: string[], owner?: string): {owner: string; run: RoutineRun}[] {
    const marks = statuses.map(() => '?').join(',');
    const rows = (owner === undefined
      ? this.db.prepare(`SELECT owner,value FROM routine_runs WHERE status IN (${marks}) ORDER BY seq`).all(...statuses)
      : this.db.prepare(`SELECT owner,value FROM routine_runs WHERE owner=? AND status IN (${marks}) ORDER BY seq`).all(owner, ...statuses)) as Row[];
    return rows.map(row => ({ owner: row.owner as string, run: JSON.parse(row.value as string) as RoutineRun }));
  }
  /** Newest finished runs of an owner. */
  recentRuns(owner: string, excluded: string[], limit: number): RoutineRun[] {
    const marks = excluded.map(() => '?').join(',');
    return (this.db.prepare(`SELECT value FROM routine_runs WHERE owner=? AND status NOT IN (${marks}) ORDER BY seq DESC LIMIT ?`).all(owner, ...excluded, limit) as Row[]).map(row => JSON.parse(row.value as string) as RoutineRun);
  }

  /* ------------------------------------------------------- notifications */
  addNotification(owner: string, notification: OwnerNotification): void {
    this.db.prepare('INSERT INTO notifications(id,owner,acknowledged,value) VALUES (?,?,0,?)').run(notification.id, owner, JSON.stringify(notification));
  }
  /** Unacknowledged, newest first. */
  notifications(owner: string, limit: number): OwnerNotification[] {
    return (this.db.prepare('SELECT value FROM notifications WHERE owner=? AND acknowledged=0 ORDER BY seq DESC LIMIT ?').all(owner, limit) as Row[]).map(row => JSON.parse(row.value as string) as OwnerNotification);
  }
  getNotification(id: string, owner: string): OwnerNotification {
    const row = this.db.prepare('SELECT value FROM notifications WHERE id=? AND owner=?').get(id, owner) as Row | undefined;
    if (!row) throw new GatewayError('NOT_FOUND', 'Notification not found');
    return JSON.parse(row.value as string) as OwnerNotification;
  }
  acknowledgeNotification(owner: string, notification: OwnerNotification): void {
    this.db.prepare('UPDATE notifications SET acknowledged=1, value=? WHERE id=? AND owner=?').run(JSON.stringify(notification), notification.id, owner);
  }

  /* ------------------------------------------------------- adapter state */
  adapterState(owner: string, sessionId: string, adapterId: string): JsonValue | undefined {
    const row = this.db.prepare('SELECT value FROM adapter_state WHERE owner=? AND session_id=? AND adapter_id=?').get(owner, sessionId, adapterId) as Row | undefined;
    return row ? JSON.parse(row.value as string) as JsonValue : undefined;
  }
  saveAdapterState(owner: string, sessionId: string, adapterId: string, value: string): void {
    this.db.prepare('INSERT INTO adapter_state(owner,session_id,adapter_id,value) VALUES (?,?,?,?) ON CONFLICT(owner,session_id,adapter_id) DO UPDATE SET value=excluded.value').run(owner, sessionId, adapterId, value);
  }
  clearAdapterState(owner: string, sessionId: string, adapterId: string): void {
    this.db.prepare('DELETE FROM adapter_state WHERE owner=? AND session_id=? AND adapter_id=?').run(owner, sessionId, adapterId);
  }
  metadata(key: string): string | undefined { return (this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as Row | undefined)?.value as string | undefined; }
  setMetadata(key: string, value: string): void { this.db.prepare('INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }

  /* -------------------------------------------------------------- events */
  lastSequence(owner: string): number { return Number((this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS seq FROM events WHERE owner=?').get(owner) as Row).seq); }
  /** `target` restricts delivery and replay to one principal id (principal-specific snapshots). */
  append(owner: string, payload: EventPayloadV2, timestamp: string, target?: string, v2Only = false): DesktopEventV2 {
    return this.transaction(() => {
      const id = Number(this.db.prepare('INSERT INTO events(owner,value,target,v2_only) VALUES (?,?,?,?)').run(owner, '{}', target ?? null, v2Only ? 1 : 0).lastInsertRowid);
      const event = { ...payload, version: eventVersion(payload.type), sequence: id, timestamp, principalId: owner } as DesktopEventV2;
      if (event.type === 'state.snapshot') event.snapshot.lastSequence = id;
      this.db.prepare('UPDATE events SET value=? WHERE sequence=?').run(JSON.stringify(event), id);
      return event;
    });
  }
  replay(owner: string, after: number, principalId: string = owner): {event: DesktopEventV2; v2Only: boolean}[] {
    return (this.db.prepare('SELECT value,v2_only FROM events WHERE owner=? AND sequence>? AND (target IS NULL OR target=?) ORDER BY sequence').all(owner, after, principalId) as Row[])
      .map(row => ({ event: JSON.parse(row.value as string) as DesktopEventV2, v2Only: row.v2_only === 1 }));
  }
  command(owner: string, id: string): {fingerprint: string; result: AnyCommandResult} | undefined {
    const row = this.db.prepare('SELECT fingerprint,value FROM commands WHERE owner=? AND id=?').get(owner, id) as Row | undefined;
    return row ? { fingerprint: row.fingerprint as string, result: JSON.parse(row.value as string) as AnyCommandResult } : undefined;
  }
  saveCommand(owner: string, id: string, fingerprint: string, result: AnyCommandResult): void {
    this.db.prepare('INSERT INTO commands(owner,id,fingerprint,value) VALUES (?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET value=excluded.value').run(owner, id, fingerprint, JSON.stringify(result));
  }
  startTask(id: string, owner: string, sessionId: string): void { this.db.prepare('INSERT INTO tasks(id,owner,session_id,active) VALUES (?,?,?,1)').run(id, owner, sessionId); }
  finishTask(id: string): void { this.db.prepare('UPDATE tasks SET active=0 WHERE id=?').run(id); }
  interruptedTasks(): {id: string; owner: string; sessionId: string}[] {
    return (this.db.prepare('SELECT id,owner,session_id FROM tasks WHERE active=1').all() as Row[]).map(row => ({ id: row.id as string, owner: row.owner as string, sessionId: row.session_id as string }));
  }
  close(): void { this.db.close(); }
}
