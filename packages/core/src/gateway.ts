import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type {
  AgentAdapter, AgentAdapterV2, AgentInfo, AgentRunContextV2, AgentUpdate, AnyCommandResult, AnyDesktopCommand, AppSettingsV2,
  AppSnapshotV2, AuthorizationContext, Bot, BotInput, CapabilityV2, CommandResultV2, ContractVersion, DesktopEvent, DesktopEventV2,
  DeviceManager, EventPayloadV2, ExecutionProfile, GrantAuditEntry, JsonValue, McpBroker, McpCall, McpProxySession, McpServerConfig,
  PermissionDecision, PermissionDecisionV2, PermissionInputV2, PermissionRequest, PermissionRequestV2, Principal, PrincipalV2,
  SecretCipher, SessionV2, StandingGrant, ToolExecutionContext, ToolExecutor, ToolInvocation, ToolResult, Unsubscribe, WorkspaceHost,
  WorkspaceHostChannel, DesktopCommand, DesktopCommandV2,
} from '@your-bot/contracts';
import { normalizeStandingScope, active, matches, standingForbidden, subject } from './grants.js';
import { createHostChannel, type HostPermission } from './host-channel.js';
import { canonicalDirectory, canonicalPaths, isWithin } from './paths.js';
import { SecretBox } from './secrets.js';
import { Store } from './storage.js';
import { assert, GatewayError, record, stableJson, string, validateCommand, validateInvocation, validateJson, validateToolResult } from './validation.js';
import { validateBotInput, validateCommandV2, validatePermissionInputV2, validatePrincipalV2, validateSettingsV2 } from './validation-v2.js';
import { eventFor, isV1Capability, principalV1, requestV1, sessionV1, settingsV1, snapshotV1 } from './versioning.js';

export type AnyAgentAdapter = AgentAdapter | AgentAdapterV2;
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
}

type Grant = { request: PermissionRequestV2; scope: PermissionDecision['scope']; decidedBy?: string };
type Task = {
  id: string; sessionId: string; owner: string; principal: PrincipalV2; controller: AbortController;
  adapter?: AnyAgentAdapter; text: string; terminal: boolean; grants: Grant[];
  toolQueue: Promise<void>; execution?: ToolExecutionContext; emittedToolError?: ToolResult;
  deltaPending: string; outputPending: Map<string, {stream: 'stdout' | 'stderr' | 'status'; toolCallId: string; text: string}>;
  bot?: Bot; profile: ExecutionProfile; workspace?: string; routineRunId?: string;
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
  constructor(private readonly options: GatewayOptions, private readonly acceptV2: boolean) {
    this.localId = options.localPrincipalId ?? 'local';
    string(this.localId, 'local principal id', 256);
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
      // Owned by P4 (routines, notifications, skills); empty until implemented.
      routines: [], routineRuns: [], notifications: [], skills: [],
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
        return { ...success, bot: publicBot(bot) };
      }
      case 'bot.delete': {
        const bot = this.store.getBot(command.botId, owner);
        const sessions = this.store.sessions(owner).filter(session => session.botId === bot.id).map(session => session.id);
        await this.deleteSessions(owner, sessions);
        const now = new Date().toISOString();
        for (const grant of this.store.grants(owner, bot.id)) if (!grant.revokedAt) {
          const revoked: StandingGrant = { ...grant, revokedAt: now, revokedBy: principal.id };
          this.store.saveGrant(owner, revoked); this.emit(owner, { type: 'grant.updated', grant: revoked });
        }
        this.store.deleteBot(bot.id, owner);
        this.emit(owner, { type: 'bot.deleted', botId: bot.id });
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
      case 'memory.list': case 'memory.add': case 'memory.delete': case 'session.compact':
      case 'routine.create': case 'routine.update': case 'routine.delete': case 'routine.runNow': case 'routine.runs':
      case 'notification.ack': case 'skills.refresh':
        throw new GatewayError('NOT_SUPPORTED', `${command.type} is not supported by this host yet`);
    }
  }
  private deviceManager(): DeviceManager {
    if (!this.options.devices) throw new GatewayError('NOT_SUPPORTED', 'Device pairing is not available on this host');
    return this.options.devices;
  }
  private createSession(owner: string, success: {ok: true; commandId: string}, bot: Bot, title: string | undefined, agentId: string, modelId?: string): Success {
    const now = new Date().toISOString();
    const session: SessionV2 = { id: randomUUID(), title: title ?? 'New conversation', agentId, ...(modelId ? {modelId} : {}), createdAt: now, updatedAt: now, messages: [], botId: bot.id };
    this.store.saveSession(owner, session); this.emit(owner, { type: 'session.updated', session });
    return { ...success, sessionId: session.id, session: this.scrub(session) };
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
    if (this.options.mcpBroker && servers.length) {
      try {
        const session = await this.dependency(this.options.mcpBroker.open({
          taskId: task.id, botId: bot.id, servers: clone(servers), builtins: [], signal: task.controller.signal,
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
      const context: AgentRunContextV2 = {
        session: this.scrub(clone(session)), taskId: task.id, principal: clone(task.principal), signal: task.controller.signal,
        emit: update => this.agentUpdate(task, update), executeTool: invocation => this.executeTool(task, invocation),
        requestPermission: input => this.authorize(task, input, { retainOnce: !(input && typeof input === 'object' && 'agentTool' in input), origin: 'adapter' }),
        profile: task.profile, state: this.adapterState(task, task.adapter!.id),
        ...(bot ? { bot: publicBot(bot) } : {}),
        ...(bot?.instructions ? { instructions: bot.instructions } : {}),
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
    this.closing = (async () => {
      await Promise.all([...this.tasks.values()].map(task => this.cancel(task)));
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
