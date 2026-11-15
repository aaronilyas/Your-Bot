import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type {
  AgentAdapter, AgentAdapterV2, AgentInfo, AgentRunContextV2, AgentUpdate, AnyCommandResult, AnyDesktopCommand, AppSettingsV2,
  AppSnapshotV2, AuthorizationContext, Bot, BotInput, CapabilityV2, CommandResultV2, ContractVersion, DesktopEvent, DesktopEventV2,
  DeviceManager, EventPayloadV2, ExecutionProfile, GrantAuditEntry, JsonValue, McpBroker, McpBuiltinTool, McpCall, McpProxySession, McpServerConfig,
  MemoryEntry, Notifier, OwnerNotification, PermissionDecision, PermissionDecisionV2, PermissionInputV2, PermissionRequest, PermissionRequestV2,
  Principal, PrincipalV2, Routine, RoutineInput, RoutineRun, SecretCipher, SessionV2, SkillCatalog, SkillInfo, StandingGrant, ToolExecutionContext,
  ToolExecutor, ToolInvocation, ToolResult, Unsubscribe, WorkspaceHost, WorkspaceHostChannel, DesktopCommand, DesktopCommandV2, ChatMessage,
} from '@your-bot/contracts';
import {
  AGENT_MEMORY_LIMIT, bounded, bytes, composeInstructions, fallbackSummary, MEMORY_ENTRIES_LIMIT, memorySection, OWNER_MEMORY_LIMIT, SUMMARY_LIMIT,
} from './continuity.js';
import { BUILTIN_MCP_SERVER, normalizeStandingScope, active, matches, standingForbidden, subject } from './grants.js';
import { checkSchedule, latestOccurrences, nextOccurrence, type ScheduleState } from './schedule.js';
import { createHostChannel, type HostPermission } from './host-channel.js';
import { canonicalDirectory, canonicalPaths, isWithin } from './paths.js';
import { SecretBox } from './secrets.js';
import { Store } from './storage.js';
import { assert, GatewayError, record, stableJson, string, validateCommand, validateInvocation, validateJson, validateToolResult } from './validation.js';
import { CAPABILITIES_V2, validateBotInput, validateCommandV2, validatePermissionInputV2, validatePrincipalV2, validateRoutineInput, validateSettingsV2 } from './validation-v2.js';
import { eventFor, isV1Capability, principalV1, requestV1, sessionV1, settingsV1, snapshotV1 } from './versioning.js';

export type AnyAgentAdapter = AgentAdapter | AgentAdapterV2;
/** Injectable time source for routines (tests use a fake clock). Timers may fire late (sleep); the scheduler detects that. */
export interface GatewayClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface GatewayOptions {
  /** Use a dedicated application-data directory; core enforces 0700 on its parent and 0600 on the DB. */
  databasePath: string;
  /** Only this host-authenticated local identity can read/update provider settings. */
  localPrincipalId?: string;
  adapters?: readonly AnyAgentAdapter[];
  executor: ToolExecutor;
  /** Called on startup and settings updates with credentials. Return replacement adapters to reload. */
  onSettingsChanged?: (settings: AppSettingsV2, context: {signal: AbortSignal}) => Promise<readonly AnyAgentAdapter[] | void> | readonly AnyAgentAdapter[] | void;
  /** Upper bound for waiting on misbehaving injected dependencies during cleanup. */
  cleanupTimeoutMs?: number;
  /** v2: performs authorized workspace file/terminal operations for trusted bots. Closed by the gateway. */
  workspaceHost?: WorkspaceHost;
  /** v2: opens per-task authenticated MCP proxies for trusted bots. Closed by the gateway. */
  mcpBroker?: McpBroker;
  /** v2: remote-host device registry; `device.*` commands are routed to it for the local owner. Not closed by the gateway. */
  devices?: DeviceManager;
  /** v2: encrypts provider API keys, the redaction registry and MCP env/header values at rest. */
  secretCipher?: SecretCipher;
  /** v2: host identity for multi-host clients. Default: a persisted random id and the OS host name. */
  host?: { id: string; name: string };
  /** v2 (P4): global + workspace skills; enabled skill bodies are composed into run instructions. */
  skillCatalog?: SkillCatalog;
  /** v2 (P4): called for every new owner notification (approval required, routine failed/interrupted/skipped). */
  notifier?: Notifier;
  /** v2 (P4): routine scheduler clock. Default: wall clock with real timers. */
  clock?: GatewayClock;
  /** v2 (P4): capabilities of the local-owner principal routines run as. Default: every capability except 'settings'. */
  routineCapabilities?: CapabilityV2[];
  /** v2 (P4): upper bound for `adapter.summarize` during compaction before the deterministic fallback is used. Default 60 s. */
  summarizeTimeoutMs?: number;
}

type Grant = { request: PermissionRequestV2; scope: PermissionDecision['scope']; decidedBy?: string };
type Task = {
  id: string; sessionId: string; owner: string; principal: PrincipalV2; controller: AbortController;
  adapter?: AnyAgentAdapter; text: string; terminal: boolean; grants: Grant[];
  toolQueue: Promise<void>; execution?: ToolExecutionContext; emittedToolError?: ToolResult;
  deltaPending: string; outputPending: Map<string, {stream: 'stdout' | 'stderr' | 'status'; toolCallId: string; text: string}>;
  bot?: Bot; profile: ExecutionProfile; workspace?: string; routineRunId?: string; routineId?: string;
  host?: WorkspaceHostChannel; terminals: Set<string>; mcp?: McpProxySession; released?: Promise<void>;
};
type Settlement = { decidedBy?: string; via: 'interactive' | 'policy'; grantId?: string };
type Pending = {request: PermissionRequestV2; task: Task; retainOnce: boolean; promise: Promise<PermissionDecision>; resolve: (decision: PermissionDecision) => void};
type Listener = { fn: (event: DesktopEventV2 | DesktopEvent) => void; principalId: string; version: ContractVersion };
type AuthorizeOptions = {
  /** Keep `once` grants until the current tool invocation ends (v1 executor/adapter semantics). */
  retainOnce: boolean;
  /** Adapter-originated requests may not carry core-owned detail (command, mcp, routine). */
  origin: 'adapter' | 'core';
  /** Host channel: every path / cwd must lie inside the task workspace. */
  confine?: boolean;
  env?: boolean;
};
type Success = Extract<CommandResultV2, {ok: true}>;

const denied = (message: string): ToolResult => ({ ok: false, error: { code: 'PERMISSION_DENIED', message } });
const clone = <T>(value: T): T => structuredClone(value);
export const ownerOf = (principal: PrincipalV2 | Principal): string => (principal as PrincipalV2).ownerId ?? principal.id;
const ADAPTER_STATE_LIMIT = 64 * 1024;
const MIN_REGISTERED_MCP_SECRET = 8;
const AUDIT_DEFAULT_LIMIT = 50;
const RUNS_DEFAULT_LIMIT = 50;
const SNAPSHOT_RECENT_RUNS = 50;
const SNAPSHOT_NOTIFICATIONS = 100;
const UNFINISHED_RUNS = ['queued', 'running', 'blocked'];
const DEFAULT_KEEP_RECENT = 10;
const DEFAULT_MAX_CATCH_UP = 5;
/** A timer firing later than this after an occurrence (sleep, suspended host) counts the occurrence as missed. */
const LATE_GRACE_MS = 60_000;
/** Timers never wait longer than this, so wall-clock jumps are noticed. */
const MAX_TIMER_MS = 60 * 60_000;
const systemClock: GatewayClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; },
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** MCP env/header values replaced with "" (keys kept), as required for every outgoing bot. */
export function publicBot(bot: Bot): Bot {
  const copy = clone(bot);
  copy.mcpServers = copy.mcpServers.map(server => server.transport === 'stdio'
    ? (server.env ? { ...server, env: Object.fromEntries(Object.keys(server.env).map(key => [key, ''])) } : server)
    : (server.headers ? { ...server, headers: Object.fromEntries(Object.keys(server.headers).map(key => [key, ''])) } : server));
  return copy;
}

export class Gateway {
  private readonly store: Store;
  private readonly localId: string;
  private readonly adapters = new Map<string, AnyAgentAdapter>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly tasks = new Map<string, Task>();
  private readonly pending = new Map<string, Pending>();
  private readonly inFlight = new Map<string, {fingerprint: string; promise: Promise<AnyCommandResult>}>();
  private agents: AgentInfo[] = [];
  private secrets: string[] = [];
  private closed = false;
  private closing?: Promise<void>;
  private settingsBusy = false;
  private readonly lifetime = new AbortController();
  private readonly deletingSessions = new Set<string>();
  private hostInfo = { id: '', name: '' };
  private readonly clock: GatewayClock;
  private readonly routineCapabilities: CapabilityV2[];
  private timer?: unknown;
  private readonly compacting = new Set<string>();
  private readonly background = new Set<Promise<unknown>>();
  private readonly skillCache = new Map<string, SkillInfo[]>();
  constructor(private readonly options: GatewayOptions, private readonly acceptV2: boolean) {
    this.localId = options.localPrincipalId ?? 'local';
    string(this.localId, 'local principal id', 256);
    this.clock = options.clock ?? systemClock;
    assert(typeof this.clock.now === 'function' && typeof this.clock.setTimeout === 'function' && typeof this.clock.clearTimeout === 'function', 'Invalid clock');
    const capabilities = options.routineCapabilities ?? CAPABILITIES_V2.filter(capability => capability !== 'settings');
    assert(Array.isArray(capabilities) && capabilities.every(capability => CAPABILITIES_V2.includes(capability)) && new Set(capabilities).size === capabilities.length, 'Invalid routine capabilities');
    this.routineCapabilities = [...capabilities];
    assert(options.summarizeTimeoutMs === undefined || (Number.isSafeInteger(options.summarizeTimeoutMs) && options.summarizeTimeoutMs > 0), 'Invalid summarize timeout');
    assert(options.cleanupTimeoutMs === undefined || (Number.isSafeInteger(options.cleanupTimeoutMs) && options.cleanupTimeoutMs > 0), 'Invalid cleanup timeout');
    if (options.host !== undefined) { record(options.host, ['id', 'name']); string(options.host.id, 'host id', 256); string(options.host.name, 'host name', 256); }
    const box = new SecretBox(options.secretCipher);
    this.store = new Store(options.databasePath, box);
  }
  async initialize(): Promise<void> {
    this.store.bindLocalIdentity(this.localId);
    this.store.migrateSecrets();
    this.secrets = this.store.secrets();
    if (this.options.host) this.hostInfo = clone(this.options.host);
    else {
      let id = this.store.metadata('hostId');
      if (!id) { id = randomUUID(); this.store.setMetadata('hostId', id); }
      this.hostInfo = { id, name: hostname().slice(0, 256) || 'host' };
    }
    this.setAdapters(this.options.adapters ?? []);
    const settings = this.store.settings(this.localId);
    this.rememberSecrets(settings);
    for (const owner of this.store.botOwners()) for (const bot of this.store.bots(owner)) this.rememberBotSecrets(bot);
    if (this.options.onSettingsChanged) {
      const replacement = await this.dependency(Promise.resolve(this.options.onSettingsChanged(clone(settings), { signal: this.lifetime.signal })));
      if (replacement) await this.replaceAdapters(replacement);
    }
    await this.refreshAgents();
    for (const task of this.store.interruptedTasks()) {
      this.emit(task.owner, { type: 'task.cancelled', taskId: task.id, sessionId: task.sessionId });
      this.store.finishTask(task.id);
    }
    // v2 migration: every session belongs to a bot. Sessions from v1 get the per-agent default bot.
    for (const { owner, session } of this.store.allSessions()) {
      if (session.botId) continue;
      session.botId = this.ensureDefaultBot(owner, session.agentId).id;
      this.store.saveSession(owner, session);
    }
    // Routines: unfinished runs from the previous process are interrupted (never resumed silently),
    // then missed occurrences are handled by each routine's missed-run policy.
    this.recoverRoutines();
    this.tick();
  }
  private setAdapters(adapters: readonly AnyAgentAdapter[]): void {
    const ids = new Set<string>();
    for (const adapter of adapters) {
      string(adapter.id, 'adapter id', 256); assert(!ids.has(adapter.id), 'Duplicate adapter id'); ids.add(adapter.id);
      const profiles = (adapter as AgentAdapterV2).profiles;
      if (profiles !== undefined) assert(Array.isArray(profiles) && profiles.every(profile => profile === 'strict' || profile === 'trusted'), 'Invalid adapter profiles');
    }
    this.adapters.clear(); for (const adapter of adapters) this.adapters.set(adapter.id, adapter);
  }
  private async replaceAdapters(adapters: readonly AnyAgentAdapter[]): Promise<void> {
    const old = [...this.adapters.values()];
    this.setAdapters(adapters);
    await this.cleanup(old.filter(adapter => !adapters.includes(adapter)).map(adapter => () => adapter.close()));
  }

  /* ------------------------------------------------------------ identity */

  /**
   * Validates a host-supplied principal. Local principals must be exactly the configured local id with
   * no ownerId/deviceId. Remote principals never use the local id; their ownerId, if present, must be
   * the local id (paired devices act on the local owner's data).
   */
  private principal(value: Principal | PrincipalV2): PrincipalV2 {
    if (this.closed) throw new GatewayError('CLOSED', 'Gateway is closed');
    const principal = validatePrincipalV2(value);
    if (principal.kind === 'local') {
      if (principal.id !== this.localId || principal.ownerId !== undefined || principal.deviceId !== undefined) throw new GatewayError('IDENTITY_MISMATCH', 'Local identity is reserved for the authenticated local host');
    } else if (principal.id === this.localId || (principal.ownerId !== undefined && principal.ownerId !== this.localId)) {
      throw new GatewayError('IDENTITY_MISMATCH', 'Remote principals cannot claim the local identity or a foreign owner');
    }
    this.store.bind(principal); return principal;
  }
  private isLocalOwner(principal: PrincipalV2): boolean { return principal.kind === 'local' && principal.id === this.localId; }
  private requireLocalOwner(principal: PrincipalV2, what: string): void {
    if (!this.isLocalOwner(principal)) throw new GatewayError('FORBIDDEN', `${what} is local-owner only`);
  }
  private require(principal: PrincipalV2, capability: CapabilityV2): void {
    if (!principal.capabilities.includes(capability)) throw new GatewayError('FORBIDDEN', `Principal cannot request ${capability}`);
  }

  /* -------------------------------------------------------------- secrets */

  private rememberSecret(value: string): void {
    if (value && !this.secrets.includes(value)) { this.secrets.push(value); this.store.rememberSecret(value); }
  }
  private rememberSecrets(settings: AppSettingsV2): void {
    for (const provider of settings.providers) if (provider.apiKey) this.rememberSecret(provider.apiKey);
  }
  /** MCP env/header values are secrets; short values are not registered because they would corrupt ordinary output. */
  private rememberBotSecrets(bot: Bot): void {
    for (const server of bot.mcpServers) {
      const values = server.transport === 'stdio' ? Object.values(server.env ?? {}) : Object.values(server.headers ?? {});
      for (const value of values) if (value.length >= MIN_REGISTERED_MCP_SECRET) this.rememberSecret(value);
    }
  }
  private scrub<T>(value: T): T {
    const structural = new Set(['id', 'type', 'kind', 'version', 'role', 'capability', 'access', 'scope', 'outcome', 'stream', 'principalId', 'sessionId', 'taskId', 'toolCallId', 'commandId', 'requestId', 'agentId', 'modelId', 'createdAt', 'updatedAt', 'timestamp', 'code', 'botId', 'grantId', 'deviceId', 'routineRunId', 'via', 'profile', 'transport']);
    const ordered = [...this.secrets].sort((a, b) => b.length - a.length);
    const clean = (item: unknown, key?: string): unknown => {
      if (typeof item === 'string') {
        if (key && structural.has(key)) return item;
        let text = item;
        for (const secret of ordered) text = text.split(secret).join('[REDACTED]');
        return text;
      }
      if (Array.isArray(item)) return item.map(entry => clean(entry));
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'apiKey').map(([key, entry]) => [key, clean(entry, key)]));
      return item;
    };
    return clean(value) as T;
  }
  private error(error: unknown): {code: string; message: string} {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{1,128}$/.test(error.code)) {
      return this.scrub({ code: error.code, message: error.message.slice(0, 4096), ...('retryable' in error && typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}) });
    }
    return this.scrub(error instanceof GatewayError ? { code: error.code, message: error.message } : { code: 'INTERNAL_ERROR', message: 'Operation failed' });
  }

  /* --------------------------------------------------------------- events */

  /**
   * Persists and delivers an event to every subscriber of `owner` (or only to principal `target`).
   * `v2Only` withholds a v1-typed event from v1 subscribers (e.g. resolution of an mcp.call request).
   */
  private emit(owner: string, payload: EventPayloadV2, target?: string, v2Only = false): DesktopEventV2 {
    const event = this.store.append(owner, this.scrub(payload), new Date().toISOString(), target, v2Only);
    this.deliver(owner, event, target, v2Only); return event;
  }
  private deliver(owner: string, event: DesktopEventV2, target?: string, v2Only = false): void {
    for (const listener of this.listeners.get(owner) ?? []) {
      if (target !== undefined && listener.principalId !== target) continue;
      if (v2Only && listener.version === 1) continue;
      const converted = eventFor(event, listener.version);
      if (!converted) continue;
      try { listener.fn(clone(this.scrub(converted))); } catch { /* Subscribers cannot disrupt persistence or other listeners. */ }
    }
  }
  subscribe(listener: (event: DesktopEventV2) => void, input: Principal | PrincipalV2, options?: {contractVersion?: ContractVersion}): Unsubscribe {
    const principal = this.principal(input); this.require(principal, 'conversation');
    if (typeof listener !== 'function') throw new GatewayError('INVALID_INPUT', 'Listener must be a function');
    if (options !== undefined) record(options, ['contractVersion'], []);
    const version = options?.contractVersion ?? 1;
    if (version !== 1 && !(version === 2 && this.acceptV2)) throw new GatewayError('INVALID_INPUT', 'Unsupported contract version');
    const owner = ownerOf(principal);
    const entry: Listener = { fn: listener as Listener['fn'], principalId: principal.id, version };
    const listeners = this.listeners.get(owner) ?? new Set(); listeners.add(entry); this.listeners.set(owner, listeners);
    return () => { listeners.delete(entry); if (!listeners.size && this.listeners.get(owner) === listeners) this.listeners.delete(owner); };
  }

  /* ------------------------------------------------------------- dispatch */

  async dispatch(input: AnyDesktopCommand, identity: Principal | PrincipalV2): Promise<AnyCommandResult> {
    let id = '';
    try {
      if (input && typeof input.id === 'string' && input.id.length <= 256) id = input.id;
      const principal = this.principal(identity);
      const command: DesktopCommand | DesktopCommandV2 = this.acceptV2 && input && (input as {version?: unknown}).version === 2 ? validateCommandV2(input) : validateCommand(input);
      id = command.id;
      this.authorizeCommand(command, principal);
      const fingerprint = createHash('sha256').update(stableJson(command)).digest('hex');
      const key = JSON.stringify([principal.id, id]); const running = this.inFlight.get(key);
      if (running) {
        if (running.fingerprint !== fingerprint) throw new GatewayError('COMMAND_CONFLICT', 'Command id was already used with different content');
        return clone(this.scrub(await running.promise));
      }
      const saved = this.store.command(principal.id, id);
      if (saved) {
        if (saved.fingerprint !== fingerprint) throw new GatewayError('COMMAND_CONFLICT', 'Command id was already used with different content');
        return clone(this.scrub(saved.result));
      }
      // Persist a receipt before side effects, so a crash never executes the same command twice.
      this.store.saveCommand(principal.id, id, fingerprint, { ok: false, commandId: id, error: { code: 'INTERRUPTED', message: 'Command was interrupted; inspect state before issuing a new command' } });
      const promise = Promise.resolve().then(async () => {
        let result: AnyCommandResult;
        try { result = this.scrub(this.shape(command.version, await this.route(command, principal))); }
        catch (error) { result = { ok: false, commandId: id, error: this.error(error) }; }
        this.store.saveCommand(principal.id, id, fingerprint, result); return result;
      });
      this.inFlight.set(key, { fingerprint, promise });
      try { return clone(this.scrub(await promise)); } finally { this.inFlight.delete(key); }
    } catch (error) { return { ok: false, commandId: id, error: this.error(error) }; }
  }
  /** v1 commands keep v1-shaped results. */
  private shape(version: 1 | 2, result: Success): AnyCommandResult {
    if (version === 2) return result;
    const { snapshot, session, ...rest } = result;
    return { ...rest, ...(snapshot ? { snapshot: snapshotV1(snapshot) } : {}), ...(session ? { session: sessionV1(session) } : {}) } as AnyCommandResult;
  }
  private authorizeCommand(command: DesktopCommand | DesktopCommandV2, principal: PrincipalV2): void {
    switch (command.type) {
      case 'settings.update':
        this.require(principal, 'settings');
        if (!this.isLocalOwner(principal)) throw new GatewayError('FORBIDDEN', 'Provider settings are local-owner only');
        return;
      case 'bot.create': case 'bot.update': case 'bot.delete': case 'grant.create': case 'grant.revoke':
        this.require(principal, 'settings'); return;
      case 'device.pair.start': case 'device.list': case 'device.revoke':
        this.requireLocalOwner(principal, 'Device management'); return;
      case 'memory.add': case 'memory.delete':
        // Memory is owner data: the local owner, or a principal holding `settings`.
        this.require(principal, 'conversation');
        if (!this.isLocalOwner(principal)) this.require(principal, 'settings');
        return;
      case 'routine.create': case 'routine.update': case 'routine.delete': case 'routine.runNow':
        this.require(principal, 'settings'); return;
      default:
        this.require(principal, 'conversation');
        if (command.type === 'tool.run') this.require(principal, 'tool.execute');
    }
  }
  private async snapshot(principal: PrincipalV2): Promise<AppSnapshotV2> {
    const owner = ownerOf(principal);
    let devices: AppSnapshotV2['devices'] = [];
    if (this.isLocalOwner(principal) && this.options.devices) {
      try { devices = clone(await this.dependency(this.options.devices.list())); } catch (error) { if (this.closed) throw error; devices = []; }
    }
    const now = Date.now();
    return this.scrub({
      sessions: this.store.sessions(owner), agents: clone(this.agents),
      settings: this.isLocalOwner(principal) && principal.capabilities.includes('settings') ? this.store.settings(this.localId) : { providers: [] },
      activeTasks: [...this.tasks.values()].filter(task => task.owner === owner && !task.terminal).map(task => ({ id: task.id, sessionId: task.sessionId })),
      pendingPermissions: [...this.pending.values()].filter(pending => pending.task.owner === owner).map(pending => clone(pending.request)),
      lastSequence: this.store.lastSequence(owner),
      bots: this.store.bots(owner).map(publicBot),
      grants: this.store.grants(owner).filter(grant => active(grant, now)),
      routines: this.store.routines(owner).map(entry => entry.routine),
      routineRuns: [...this.store.runsWithStatus(UNFINISHED_RUNS, owner).map(entry => entry.run), ...this.store.recentRuns(owner, UNFINISHED_RUNS, SNAPSHOT_RECENT_RUNS)],
      notifications: this.store.notifications(owner, SNAPSHOT_NOTIFICATIONS),
      skills: await this.skillList(owner).catch(error => { if (this.closed) throw error; return []; }),
      devices, host: clone(this.hostInfo),
    });
  }
  private busy(sessionId: string): boolean { return this.deletingSessions.has(sessionId) || [...this.tasks.values()].some(task => task.sessionId === sessionId && !task.terminal); }
  private availableAgent(id: string, modelId?: string): AnyAgentAdapter {
    const adapter = this.adapters.get(id); const info = this.agents.find(agent => agent.id === id);
    if (!adapter || !info?.available) throw new GatewayError('AGENT_UNAVAILABLE', 'Agent is not available');
    if (modelId && !info.models.some(model => model.id === modelId)) throw new GatewayError('MODEL_UNAVAILABLE', 'Model is not available');
    return adapter;
  }
  private async refreshAgents(agentId?: string): Promise<void> {
    if (agentId && !this.adapters.has(agentId)) throw new GatewayError('NOT_FOUND', 'Agent not found');
    const current = new Map(this.agents.map(info => [info.id, info]));
    for (const adapter of this.adapters.values()) {
      if (agentId && adapter.id !== agentId) continue;
      try {
        const info = await this.dependency(adapter.getInfo());
        record(info, ['id', 'name', 'kind', 'models', 'available', 'limitation'], ['id', 'name', 'kind', 'models', 'available']);
        assert(info.id === adapter.id, 'Agent id mismatch'); string(info.name, 'agent name', 256);
        assert(info.kind === 'acp' || info.kind === 'local', 'Invalid agent kind'); assert(typeof info.available === 'boolean' && Array.isArray(info.models), 'Invalid agent info');
        for (const model of info.models) { record(model, ['id', 'name']); string(model.id, 'model id', 256); string(model.name, 'model name', 256); }
        if (info.limitation !== undefined) string(info.limitation, 'limitation', 4096);
        current.set(adapter.id, this.scrub(clone(info)));
      } catch (error) {
        if (this.closed) throw error;
        current.set(adapter.id, { id: adapter.id, name: adapter.id, kind: 'local', models: [], available: false, limitation: 'Adapter discovery failed' });
      }
    }
    this.agents = [...this.adapters.keys()].map(id => current.get(id)!);
  }

  /* ----------------------------------------------------------------- bots */

  private ensureDefaultBot(owner: string, agentId: string): Bot {
    const existing = this.store.defaultBot(owner, agentId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const name = this.agents.find(agent => agent.id === agentId)?.name ?? agentId;
    const bot: Bot = { id: randomUUID(), name, instructions: '', agentId, profile: 'strict', mcpServers: [], skills: [], memoryEnabled: false, createdAt: now, updatedAt: now };
    this.store.saveBot(owner, bot, agentId);
    this.emit(owner, { type: 'bot.updated', bot: publicBot(bot) });
    return bot;
  }
  private sessionBot(owner: string, session: SessionV2): Bot {
    const bot = session.botId ? this.store.findBot(session.botId, owner) : undefined;
    if (bot) return bot;
    // Defensive: sessions are migrated at startup, but never run without a bot.
    const fallback = this.ensureDefaultBot(owner, session.agentId);
    session.botId = fallback.id; this.store.saveSession(owner, session);
    return fallback;
  }
  /** Canonical workspace; trusted bots require one. */
  private async normalizeBot(input: BotInput): Promise<BotInput> {
    const bot = clone(input);
    if (bot.workspace !== undefined) bot.workspace = await canonicalDirectory(bot.workspace, 'INVALID_WORKSPACE');
    if (bot.profile === 'trusted' && !bot.workspace) throw new GatewayError('INVALID_WORKSPACE', 'Trusted bots require an existing workspace folder');
    return bot;
  }
  /** In an update, "" for an existing env/header key keeps the stored value. */
  private mergeMcpSecrets(previous: McpServerConfig[], next: McpServerConfig[]): McpServerConfig[] {
    return next.map(server => {
      const old = previous.find(entry => entry.id === server.id && entry.transport === server.transport);
      if (!old) return server;
      if (server.transport === 'stdio' && old.transport === 'stdio' && server.env) {
        return { ...server, env: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, value === '' && old.env?.[key] !== undefined ? old.env[key] : value])) };
      }
      if (server.transport === 'http' && old.transport === 'http' && server.headers) {
        return { ...server, headers: Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, value === '' && old.headers?.[key] !== undefined ? old.headers[key] : value])) };
      }
      return server;
    });
  }
  private botInput(bot: Bot): BotInput {
    const { id: _id, createdAt: _created, updatedAt: _updated, ...input } = bot;
    return input;
  }

  /* ---------------------------------------------------------------- route */

  private async route(command: DesktopCommand | DesktopCommandV2, principal: PrincipalV2): Promise<Success> {
    if (this.closed) throw new GatewayError('CLOSED', 'Gateway is closed');
    const success = { ok: true as const, commandId: command.id };
    const owner = ownerOf(principal);
    switch (command.type) {
      case 'state.sync': {
        if (command.afterSequence !== undefined) {
          if (command.afterSequence > this.store.lastSequence(owner)) throw new GatewayError('INVALID_CURSOR', 'Sequence is ahead of this principal');
          for (const { event, v2Only } of this.store.replay(owner, command.afterSequence, principal.id)) this.deliver(owner, event, principal.id, v2Only);
        }
        const event = this.emit(owner, { type: 'state.snapshot', snapshot: await this.snapshot(principal) }, principal.id);
        return { ...success, snapshot: event.type === 'state.snapshot' ? event.snapshot as AppSnapshotV2 : undefined };
      }
      case 'session.create': {
        this.availableAgent(command.agentId, command.modelId);
        const bot = this.ensureDefaultBot(owner, command.agentId);
        return this.createSession(owner, success, bot, command.title, command.agentId, command.modelId);
      }
      case 'bot.session.create': {
        const bot = this.store.getBot(command.botId, owner);
        this.availableAgent(bot.agentId, bot.modelId);
        return this.createSession(owner, success, bot, command.title, bot.agentId, bot.modelId);
      }
      case 'session.open': return { ...success, sessionId: command.sessionId, session: this.scrub(this.store.getSession(command.sessionId, owner)) };
      case 'session.delete': {
        this.store.getSession(command.sessionId, owner);
        await this.deleteSessions(owner, [command.sessionId]);
        return success;
      }
      case 'session.selectAgent': {
        const session = this.store.getSession(command.sessionId, owner);
        if (this.busy(session.id)) throw new GatewayError('SESSION_BUSY', 'Cancel the active task before changing agent');
        const current = session.botId ? this.store.findBot(session.botId, owner) : undefined;
        // Choosing which agent runs uncontained for a trusted bot is an owner decision (as for bot.update).
        if (current?.profile === 'trusted') this.requireLocalOwner(principal, 'Changing the agent of a trusted bot');
        this.availableAgent(command.agentId, command.modelId);
        session.agentId = command.agentId; delete session.modelId; if (command.modelId) session.modelId = command.modelId;
        // A session of a per-agent default bot follows the agent; a custom bot keeps its session.
        if (!session.botId || this.store.isDefaultBot(session.botId)) session.botId = this.ensureDefaultBot(owner, command.agentId).id;
        session.updatedAt = new Date().toISOString(); this.store.saveSession(owner, session); this.emit(owner, { type: 'session.updated', session });
        return { ...success, sessionId: session.id, session: this.scrub(session) };
      }
      case 'message.send': {
        if (this.settingsBusy) throw new GatewayError('SETTINGS_BUSY', 'Provider reload is in progress');
        const session = this.store.getSession(command.sessionId, owner);
        if (this.busy(session.id)) throw new GatewayError('SESSION_BUSY', 'A task is already running in this session');
        const adapter = this.availableAgent(session.agentId, session.modelId);
        const bot = this.sessionBot(owner, session);
        const task = this.newTask(session, principal, bot, adapter);
        if (!session.messages.length && session.title === 'New conversation') session.title = command.content.split('\n')[0].trim().slice(0, 80) || 'New conversation';
        session.messages.push({ id: randomUUID(), role: 'user', content: command.content, createdAt: new Date().toISOString(), taskId: task.id });
        session.updatedAt = new Date().toISOString(); this.store.saveSession(owner, session); this.emit(owner, { type: 'session.updated', session });
        this.emit(owner, { type: 'task.started', taskId: task.id, sessionId: session.id });
        queueMicrotask(() => { void this.runAgent(task, session); });
        return { ...success, sessionId: session.id, taskId: task.id };
      }
      case 'tool.run': {
        if (this.settingsBusy) throw new GatewayError('SETTINGS_BUSY', 'Provider reload is in progress');
        const session = this.store.getSession(command.sessionId, owner);
        if (this.busy(session.id)) throw new GatewayError('SESSION_BUSY', 'A task is already running in this session');
        const task = this.newTask(session, principal, this.sessionBot(owner, session)); this.emit(owner, { type: 'task.started', taskId: task.id, sessionId: session.id });
        queueMicrotask(() => { void this.runDirectTool(task, command.invocation); });
        return { ...success, sessionId: session.id, taskId: task.id };
      }
      case 'task.cancel': await this.cancelTask(command.taskId, principal); return success;
      case 'permission.decide': await this.decide(command.decision, principal); return success;
      case 'settings.update': {
        if (this.settingsBusy || this.tasks.size) throw new GatewayError('SETTINGS_BUSY', 'Provider settings require idle tasks');
        this.settingsBusy = true;
        try {
          const settings = validateSettingsV2(command.settings);
          const previous = this.store.settings(this.localId);
          for (const provider of settings.providers) {
            const old = previous.providers.find(entry => entry.id === provider.id);
            if (!Object.hasOwn(provider, 'apiKey') && old?.apiKey) provider.apiKey = old.apiKey;
            // A v1 client cannot see v2 launch fields; keep them instead of silently resetting them.
            if (command.version === 1 && old) {
              if (old.launch !== undefined) provider.launch = old.launch;
              if (old.envPassthrough !== undefined) provider.envPassthrough = old.envPassthrough;
            }
          }
          this.rememberSecrets(settings);
          const replacement = await this.dependency(Promise.resolve(this.options.onSettingsChanged?.(clone(settings), { signal: this.lifetime.signal })));
          if (replacement) await this.replaceAdapters(replacement);
          if (this.closed) throw new GatewayError('CLOSED', 'Gateway is closed');
          this.store.saveSettings(this.localId, settings); await this.refreshAgents();
          this.emit(owner, { type: 'agents.updated', agents: this.agents });
          this.emit(owner, { type: 'state.snapshot', snapshot: await this.snapshot(principal) }, principal.id); return success;
        } finally { this.settingsBusy = false; }
      }
      case 'models.refresh': {
        if (this.settingsBusy) throw new GatewayError('SETTINGS_BUSY', 'Provider reload is in progress');
        await this.refreshAgents(command.agentId); this.emit(owner, { type: 'agents.updated', agents: this.agents }); return success;
      }
      case 'bot.create': {
        if (command.bot.profile === 'trusted') this.requireLocalOwner(principal, 'Trusted bots');
        const input = await this.normalizeBot(command.bot);
        const now = new Date().toISOString();
        const bot: Bot = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
        this.store.saveBot(owner, bot); this.rememberBotSecrets(bot);
        this.emit(owner, { type: 'bot.updated', bot: publicBot(bot) });
        this.skillCache.delete(owner); // Workspace skills follow bot workspaces.
        return { ...success, bot: publicBot(bot) };
      }
      case 'bot.update': {
        const existing = this.store.getBot(command.botId, owner);
        const patch = command.patch;
        const merged = { ...this.botInput(existing), ...clone(patch) } as Record<string, unknown>;
        for (const key of ['modelId', 'workspace', 'compaction']) if (merged[key] === null || merged[key] === '') delete merged[key];
        if (patch.mcpServers) merged.mcpServers = this.mergeMcpSecrets(existing.mcpServers, patch.mcpServers);
        const validated = validateBotInput(merged);
        const input = await this.normalizeBot(validated);
        const trusted = existing.profile === 'trusted' || input.profile === 'trusted';
        if (patch.profile === 'trusted') this.requireLocalOwner(principal, 'Trusted bots');
        if (trusted && (input.workspace !== existing.workspace || stableJson(input.mcpServers) !== stableJson(existing.mcpServers) || input.agentId !== existing.agentId)) {
          this.requireLocalOwner(principal, 'Changing the workspace, MCP servers or agent of a trusted bot');
        }
        const bot: Bot = { ...input, id: existing.id, createdAt: existing.createdAt, updatedAt: new Date().toISOString() };
        this.store.saveBot(owner, bot, this.store.isDefaultBot(bot.id) ? existing.agentId : undefined); this.rememberBotSecrets(bot);
        this.emit(owner, { type: 'bot.updated', bot: publicBot(bot) });
        this.skillCache.delete(owner); // Workspace skills follow bot workspaces.
        return { ...success, bot: publicBot(bot) };
      }
      case 'bot.delete': {
        const bot = this.store.getBot(command.botId, owner);
        // Routines go first, so cancelling their tasks below never starts a queued run of this bot.
        for (const { routine } of this.store.routines(owner)) if (routine.botId === bot.id) await this.deleteRoutine(owner, routine.id);
        this.store.deleteBotMemory(owner, bot.id);
        const sessions = this.store.sessions(owner).filter(session => session.botId === bot.id).map(session => session.id);
        await this.deleteSessions(owner, sessions);
        const now = new Date().toISOString();
        for (const grant of this.store.grants(owner, bot.id)) if (!grant.revokedAt) {
          const revoked: StandingGrant = { ...grant, revokedAt: now, revokedBy: principal.id };
          this.store.saveGrant(owner, revoked); this.emit(owner, { type: 'grant.updated', grant: revoked });
        }
        this.store.deleteBot(bot.id, owner);
        this.emit(owner, { type: 'bot.deleted', botId: bot.id });
        this.skillCache.delete(owner);
        return success;
      }
      case 'grant.create': {
        const bot = this.store.getBot(command.grant.botId, owner);
        const scope = await normalizeStandingScope(command.grant.capability, command.grant.scope, bot);
        if (command.grant.expiresAt !== undefined && Date.parse(command.grant.expiresAt) <= Date.now()) throw new GatewayError('INVALID_INPUT', 'Grant expiry must be in the future');
        const grant: StandingGrant = { id: randomUUID(), botId: bot.id, capability: command.grant.capability, scope, createdAt: new Date().toISOString(), createdBy: principal.id, ...(command.grant.expiresAt ? { expiresAt: command.grant.expiresAt } : {}) };
        this.store.saveGrant(owner, grant); this.emit(owner, { type: 'grant.updated', grant });
        return { ...success, grant };
      }
      case 'grant.revoke': {
        let grant = this.store.getGrant(command.grantId, owner);
        if (!grant.revokedAt) {
          // Grants are read from SQLite on every authorization, so this applies to the next request, including in running tasks.
          grant = { ...grant, revokedAt: new Date().toISOString(), revokedBy: principal.id };
          this.store.saveGrant(owner, grant); this.emit(owner, { type: 'grant.updated', grant });
        }
        return { ...success, grant };
      }
      case 'audit.list':
        return { ...success, audit: this.store.audit(owner, { botId: command.botId, limit: command.limit ?? AUDIT_DEFAULT_LIMIT, beforeId: command.beforeId }) };
      case 'device.pair.start': {
        const devices = this.deviceManager();
        const pairing = await this.dependency(devices.startPairing({ ...(command.name !== undefined ? { name: command.name } : {}), ...(command.capabilities ? { capabilities: command.capabilities } : {}) }));
        return { ...success, pairing: clone(pairing) };
      }
      case 'device.list': return { ...success, devices: clone(await this.dependency(this.deviceManager().list())) };
      case 'device.revoke': {
        const devices = this.deviceManager();
        await this.dependency(devices.revoke(command.deviceId));
        const list = clone(await this.dependency(devices.list()));
        const device = list.find(entry => entry.id === command.deviceId);
        // Device state is local-owner only: never delivered to the owner's paired devices.
        if (device) this.emit(owner, { type: 'device.updated', device }, this.localId);
        return { ...success, devices: list };
      }
      case 'memory.list': return { ...success, memory: this.store.memory(owner, this.store.getBot(command.botId, owner).id) };
      case 'memory.add': {
        const bot = this.store.getBot(command.botId, owner);
        const content = command.content.trim();
        if (!content) throw new GatewayError('INVALID_INPUT', 'Memory content is empty');
        if (bytes(content) > OWNER_MEMORY_LIMIT) throw new GatewayError('LIMIT_EXCEEDED', 'Memory entries are limited to 8 KiB');
        return { ...success, memory: this.addMemory(owner, bot, content, 'owner') };
      }
      case 'memory.delete': {
        const bot = this.store.getBot(command.botId, owner);
        if (!this.store.deleteMemory(owner, bot.id, command.memoryId)) throw new GatewayError('NOT_FOUND', 'Memory entry not found');
        const memory = this.store.memory(owner, bot.id);
        this.emit(owner, { type: 'memory.updated', botId: bot.id, memory });
        return { ...success, memory };
      }
      case 'session.compact': {
        const session = this.store.getSession(command.sessionId, owner);
        if (this.busy(session.id)) throw new GatewayError('SESSION_BUSY', 'Cancel the active task before compacting');
        const compacted = await this.compact(owner, session.id, true);
        return { ...success, sessionId: session.id, session: this.scrub(compacted ?? this.store.getSession(session.id, owner)) };
      }
      case 'skills.refresh': {
        const skills = await this.skillList(owner, true);
        this.emit(owner, { type: 'skills.updated', skills });
        return { ...success, skills };
      }
      case 'notification.ack': {
        const notification = this.store.getNotification(command.notificationId, owner);
        if (!notification.acknowledgedAt) {
          notification.acknowledgedAt = this.isoNow();
          this.store.acknowledgeNotification(owner, notification);
          this.emit(owner, { type: 'notification', notification });
        }
        return success;
      }
      case 'routine.create': return { ...success, routine: await this.createRoutine(owner, principal, command.routine) };
      case 'routine.update': return { ...success, routine: await this.updateRoutine(owner, principal, command.routineId, command.patch) };
      case 'routine.delete': { this.store.getRoutine(command.routineId, owner); await this.deleteRoutine(owner, command.routineId); return success; }
      case 'routine.runNow': {
        const { routine } = this.store.getRoutine(command.routineId, owner);
        if (this.store.runsWithStatus(['queued'], owner).some(entry => entry.run.routineId === routine.id)) throw new GatewayError('SESSION_BUSY', 'A run of this routine is already queued');
        const run = this.enqueueRun(owner, routine, 'manual', this.clock.now());
        return { ...success, routine: this.store.getRoutine(routine.id, owner).routine, runs: [this.store.getRun(run.id)?.run ?? run] };
      }
      case 'routine.runs': {
        const { routine } = this.store.getRoutine(command.routineId, owner);
        return { ...success, runs: this.store.runs(owner, routine.id, command.limit ?? RUNS_DEFAULT_LIMIT) };
      }
    }
  }
  /* ------------------------------------------------------- continuity (P4) */

  private isoNow(): string { return new Date(this.clock.now()).toISOString(); }
  private track(promise: Promise<unknown>): void {
    const tracked = promise.then(() => undefined, () => undefined);
    this.background.add(tracked); void tracked.finally(() => this.background.delete(tracked));
  }
  private addMemory(owner: string, bot: Bot, content: string, source: MemoryEntry['source']): MemoryEntry[] {
    if (this.store.memoryCount(owner, bot.id) >= MEMORY_ENTRIES_LIMIT) throw new GatewayError('LIMIT_EXCEEDED', `A bot keeps at most ${MEMORY_ENTRIES_LIMIT} memory entries`);
    const entry: MemoryEntry = { id: randomUUID(), botId: bot.id, content: this.scrub(content), source, createdAt: new Date().toISOString() };
    this.store.addMemory(owner, entry);
    const memory = this.store.memory(owner, bot.id);
    this.emit(owner, { type: 'memory.updated', botId: bot.id, memory });
    return memory;
  }
  /**
   * Core-served MCP tools for bots with memory enabled. The broker authorizes every call through
   * `authorizeMcp` (serverId 'your_bot') before `handle` runs, so standing grants and live approval
   * apply exactly as for upstream MCP servers.
   */
  private memoryBuiltins(task: Task): McpBuiltinTool[] {
    const bot = task.bot!;
    const usable = (signal: AbortSignal) => { if (!this.live(task) || signal?.aborted) throw new GatewayError('CANCELLED', 'Task is no longer active'); };
    return [
      {
        name: 'remember',
        description: `Save a short durable note (fact, preference, decision) to this bot's long-term memory. At most ${AGENT_MEMORY_LIMIT} bytes per note.`,
        inputSchema: { type: 'object', properties: { content: { type: 'string', description: 'The note to remember.' } }, required: ['content'], additionalProperties: false },
        handle: async (args, signal) => {
          usable(signal);
          const input = record(args, ['content']);
          string(input.content, 'memory content', 65_536);
          const content = input.content.trim();
          if (!content) throw new GatewayError('INVALID_INPUT', 'Memory content is empty');
          if (bytes(content) > AGENT_MEMORY_LIMIT) throw new GatewayError('LIMIT_EXCEEDED', `Memory notes are limited to ${AGENT_MEMORY_LIMIT} bytes`);
          const memory = this.addMemory(task.owner, bot, content, 'agent');
          return { saved: true, id: memory[0].id };
        },
      },
      {
        name: 'recall',
        description: "Read notes from this bot's long-term memory, newest first. `query` filters by case-insensitive substring.",
        inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
        handle: async (args, signal) => {
          usable(signal);
          const input = record(args ?? {}, ['query', 'limit'], []);
          if (input.query !== undefined) string(input.query, 'query', 1024, true);
          if (input.limit !== undefined) assert(Number.isSafeInteger(input.limit) && (input.limit as number) >= 1 && (input.limit as number) <= 100, 'Invalid limit');
          const query = typeof input.query === 'string' ? input.query.toLowerCase() : '';
          const entries: JsonValue[] = []; let size = 0;
          for (const entry of this.store.memory(task.owner, bot.id)) {
            if (query && !entry.content.toLowerCase().includes(query)) continue;
            size += bytes(entry.content);
            if (entries.length >= ((input.limit as number | undefined) ?? 50) || size > 16 * 1024) break;
            entries.push({ id: entry.id, content: entry.content, source: entry.source, createdAt: entry.createdAt });
          }
          return { entries };
        },
      },
    ];
  }
  /** Skills of an owner: global plus the workspaces of the owner's bots. Cached until skills.refresh. */
  private async skillList(owner: string, refresh = false): Promise<SkillInfo[]> {
    const catalog = this.options.skillCatalog;
    if (!catalog) return [];
    const cached = this.skillCache.get(owner);
    if (cached && !refresh) return clone(cached);
    const workspaces = [...new Set(this.store.bots(owner).flatMap(bot => bot.workspace ? [bot.workspace] : []))];
    const skills = await this.dependency(catalog.list(workspaces));
    assert(Array.isArray(skills) && skills.length <= 10_000, 'Invalid skill list');
    const list = this.scrub(clone(skills));
    this.skillCache.set(owner, list);
    return clone(list);
  }
  /**
   * Composed run instructions: bot instructions, memory (when enabled; newest first, ≤ 8 KiB) and the
   * bodies of enabled skills (global wins over a workspace skill with the same id), ≤ 64 KiB in total.
   * Missing or invalid skills are skipped with a status update; the run continues.
   */
  private async instructionsFor(task: Task, bot: Bot): Promise<string> {
    const memory = bot.memoryEnabled ? memorySection(this.store.memory(task.owner, bot.id)) : '';
    const skills: {name: string; body: string}[] = [];
    const skip = (id: string, why: string) => this.taskEvent(task, { type: 'task.status', taskId: task.id, sessionId: task.sessionId, status: `Skill ${id} was skipped: ${why}` });
    if (bot.skills.length) {
      const catalog = this.options.skillCatalog;
      let available: SkillInfo[] | undefined;
      if (catalog) {
        try { available = await this.dependency(catalog.list(bot.workspace ? [bot.workspace] : [])); assert(Array.isArray(available), 'Invalid skill list'); }
        catch (error) { if (this.closed) throw error; available = undefined; }
      }
      for (const id of bot.skills) {
        if (!catalog || !available) { skip(id, 'skills are unavailable on this host'); continue; }
        const info = available.find(skill => skill?.id === id && skill.source === 'global') ?? available.find(skill => skill?.id === id && skill.source === 'workspace');
        if (!info) { skip(id, 'not found'); continue; }
        if (info.error) { skip(id, 'invalid'); continue; }
        try {
          const body = await this.dependency(catalog.read(clone(info)));
          string(body, 'skill body', 1_000_000, true);
          skills.push({ name: typeof info.name === 'string' && info.name ? info.name.slice(0, 256) : id, body });
        } catch (error) { if (this.closed) throw error; skip(id, 'unreadable'); }
      }
    }
    return composeInstructions(bot.instructions, memory, skills);
  }
  /**
   * Moves older messages to the archive (never deleted) and keeps `keepRecent` live messages plus a
   * summary. Automatic compaction runs after a task when the bot has a policy and the session holds
   * more than `maxMessages`; `session.compact` compacts on demand. Messages are identified by id, so
   * messages appended while summarizing are kept.
   */
  private async compact(owner: string, sessionId: string, manual: boolean): Promise<SessionV2 | undefined> {
    if (this.closed) return undefined;
    if (this.compacting.has(sessionId)) { if (manual) throw new GatewayError('SESSION_BUSY', 'Compaction is already in progress'); return undefined; }
    const session = this.store.getSession(sessionId, owner);
    const policy = session.botId ? this.store.findBot(session.botId, owner)?.compaction : undefined;
    if (!manual && (!policy || session.messages.length <= policy.maxMessages)) return undefined;
    const keep = policy?.keepRecent ?? DEFAULT_KEEP_RECENT;
    if (session.messages.length <= keep) return session;
    const older = session.messages.slice(0, session.messages.length - keep);
    this.compacting.add(sessionId);
    try {
      const summary = await this.summarize(session, older);
      if (this.closed) return undefined;
      let current: SessionV2;
      try { current = this.store.getSession(sessionId, owner); } catch { return undefined; }
      const ids = new Set(older.map(message => message.id));
      const archived = current.messages.filter(message => ids.has(message.id));
      if (!archived.length) return current;
      current.messages = current.messages.filter(message => !ids.has(message.id));
      current.summary = summary; current.compactedCount = (current.compactedCount ?? 0) + archived.length;
      current.updatedAt = new Date().toISOString();
      const clean = this.scrub(current);
      this.store.compactSession(owner, clean, archived);
      this.emit(owner, { type: 'session.updated', session: clean });
      return clean;
    } finally { this.compacting.delete(sessionId); }
  }
  /** `adapter.summarize` when available (bounded time, abortable), else the deterministic fallback. */
  private async summarize(session: SessionV2, messages: ChatMessage[]): Promise<string> {
    const adapter = this.adapters.get(session.agentId) as AgentAdapterV2 | undefined;
    if (adapter && typeof adapter.summarize === 'function') {
      const controller = new AbortController();
      const abort = () => controller.abort();
      this.lifetime.signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, this.options.summarizeTimeoutMs ?? 60_000);
      try {
        const stopped = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new GatewayError('CANCELLED', 'Summarize aborted')), { once: true }));
        const result = await Promise.race([
          adapter.summarize({ ...(session.summary ? { previousSummary: session.summary } : {}), messages: this.scrub(clone(messages)), signal: controller.signal }),
          stopped,
        ]);
        if (typeof result === 'string' && result.trim()) return bounded(this.scrub(result.trim()), SUMMARY_LIMIT);
      } catch { /* Fall back below. */ }
      finally { clearTimeout(timer); controller.abort(); this.lifetime.signal.removeEventListener('abort', abort); }
    }
    return fallbackSummary(session.summary, messages);
  }

  /* --------------------------------------------------- notifications (P4) */

  /** Strips control characters (except newline/tab) since text can include agent-influenced content. */
  private static sanitizeNotificationText(text: string): string { return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); }

  private notify(owner: string, input: Omit<OwnerNotification, 'id' | 'createdAt' | 'acknowledgedAt'>): void {
    const title = Gateway.sanitizeNotificationText(input.title).slice(0, 200);
    const body = Gateway.sanitizeNotificationText(input.body).slice(0, 1000);
    const notification: OwnerNotification = this.scrub({ id: randomUUID(), ...input, title, body, createdAt: this.isoNow() });
    this.store.addNotification(owner, notification);
    this.emit(owner, { type: 'notification', notification });
    try { this.options.notifier?.notify(clone(notification)); } catch { /* A failing notifier never affects routines. */ }
  }

  /* -------------------------------------------------------- routines (P4) */

  private routinePrincipal(): PrincipalV2 { return { id: this.localId, kind: 'local', capabilities: [...this.routineCapabilities] }; }
  private scheduleState(routine: Routine, anchor: number): ScheduleState { return { schedule: routine.schedule, anchor }; }
  private nextRun(routine: Routine, anchor: number, after: number): string | undefined {
    if (!routine.enabled) return undefined;
    const next = nextOccurrence(this.scheduleState(routine, anchor), after);
    return next === undefined ? undefined : new Date(next).toISOString();
  }
  private saveRoutine(owner: string, routine: Routine, anchor: number): void {
    this.store.saveRoutine(owner, routine, anchor);
    this.emit(owner, { type: 'routine.updated', routine });
  }
  /** Routines act as the local owner principal, so only the local owner's data can hold routines. */
  private requireRoutineOwner(owner: string): void {
    if (owner !== this.localId) throw new GatewayError('FORBIDDEN', "Routines run on the local owner's behalf");
  }
  private async createRoutine(owner: string, principal: PrincipalV2, raw: RoutineInput): Promise<Routine> {
    this.requireRoutineOwner(owner);
    const input = clone(raw);
    const bot = this.store.getBot(input.botId, owner);
    // Unattended runs of an uncontained agent are an owner decision, like trusting the bot.
    if (bot.profile === 'trusted') this.requireLocalOwner(principal, 'Routines for trusted bots');
    const now = this.clock.now();
    checkSchedule(input.schedule, now);
    const iso = new Date(now).toISOString();
    const routine: Routine = { ...input, id: randomUUID(), createdAt: iso, updatedAt: iso };
    const next = this.nextRun(routine, now, now);
    if (next) routine.nextRunAt = next;
    this.saveRoutine(owner, routine, now);
    this.reschedule();
    return routine;
  }
  private async updateRoutine(owner: string, principal: PrincipalV2, routineId: string, patch: Partial<RoutineInput>): Promise<Routine> {
    this.requireRoutineOwner(owner);
    const { routine: existing, anchor: previousAnchor } = this.store.getRoutine(routineId, owner);
    const { id: _id, sessionId: _s, lastRunAt: _l, nextRunAt: _n, createdAt: _c, updatedAt: _u, ...current } = existing;
    const merged = { ...current, ...clone(patch) };
    validateRoutineInput(merged, false);
    const bot = this.store.getBot(merged.botId, owner);
    const oldBot = this.store.findBot(existing.botId, owner);
    const trivial = Object.keys(patch).every(key => key === 'enabled' || key === 'name');
    if ((bot.profile === 'trusted' || oldBot?.profile === 'trusted') && !trivial) this.requireLocalOwner(principal, 'Changing routines of trusted bots');
    const now = this.clock.now();
    const rescheduled = stableJson(merged.schedule) !== stableJson(existing.schedule) || (merged.enabled && !existing.enabled);
    if (rescheduled && merged.enabled) checkSchedule(merged.schedule, now);
    const routine: Routine = { ...merged, id: existing.id, createdAt: existing.createdAt, updatedAt: new Date(now).toISOString() };
    if (existing.lastRunAt) routine.lastRunAt = existing.lastRunAt;
    if (existing.sessionId && merged.botId === existing.botId && merged.sessionMode === 'reuse') routine.sessionId = existing.sessionId;
    const anchor = rescheduled ? now : previousAnchor;
    const next = rescheduled ? this.nextRun(routine, anchor, now) : (routine.enabled ? existing.nextRunAt : undefined);
    if (next) routine.nextRunAt = next;
    this.saveRoutine(owner, routine, anchor);
    this.reschedule();
    return routine;
  }
  /** Deletes the routine and its run records first, then cancels its active task (so nothing queued starts). */
  private async deleteRoutine(owner: string, routineId: string): Promise<void> {
    this.store.deleteRoutine(routineId, owner);
    this.emit(owner, { type: 'routine.deleted', routineId });
    this.reschedule();
    for (const task of [...this.tasks.values()]) if (task.routineId === routineId && task.owner === owner) await this.cancel(task);
  }
  private saveRun(owner: string, run: RoutineRun): void {
    this.store.saveRun(owner, run);
    this.emit(owner, { type: 'routine.run', run });
  }
  private routineActive(routineId: string): boolean { return [...this.tasks.values()].some(task => task.routineId === routineId && !task.terminal); }
  /**
   * Records a run. A routine never overlaps itself: one active run plus at most one queued run; any
   * further occurrence is recorded `skipped` with a notification. Catch-up batches (`force`) queue
   * every selected occurrence, bounded by maxCatchUp.
   */
  private enqueueRun(owner: string, routine: Routine, trigger: RoutineRun['trigger'], scheduledFor: number, force = false): RoutineRun {
    const run: RoutineRun = { id: randomUUID(), routineId: routine.id, botId: routine.botId, trigger, scheduledFor: new Date(scheduledFor).toISOString(), status: 'queued' };
    const queued = this.store.runsWithStatus(['queued'], owner).filter(entry => entry.run.routineId === routine.id);
    if (!force && queued.length) {
      run.status = 'skipped'; run.finishedAt = this.isoNow();
      this.saveRun(owner, run);
      this.notify(owner, {
        kind: 'routine.skipped', title: `Routine skipped: ${routine.name}`, botId: routine.botId, routineRunId: run.id,
        body: `The run scheduled for ${run.scheduledFor} was skipped because the previous run of "${routine.name}" has not finished.`,
      });
      return run;
    }
    this.saveRun(owner, run);
    this.pumpRoutine(owner, routine.id);
    return run;
  }
  private pumpAll(): void {
    if (this.closed) return;
    const routines = new Map<string, string>();
    for (const { owner, run } of this.store.runsWithStatus(['queued'])) routines.set(run.routineId, owner);
    for (const [routineId, owner] of routines) this.pumpRoutine(owner, routineId);
  }
  /** Starts the oldest queued run when the routine is idle and its reused session is free. */
  private pumpRoutine(owner: string, routineId: string): void {
    if (this.closed || this.routineActive(routineId)) return;
    const queued = this.store.runsWithStatus(['queued'], owner).find(entry => entry.run.routineId === routineId)?.run;
    if (!queued) return;
    const stored = this.store.findRoutine(routineId, owner);
    if (!stored) return;
    const { routine, anchor } = stored;
    if (routine.sessionMode === 'reuse' && routine.sessionId && this.busy(routine.sessionId)) return;
    this.startRun(owner, routine, anchor, queued);
  }
  private startRun(owner: string, routine: Routine, anchor: number, queued: RoutineRun): void {
    let run = queued;
    try {
      if (this.settingsBusy) throw new GatewayError('SETTINGS_BUSY', 'Provider reload is in progress');
      const bot = this.store.getBot(routine.botId, owner);
      let session: SessionV2 | undefined;
      if (routine.sessionMode === 'reuse' && routine.sessionId) { try { session = this.store.getSession(routine.sessionId, owner); } catch { session = undefined; } }
      if (!session) {
        this.availableAgent(bot.agentId, bot.modelId);
        session = this.newSession(owner, bot, routine.name.slice(0, 80), bot.agentId, bot.modelId);
        if (routine.sessionMode === 'reuse') { routine.sessionId = session.id; this.saveRoutine(owner, routine, anchor); }
      }
      const adapter = this.availableAgent(session.agentId, session.modelId);
      const task = this.newTask(session, this.routinePrincipal(), this.sessionBot(owner, session), adapter);
      task.routineRunId = run.id; task.routineId = routine.id;
      const startedAt = this.isoNow();
      session.messages.push({ id: randomUUID(), role: 'user', content: routine.prompt, createdAt: new Date().toISOString(), taskId: task.id });
      session.updatedAt = new Date().toISOString(); this.store.saveSession(owner, session); this.emit(owner, { type: 'session.updated', session });
      this.emit(owner, { type: 'task.started', taskId: task.id, sessionId: session.id });
      run = { ...run, status: 'running', sessionId: session.id, taskId: task.id, startedAt };
      this.saveRun(owner, run);
      routine.lastRunAt = startedAt; this.saveRoutine(owner, routine, anchor);
      const started = session;
      queueMicrotask(() => { void this.runAgent(task, started); });
    } catch (error) {
      this.failRun(owner, routine, run, this.error(error));
    }
  }
  private failRun(owner: string, routine: Routine, run: RoutineRun, error: {code: string; message: string}): void {
    const failed: RoutineRun = { ...run, status: 'failed', finishedAt: this.isoNow(), error };
    delete failed.blockedOn;
    this.saveRun(owner, failed);
    this.notify(owner, { kind: 'routine.failed', title: `Routine failed: ${routine.name}`, body: `${error.code}: ${error.message}`, botId: routine.botId, routineRunId: run.id });
    this.pumpRoutine(owner, routine.id);
  }
  /** A pending permission blocks the run until someone decides. There is no timeout: it waits indefinitely. */
  private routineBlocked(task: Task, request: PermissionRequestV2): void {
    const stored = this.store.getRun(task.routineRunId!);
    if (!stored || task.terminal) return;
    const run: RoutineRun = { ...stored.run, status: 'blocked', blockedOn: [...new Set([...(stored.run.blockedOn ?? []), request.id])] };
    this.saveRun(stored.owner, run);
    const routine = this.store.findRoutine(run.routineId, stored.owner)?.routine;
    const routineName = routine?.name ?? 'routine'; const botName = task.bot?.name ?? 'bot';
    this.notify(stored.owner, {
      kind: 'approval.required', title: `Approval needed: ${botName} / ${routineName}`,
      body: `Bot "${botName}" (routine "${routineName}") is waiting for approval to ${request.capability}: ${subject(request)}. The run waits until someone decides (request ${request.id}).`,
      botId: run.botId, routineRunId: run.id, requestId: request.id,
    });
  }
  private routineUnblocked(task: Task, requestId: string): void {
    if (this.closed || task.terminal) return;
    const stored = this.store.getRun(task.routineRunId!);
    if (!stored || !stored.run.blockedOn?.includes(requestId)) return;
    const run: RoutineRun = { ...stored.run, blockedOn: stored.run.blockedOn.filter(id => id !== requestId) };
    if (!run.blockedOn!.length) { delete run.blockedOn; run.status = 'running'; }
    this.saveRun(stored.owner, run);
  }
  private routineRunFinished(task: Task, status: 'completed' | 'cancelled' | 'failed', error?: {code: string; message: string}): void {
    const stored = this.store.getRun(task.routineRunId!);
    if (!stored) return;
    const run: RoutineRun = { ...stored.run, status, finishedAt: this.isoNow() };
    delete run.blockedOn;
    if (status === 'failed' && error) run.error = error;
    this.saveRun(stored.owner, run);
    if (status === 'failed') {
      const routine = this.store.findRoutine(run.routineId, stored.owner)?.routine;
      this.notify(stored.owner, { kind: 'routine.failed', title: `Routine failed: ${routine?.name ?? 'routine'}`, body: `${run.error?.code ?? 'TASK_FAILED'}: ${run.error?.message ?? 'Task failed'}`, botId: run.botId, routineRunId: run.id });
    }
  }
  /** Startup: runs a previous process left unfinished never resume silently. */
  private recoverRoutines(): void {
    for (const { owner, run } of this.store.runsWithStatus(UNFINISHED_RUNS)) {
      const previous = run.status;
      const interrupted: RoutineRun = { ...run, status: 'interrupted', finishedAt: this.isoNow() };
      delete interrupted.blockedOn;
      this.saveRun(owner, interrupted);
      const routine = this.store.findRoutine(run.routineId, owner)?.routine;
      this.notify(owner, {
        kind: 'routine.interrupted', title: `Routine interrupted: ${routine?.name ?? 'routine'}`, botId: run.botId, routineRunId: run.id,
        body: `The host stopped while this run was ${previous}. It was not resumed; run the routine again if needed.`,
      });
    }
  }
  /**
   * Fires due routines. Occurrences older than LATE_GRACE_MS (host down, or a timer firing late after
   * sleep) are missed and handled by the routine's policy: skip, runOnce (latest missed) or runAll
   * (latest `maxCatchUp`, default 5, oldest first). The most recent on-time occurrence runs normally.
   */
  private tick(): void {
    this.timer = undefined;
    if (this.closed) return;
    const now = this.clock.now();
    for (const { owner, routine, anchor } of this.store.routines()) {
      if (!routine.enabled || !routine.nextRunAt) continue;
      const due = Date.parse(routine.nextRunAt);
      if (due > now) continue;
      try { this.fire(owner, routine, anchor, due, now); } catch { /* One broken routine never stops the scheduler. */ }
    }
    this.reschedule();
  }
  private fire(owner: string, routine: Routine, anchor: number, due: number, now: number): void {
    const state = this.scheduleState(routine, anchor);
    const cutoff = now - LATE_GRACE_MS;
    const limit = routine.missedRunPolicy === 'skip' ? 0 : routine.missedRunPolicy === 'runOnce' ? 1 : routine.maxCatchUp ?? DEFAULT_MAX_CATCH_UP;
    const missed = latestOccurrences(state, due, cutoff, limit);
    const onTime = latestOccurrences(state, Math.max(due, cutoff), now + 1, 1);
    const next = nextOccurrence(state, now);
    const updated: Routine = { ...routine };
    if (next === undefined) delete updated.nextRunAt; else updated.nextRunAt = new Date(next).toISOString();
    this.saveRoutine(owner, updated, anchor);
    for (const at of missed) this.enqueueRun(owner, updated, 'catchup', at, true);
    for (const at of onTime) this.enqueueRun(owner, this.store.getRoutine(routine.id, owner).routine, 'schedule', at);
  }
  private reschedule(): void {
    if (this.timer !== undefined) { this.clock.clearTimeout(this.timer); this.timer = undefined; }
    if (this.closed) return;
    let earliest: number | undefined;
    for (const { routine } of this.store.routines()) {
      if (!routine.enabled || !routine.nextRunAt) continue;
      const due = Date.parse(routine.nextRunAt);
      if (earliest === undefined || due < earliest) earliest = due;
    }
    if (earliest === undefined) return;
    const delay = Math.min(Math.max(0, earliest - this.clock.now()), MAX_TIMER_MS);
    this.timer = this.clock.setTimeout(() => this.tick(), delay);
  }

  private deviceManager(): DeviceManager {
    if (!this.options.devices) throw new GatewayError('NOT_SUPPORTED', 'Device pairing is not available on this host');
    return this.options.devices;
  }
  private createSession(owner: string, success: {ok: true; commandId: string}, bot: Bot, title: string | undefined, agentId: string, modelId?: string): Success {
    const session = this.newSession(owner, bot, title, agentId, modelId);
    return { ...success, sessionId: session.id, session: this.scrub(session) };
  }
  private newSession(owner: string, bot: Bot, title: string | undefined, agentId: string, modelId?: string): SessionV2 {
    const now = new Date().toISOString();
    const session: SessionV2 = { id: randomUUID(), title: title ?? 'New conversation', agentId, ...(modelId ? {modelId} : {}), createdAt: now, updatedAt: now, messages: [], botId: bot.id };
    this.store.saveSession(owner, session); this.emit(owner, { type: 'session.updated', session });
    return session;
  }
  private async deleteSessions(owner: string, ids: string[]): Promise<void> {
    for (const id of ids) if (this.deletingSessions.has(id)) throw new GatewayError('SESSION_BUSY', 'Session deletion is in progress');
    for (const id of ids) this.deletingSessions.add(id);
    try {
      for (const task of [...this.tasks.values()]) if (ids.includes(task.sessionId) && task.owner === owner) await this.cancel(task);
      for (const id of ids) { this.store.deleteSession(id, owner); this.emit(owner, { type: 'session.deleted', sessionId: id }); }
    } finally { for (const id of ids) this.deletingSessions.delete(id); }
  }

  /* ---------------------------------------------------------------- tasks */

  private newTask(session: SessionV2, principal: PrincipalV2, bot: Bot | undefined, adapter?: AnyAgentAdapter): Task {
    const task: Task = {
      id: randomUUID(), sessionId: session.id, owner: ownerOf(principal), principal: clone(principal), controller: new AbortController(), adapter,
      text: '', terminal: false, grants: [], toolQueue: Promise.resolve(), deltaPending: '', outputPending: new Map(),
      bot: bot ? clone(bot) : undefined, profile: bot?.profile ?? 'strict', terminals: new Set(),
    };
    this.tasks.set(task.id, task); this.store.startTask(task.id, task.owner, session.id); return task;
  }
  private live(task: Task): boolean { return !this.closed && !task.terminal && !task.controller.signal.aborted; }
  private taskEvent(task: Task, payload: EventPayloadV2, v2Only = false): void { if (this.live(task)) this.emit(task.owner, payload, undefined, v2Only); }
  private adapterState(task: Task, adapterId: string): AgentRunContextV2['state'] {
    const usable = () => { if (this.closed) throw new GatewayError('CLOSED', 'Gateway is closed'); this.store.getSession(task.sessionId, task.owner); };
    return {
      get: async () => { usable(); return clone(this.store.adapterState(task.owner, task.sessionId, adapterId)); },
      set: async (value: JsonValue) => {
        usable(); validateJson(value);
        const serialized = JSON.stringify(value);
        if (Buffer.byteLength(serialized) > ADAPTER_STATE_LIMIT) throw new GatewayError('LIMIT_EXCEEDED', 'Adapter state exceeds 64 KiB');
        this.store.saveAdapterState(task.owner, task.sessionId, adapterId, serialized);
      },
      clear: async () => { usable(); this.store.clearAdapterState(task.owner, task.sessionId, adapterId); },
    };
  }
  /** Prepares trusted-only resources. Throws a structured error that fails the task. */
  private async prepareProfile(task: Task): Promise<void> {
    const adapter = task.adapter!;
    const profiles = (adapter as AgentAdapterV2).profiles ?? ['strict'];
    if (!profiles.includes(task.profile)) throw new GatewayError('PROFILE_UNSUPPORTED', `Agent ${adapter.id} does not support the ${task.profile} execution profile`);
    if (task.profile !== 'trusted') return;
    const bot = task.bot!;
    let workspace: string | undefined;
    try { workspace = bot.workspace ? await canonicalDirectory(bot.workspace, 'WORKSPACE_UNAVAILABLE') : undefined; } catch { workspace = undefined; }
    if (!workspace || workspace !== bot.workspace) throw new GatewayError('WORKSPACE_UNAVAILABLE', 'Trusted bot workspace is missing or no longer canonical');
    task.workspace = workspace;
    if (this.options.workspaceHost) {
      task.host = createHostChannel({
        host: this.options.workspaceHost, workspace, taskId: task.id, botId: bot.id, signal: task.controller.signal,
        databasePath: this.store.path, live: () => this.live(task), terminals: task.terminals,
        authorize: async request => {
          const { env, ...input } = request;
          return (await this.authorize(task, input, { retainOnce: false, origin: 'core', confine: true, env: !!env })).outcome === 'allow';
        },
        policyDeny: (request, code, message) => { this.auditPolicy(task, request, `${code}: ${message}`); return new GatewayError(code, message); },
      });
    }
    const servers = bot.mcpServers.filter(server => server.enabled);
    const builtins = bot.memoryEnabled ? this.memoryBuiltins(task) : [];
    if (this.options.mcpBroker && (servers.length || builtins.length)) {
      try {
        const session = await this.dependency(this.options.mcpBroker.open({
          taskId: task.id, botId: bot.id, servers: clone(servers), builtins, signal: task.controller.signal,
          authorize: (call, signal) => this.authorizeMcp(task, call, signal),
        }));
        if (!this.live(task)) { await this.cleanup([() => session.close()]); return; }
        task.mcp = session;
      } catch (error) {
        if (this.closed) throw error;
        this.taskEvent(task, { type: 'task.status', taskId: task.id, sessionId: task.sessionId, status: 'MCP servers are unavailable for this run' });
      }
    }
  }
  private async authorizeMcp(task: Task, call: McpCall, signal: AbortSignal): Promise<boolean> {
    try {
      const value = record(call, ['serverId', 'tool', 'arguments']);
      string(value.serverId, 'MCP server id', 256); string(value.tool, 'MCP tool', 256); validateJson(value.arguments);
      if (signal?.aborted) return false;
      let args = JSON.stringify(call.arguments) ?? 'null';
      if (args.length > 4096) args = `${args.slice(0, 4096)}…`;
      const decision = await this.authorize(task, { capability: 'mcp.call', reason: `Call MCP tool ${call.serverId}/${call.tool}\nArguments: ${args}`, mcp: { serverId: call.serverId, tool: call.tool } }, { retainOnce: false, origin: 'core' });
      return decision.outcome === 'allow' && this.live(task) && !signal?.aborted;
    } catch { return false; }
  }
  private async runAgent(task: Task, session: SessionV2): Promise<void> {
    try {
      if (!this.live(task)) return;
      await this.prepareProfile(task);
      if (!this.live(task)) return;
      const trusted = task.profile === 'trusted';
      const bot = task.bot;
      const instructions = bot ? this.scrub(await this.instructionsFor(task, bot)) : '';
      if (!this.live(task)) return;
      const context: AgentRunContextV2 = {
        session: this.scrub(clone(session)), taskId: task.id, principal: clone(task.principal), signal: task.controller.signal,
        emit: update => this.agentUpdate(task, update), executeTool: invocation => this.executeTool(task, invocation),
        requestPermission: input => this.authorize(task, input, { retainOnce: !(input && typeof input === 'object' && 'agentTool' in input), origin: 'adapter' }),
        profile: task.profile, state: this.adapterState(task, task.adapter!.id),
        ...(bot ? { bot: publicBot(bot) } : {}),
        ...(instructions ? { instructions } : {}),
        ...(trusted && task.workspace ? { workspace: task.workspace } : {}),
        ...(trusted && task.host ? { host: task.host } : {}),
        ...(trusted && task.mcp ? { mcp: clone(task.mcp.endpoint) } : {}),
      };
      await (task.adapter as AgentAdapterV2).run(context); await task.toolQueue;
      if (!this.live(task)) return;
      if (task.emittedToolError && !task.emittedToolError.ok) throw new GatewayError(task.emittedToolError.error?.code ?? 'TOOL_FAILED', task.emittedToolError.error?.message ?? 'Tool execution failed');
      if (task.text) {
        const saved = this.store.getSession(task.sessionId, task.owner);
        saved.messages.push({ id: randomUUID(), role: 'assistant', content: task.text, taskId: task.id, createdAt: new Date().toISOString() });
        saved.updatedAt = new Date().toISOString(); this.store.saveSession(task.owner, this.scrub(saved));
        this.emit(task.owner, { type: 'session.updated', session: saved });
      }
      this.finish(task, 'completed');
    } catch (error) { if (this.live(task)) this.finish(task, 'failed', this.error(error)); }
  }
  private agentUpdate(task: Task, update: AgentUpdate): void {
    if (!this.live(task)) return;
    try {
      assert(update && typeof update === 'object', 'Invalid agent update');
      if (update.type === 'text') {
        record(update, ['type', 'text']); string(update.text, 'text delta', 1_000_000, true);
        if (task.text.length + update.text.length > 16_777_216) throw new GatewayError('RESPONSE_LIMIT', 'Assistant response exceeded the conversation size limit');
        task.text += update.text;
        const streamed = this.streamText(task.deltaPending + update.text); task.deltaPending = streamed.pending;
        if (streamed.text) this.taskEvent(task, { type: 'message.delta', taskId: task.id, sessionId: task.sessionId, text: streamed.text });
      } else if (update.type === 'status') {
        record(update, ['type', 'status']); string(update.status, 'status', 4096);
        this.taskEvent(task, { type: 'task.status', taskId: task.id, sessionId: task.sessionId, status: update.status });
      } else if (update.type === 'tool') {
        record(update, ['type', 'invocation']);
        const operation = this.executeTool(task, update.invocation);
        task.toolQueue = operation.then(result => { if (!result.ok) task.emittedToolError = result; });
      } else throw new GatewayError('INVALID_INPUT', 'Invalid agent update');
    } catch (error) { this.finish(task, 'failed', this.error(error)); task.controller.abort(); }
  }
  private async runDirectTool(task: Task, invocation: ToolInvocation): Promise<void> {
    try {
      const result = await this.executeTool(task, invocation);
      if (!this.live(task)) return;
      if (result.ok) this.finish(task, 'completed');
      else this.finish(task, 'failed', result.error ?? { code: 'TOOL_FAILED', message: 'Tool execution failed' });
    } catch (error) { if (this.live(task)) this.finish(task, 'failed', this.error(error)); }
  }
  private executeTool(task: Task, value: ToolInvocation): Promise<ToolResult> {
    // Serialize tools so one-use grants cannot be reused by concurrent calls.
    const operation = task.toolQueue.then(() => this.executeAuthorizedTool(task, value));
    task.toolQueue = operation.then(() => undefined, () => undefined);
    return operation.catch(error => ({ ok: false, error: this.error(error) }));
  }
  private async executeAuthorizedTool(task: Task, value: ToolInvocation): Promise<ToolResult> {
    try { return await this.executeAuthorizedToolBody(task, value); }
    finally { task.grants = task.grants.filter(grant => grant.scope === 'task'); }
  }
  private async executeAuthorizedToolBody(task: Task, value: ToolInvocation): Promise<ToolResult> {
    if (!this.live(task)) return { ok: false, error: { code: 'CANCELLED', message: 'Task was cancelled' } };
    this.require(task.principal, 'tool.execute');
    const invocation = validateInvocation(value);
    if (invocation.paths) invocation.paths = await canonicalPaths(invocation.paths, this.store.path);
    const reason = invocation.kind === 'python'
      ? 'Execute custom Python sha256:' + createHash('sha256').update(invocation.code!).digest('hex') + '\n\n' + invocation.code
      : `Execute ${invocation.kind} tool ${invocation.id}`;
    const requests: PermissionInputV2[] = [{ capability: 'tool.execute', reason }];
    for (const path of invocation.paths ?? []) {
      requests.push({ capability: `file.${path.access}`, reason: `Tool ${invocation.id} requests ${path.access} access`, paths: [path] });
    }
    if (invocation.packages?.length) requests.push({ capability: 'library.install', reason: `Install packages for tool ${invocation.id}`, packages: invocation.packages });
    // Check all capabilities before asking for any approvals.
    for (const request of requests) this.require(task.principal, request.capability);
    for (const request of requests) {
      const decision = await this.authorize(task, request, { retainOnce: true, origin: 'core' });
      if (decision.outcome !== 'allow' || !this.live(task)) return denied('Tool permission was denied');
    }
    if (invocation.paths) {
      const checked = await canonicalPaths(invocation.paths, this.store.path);
      if (stableJson(checked) !== stableJson(invocation.paths)) return denied('File target changed after approval');
    }
    if (!this.live(task)) return denied('Task is no longer active');
    const authorization: AuthorizationContext = {
      principal: principalV1(task.principal), taskId: task.id, sessionId: task.sessionId,
      grants: task.grants.flatMap(grant => { const request = requestV1(grant.request); return request ? [request] : []; }),
    };
    const context: ToolExecutionContext = {
      authorization, signal: task.controller.signal,
      requestPermission: input => this.authorize(task, input, { retainOnce: true, origin: 'adapter' }),
      emit: output => {
        if (!this.live(task)) return;
        try {
          record(output, ['stream', 'text']); assert(['stdout', 'stderr', 'status'].includes(output.stream), 'Invalid output stream'); string(output.text, 'tool output', 1_000_000, true);
          const key = JSON.stringify([invocation.id, output.stream]);
          const streamed = this.streamText((task.outputPending.get(key)?.text ?? '') + output.text);
          task.outputPending.set(key, {stream: output.stream, toolCallId: invocation.id, text: streamed.pending});
          if (streamed.text) this.taskEvent(task, { type: 'tool.output', taskId: task.id, sessionId: task.sessionId, toolCallId: invocation.id, stream: output.stream, text: streamed.text });
        } catch { /* Invalid executor output never reaches the transport. */ }
      }
    };
    task.execution = context;
    try {
      const result = this.scrub(validateToolResult(await this.options.executor.execute(clone(invocation), context)));
      if (this.live(task)) {
        const session = this.store.getSession(task.sessionId, task.owner);
        session.messages.push({ id: randomUUID(), role: 'tool', taskId: task.id, createdAt: new Date().toISOString(), content: JSON.stringify({toolCallId: invocation.id, result}) });
        session.updatedAt = new Date().toISOString(); this.store.saveSession(task.owner, session);
        this.emit(task.owner, { type: 'session.updated', session });
      }
      return result;
    } finally {
      task.execution = undefined;
    }
  }

  /* -------------------------------------------------------- authorization */

  private covers(grant: PermissionRequestV2, request: PermissionInputV2): boolean {
    if (grant.capability !== request.capability) return false;
    if (grant.capability === 'tool.execute' && (grant.reason.startsWith('Execute custom Python sha256:') || request.reason.startsWith('Execute custom Python sha256:')) && grant.reason !== request.reason) return false;
    if (request.paths && !request.paths.every(path => grant.paths?.some(allowed => allowed.path === path.path && allowed.access === path.access))) return false;
    if (request.packages && !request.packages.every(pkg => grant.packages?.includes(pkg))) return false;
    // v2 detail: a grant covers only the same kind of action with the same detail.
    if (!!grant.agentTool !== !!request.agentTool || !!grant.command !== !!request.command || !!grant.mcp !== !!request.mcp) return false;
    if (request.agentTool && !(grant.agentTool!.kind !== undefined ? grant.agentTool!.kind === request.agentTool.kind : grant.agentTool!.title === request.agentTool.title)) return false;
    // Commands: argv, canonical cwd and environment (all in the reason) must be identical.
    if (request.command && (stableJson(grant.command) !== stableJson(request.command) || grant.reason !== request.reason)) return false;
    if (request.mcp && (grant.mcp!.serverId !== request.mcp.serverId || grant.mcp!.tool !== request.mcp.tool)) return false;
    return true;
  }
  private audit(task: Task, request: PermissionInputV2 & {id?: string}, outcome: 'allow' | 'deny', via: GrantAuditEntry['via'], extra: {grantId?: string; decidedBy?: string; requestId?: string} = {}): void {
    if (!task.bot) return;
    const entry: GrantAuditEntry = {
      id: randomUUID(), at: new Date().toISOString(), botId: task.bot.id, taskId: task.id, sessionId: task.sessionId,
      requestId: extra.requestId ?? request.id ?? randomUUID(), capability: request.capability, subject: subject(request), outcome, via,
      ...(extra.grantId ? { grantId: extra.grantId } : {}), ...(extra.decidedBy ? { decidedBy: extra.decidedBy } : {}),
      ...(task.routineRunId ? { routineRunId: task.routineRunId } : {}),
    };
    const clean = this.scrub(entry);
    this.store.appendAudit(task.owner, clean);
    this.emit(task.owner, { type: 'grant.audited', entry: clean });
  }
  private auditPolicy(task: Task, request: PermissionInputV2, reason: string): void {
    this.audit(task, { ...request, reason: `${reason}\n${request.reason}` }, 'deny', 'policy');
  }
  private newRequest(task: Task, input: PermissionInputV2): PermissionRequestV2 {
    return { ...clone(input), id: randomUUID(), principalId: task.principal.id, sessionId: task.sessionId, taskId: task.id };
  }
  /**
   * The single authorization pipeline for executor tools, adapter requests, agent built-in tools, the
   * host channel and MCP calls:
   *   capability held by the task principal → policy (workspace confinement, profile, forbidden
   *   detail) → matching standing grant (allow, audited `standing`) → existing once/task grant →
   *   live approval. Every decision for a bot task is audited.
   */
  private async authorize(task: Task, raw: unknown, options: AuthorizeOptions): Promise<PermissionDecision> {
    const input = validatePermissionInputV2(raw);
    if (options.origin === 'adapter' && (input.command || input.mcp || input.routineRunId)) throw new GatewayError('INVALID_INPUT', 'Adapters cannot request command, MCP or routine permissions directly');
    if (input.botId !== undefined && input.botId !== task.bot?.id) throw new GatewayError('INVALID_INPUT', 'Permission bot does not match the task');
    if (task.bot) input.botId = task.bot.id;
    if (task.routineRunId) input.routineRunId = task.routineRunId;
    if (!task.principal.capabilities.includes(input.capability)) { this.auditPolicy(task, input, 'Principal lacks capability'); throw new GatewayError('FORBIDDEN', `Principal cannot request ${input.capability}`); }
    if (input.capability === 'conversation' || input.capability === 'settings') { this.auditPolicy(task, input, 'Not a tool capability'); throw new GatewayError('FORBIDDEN', 'Permission requests are limited to tool capabilities'); }
    if (input.paths) {
      input.paths = await Promise.all(input.paths.map(async scope => {
        // New exact write targets need a separate read approval before a writable
        // mount is created. Resolve their parent using the already-approved write
        // scope, while keeping the new approval's capability strictly file.read.
        const newWriteRead = scope.access === 'read' && task.grants.some(grant => grant.request.capability === 'file.write' && grant.request.paths?.some(path => path.path === scope.path));
        const [canonical] = await canonicalPaths([{ ...scope, ...(newWriteRead ? { access: 'write' as const } : {}) }], this.store.path);
        return { ...canonical, access: scope.access };
      }));
    }
    if (input.command) input.command.cwd = await canonicalDirectory(input.command.cwd, 'UNSAFE_PATH');
    const deny = (reason: string): PermissionDecision => { this.auditPolicy(task, input, reason); return { requestId: randomUUID(), outcome: 'deny', scope: 'once' }; };
    if (options.confine) {
      const workspace = task.workspace;
      const inside = (path: string) => !!workspace && isWithin(workspace, path);
      if (!(input.paths ?? []).every(path => inside(path.path)) || (input.command && !inside(input.command.cwd))) return deny('OUTSIDE_WORKSPACE');
    }
    if (input.agentTool && task.profile !== 'trusted') return deny('Agent built-in tools require a trusted bot');
    if (!this.live(task)) return deny('Task is no longer active');
    if (task.bot && !standingForbidden(input)) {
      const now = Date.now(); const bot = task.bot;
      const grant = this.store.grants(task.owner, bot.id).find(entry => matches(entry, { ...input, ...(options.env ? { env: true } : {}) }, bot.id, bot.workspace, now));
      if (grant) {
        const request = this.newRequest(task, input);
        if (options.retainOnce) this.addGrant(task, request, 'once', grant.createdBy, true);
        this.audit(task, request, 'allow', 'standing', { grantId: grant.id, decidedBy: grant.createdBy });
        return { requestId: request.id, outcome: 'allow', scope: 'once' };
      }
    }
    const existing = task.grants.find(grant => this.covers(grant.request, input));
    if (existing) {
      this.audit(task, input, 'allow', 'interactive', { requestId: existing.request.id, decidedBy: existing.decidedBy });
      return { requestId: existing.request.id, outcome: 'allow', scope: existing.scope };
    }
    const request = this.newRequest(task, input);
    let settle!: (decision: PermissionDecision) => void;
    const promise = new Promise<PermissionDecision>(resolve => { settle = resolve; });
    const pending: Pending = { request, task, retainOnce: options.retainOnce, promise, resolve: settle }; this.pending.set(request.id, pending);
    // Public full-request API accepts only already registered, byte-equivalent requests.
    const waiting = this.requestPermission(clone(request));
    this.taskEvent(task, { type: 'permission.requested', request });
    if (task.routineRunId) this.routineBlocked(task, request);
    return waiting;
  }
  private addGrant(task: Task, request: PermissionRequestV2, scope: PermissionDecision['scope'], decidedBy: string | undefined, executor: boolean): void {
    const grant = clone(request);
    task.grants.push({ request: grant, scope, decidedBy });
    // Executors keep this context by reference while awaiting additional permissions.
    const v1 = requestV1(grant);
    if (executor && v1 && task.execution) task.execution.authorization.grants.push(v1);
  }
  async requestPermission(request: PermissionRequest | PermissionRequestV2): Promise<PermissionDecision> {
    if (this.closed) throw new GatewayError('CLOSED', 'Gateway is closed');
    const pending = this.pending.get(request?.id);
    const given = stableJson(request);
    const v1 = pending ? requestV1(pending.request) : undefined;
    if (!pending || (stableJson(pending.request) !== given && (!v1 || stableJson(v1) !== given))) throw new GatewayError('INVALID_PERMISSION', 'Permission must be an unchanged gateway-issued live request');
    return clone(await pending.promise);
  }
  private async decide(decision: PermissionDecisionV2, principal: PrincipalV2): Promise<void> {
    const find = () => {
      const pending = this.pending.get(decision.requestId);
      // Paired devices act on the owner's data, so they can answer the owner's approvals.
      if (!pending || pending.task.terminal || pending.task.owner !== ownerOf(principal)) throw new GatewayError('NOT_FOUND', 'Live permission request not found');
      return pending;
    };
    let pending = find();
    this.require(principal, pending.request.capability);
    if (decision.scope !== 'standing') {
      // The decision carries no scope data; grants always copy the original gateway-issued request.
      this.settlePermission(pending, { requestId: decision.requestId, outcome: decision.outcome, scope: decision.scope }, { decidedBy: principal.id, via: 'interactive' });
      return;
    }
    // Standing: allow this request AND create a grant, only if the decider may create grants and the scope covers the request.
    this.require(principal, 'settings');
    const task = pending.task; const bot = task.bot;
    if (!bot) throw new GatewayError('INVALID_INPUT', 'Standing grants require a bot task');
    if (standingForbidden(pending.request)) throw new GatewayError('STANDING_FORBIDDEN', 'This request can never be granted standing');
    const scope = await normalizeStandingScope(pending.request.capability, decision.standing!, bot);
    if (decision.standingExpiresAt !== undefined && Date.parse(decision.standingExpiresAt) <= Date.now()) throw new GatewayError('INVALID_INPUT', 'Grant expiry must be in the future');
    pending = find();
    const grant: StandingGrant = {
      id: randomUUID(), botId: bot.id, capability: pending.request.capability, scope, createdAt: new Date().toISOString(), createdBy: principal.id,
      ...(decision.standingExpiresAt ? { expiresAt: decision.standingExpiresAt } : {}),
    };
    const { id: _id, principalId: _p, sessionId: _s, taskId: _t, ...request } = pending.request;
    // The request carries no env flag: a command request with environment variables has them in its reason.
    const env = request.capability === 'process.spawn' && request.reason.includes('\nEnvironment: ');
    if (!matches(grant, { ...request, ...(env ? { env: true } : {}) }, bot.id, bot.workspace)) throw new GatewayError('INVALID_INPUT', 'Standing scope does not cover the request');
    this.store.saveGrant(task.owner, grant); this.emit(task.owner, { type: 'grant.updated', grant });
    this.settlePermission(pending, { requestId: decision.requestId, outcome: 'allow', scope: 'once' }, { decidedBy: principal.id, via: 'interactive', grantId: grant.id });
  }
  private settlePermission(pending: Pending, decision: PermissionDecision, settlement: Settlement): void {
    if (!this.pending.delete(pending.request.id)) return;
    const allowed = decision.outcome === 'allow' && this.live(pending.task);
    if (allowed && (decision.scope === 'task' || pending.retainOnce)) this.addGrant(pending.task, pending.request, decision.scope, settlement.decidedBy, pending.retainOnce);
    this.audit(pending.task, pending.request, decision.outcome, settlement.via, { decidedBy: settlement.decidedBy, grantId: settlement.grantId });
    this.emit(pending.task.owner, { type: 'permission.resolved', requestId: pending.request.id, outcome: decision.outcome }, undefined, !isV1Capability(pending.request.capability));
    pending.resolve(clone(decision));
    if (pending.task.routineRunId) this.routineUnblocked(pending.task, pending.request.id);
  }
  private finish(task: Task, status: 'completed' | 'cancelled' | 'failed', error?: {code: string; message: string}): void {
    if (task.terminal) return;
    if (status === 'completed') {
      if (task.deltaPending) this.emit(task.owner, { type: 'message.delta', taskId: task.id, sessionId: task.sessionId, text: '[REDACTED]' });
      for (const pending of task.outputPending.values()) if (pending.text) this.emit(task.owner, { type: 'tool.output', taskId: task.id, sessionId: task.sessionId, toolCallId: pending.toolCallId, stream: pending.stream, text: '[REDACTED]' });
    }
    task.terminal = true; this.store.finishTask(task.id);
    if (status === 'failed') {
      task.controller.abort();
      void this.cleanup([() => this.options.executor.cancel(task.id), ...(task.adapter ? [() => task.adapter!.cancel(task.id)] : [])]);
    }
    for (const pending of [...this.pending.values()]) if (pending.task === task) this.settlePermission(pending, { requestId: pending.request.id, outcome: 'deny', scope: 'once' }, { via: 'policy' });
    task.grants = []; if (task.execution) task.execution.authorization.grants.length = 0;
    this.tasks.delete(task.id);
    // Trusted resources end with the task: terminals are killed/released and the MCP proxy is closed.
    const resources: (() => Promise<void>)[] = [];
    if (task.host && this.options.workspaceHost) resources.push(() => this.options.workspaceHost!.releaseTask(task.id));
    if (task.mcp) { const mcp = task.mcp; resources.push(() => mcp.close()); }
    task.released = resources.length ? this.cleanup(resources) : Promise.resolve();
    if (status === 'failed') this.emit(task.owner, { type: 'task.failed', taskId: task.id, sessionId: task.sessionId, error: error ?? { code: 'TASK_FAILED', message: 'Task failed' } });
    else this.emit(task.owner, { type: status === 'completed' ? 'task.completed' : 'task.cancelled', taskId: task.id, sessionId: task.sessionId });
    // On close, routine runs stay running/blocked in the store and become `interrupted` on the next start.
    if (this.closed) return;
    if (task.routineRunId) this.routineRunFinished(task, status, error ?? (status === 'failed' ? { code: 'TASK_FAILED', message: 'Task failed' } : undefined));
    if (task.bot?.compaction && !this.deletingSessions.has(task.sessionId)) this.track(this.compact(task.owner, task.sessionId, false));
    this.pumpAll();
  }
  async cancelTask(taskId: string, input: Principal | PrincipalV2): Promise<void> {
    const principal = this.principal(input); this.require(principal, 'conversation'); string(taskId, 'task id', 256);
    const task = this.tasks.get(taskId);
    if (!task || task.owner !== ownerOf(principal)) throw new GatewayError('NOT_FOUND', 'Active task not found');
    await this.cancel(task);
  }
  private async cancel(task: Task): Promise<void> {
    if (task.terminal) return;
    task.controller.abort(); this.finish(task, 'cancelled');
    await Promise.all([this.cleanup([() => this.options.executor.cancel(task.id), ...(task.adapter ? [() => task.adapter!.cancel(task.id)] : [])]), task.released]);
  }
  private async cleanup(callbacks: (() => Promise<void>)[]): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(callbacks.map(callback => Promise.resolve().then(callback))),
      new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.cleanupTimeoutMs ?? 1000); })
    ]);
    if (timer) clearTimeout(timer);
  }
  private streamText(value: string): {text: string; pending: string} {
    const safe = this.scrub(value); let suffix = 0;
    for (const secret of this.secrets) for (let size = 1; size < secret.length && size <= safe.length; size++) {
      if (safe.endsWith(secret.slice(0, size))) suffix = Math.max(suffix, size);
    }
    return {text: suffix ? safe.slice(0, -suffix) : safe, pending: suffix ? safe.slice(-suffix) : ''};
  }
  private async dependency<T>(promise: Promise<T>): Promise<T> {
    if (this.closed) throw new GatewayError('CLOSED', 'Gateway is closed');
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => { abort = () => reject(new GatewayError('CLOSED', 'Gateway is closed')); });
    this.lifetime.signal.addEventListener('abort', abort, {once: true});
    try { return await Promise.race([promise, stopped]); }
    finally { this.lifetime.signal.removeEventListener('abort', abort); }
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.lifetime.abort();
    if (this.timer !== undefined) { this.clock.clearTimeout(this.timer); this.timer = undefined; }
    this.closing = (async () => {
      await Promise.all([...this.tasks.values()].map(task => this.cancel(task)));
      // Background compactions observe the lifetime signal; wait (bounded) so they never touch a closed DB.
      await this.cleanup([...this.background].map(promise => () => promise.then(() => undefined, () => undefined)));
      // In-flight dispatch may be waiting for an asynchronous settings callback. It must finish before DB close.
      await Promise.allSettled([...this.inFlight.values()].map(command => command.promise));
      await this.cleanup([
        () => this.options.executor.close(), ...[...this.adapters.values()].map(adapter => () => adapter.close()),
        ...(this.options.workspaceHost ? [() => this.options.workspaceHost!.close()] : []),
        ...(this.options.mcpBroker ? [() => this.options.mcpBroker!.close()] : []),
      ]);
      this.listeners.clear(); this.pending.clear(); this.store.close();
    })(); return this.closing;
  }
}
