import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentAdapter, AgentInfo, AgentRunContext, AgentUpdate, AppSettings, AppSnapshot, AuthorizationContext,
  Capability, CommandResult, DesktopCommand, DesktopEvent, DesktopGateway, EventPayload,
  PermissionDecision, PermissionRequest, Principal, Session, ToolExecutionContext, ToolExecutor, ToolInvocation, ToolResult, Unsubscribe
} from '@your-bot/contracts';
import { canonicalPaths } from './paths.js';
import { Store } from './storage.js';
import { assert, GatewayError, record, stableJson, string, validateCommand, validateInvocation, validatePermissionInput, validatePrincipal, validateSettings, validateToolResult } from './validation.js';

export interface GatewayOptions {
  /** Use a dedicated application-data directory; core enforces 0700 on its parent and 0600 on the DB. */
  databasePath: string;
  /** Only this host-authenticated local identity can read/update provider settings. */
  localPrincipalId?: string;
  adapters?: readonly AgentAdapter[];
  executor: ToolExecutor;
  /** Called on startup and settings updates with credentials. Return replacement adapters to reload. */
  onSettingsChanged?: (settings: AppSettings, context: {signal: AbortSignal}) => Promise<readonly AgentAdapter[] | void> | readonly AgentAdapter[] | void;
  /** Upper bound for waiting on misbehaving injected dependencies during cleanup. */
  cleanupTimeoutMs?: number;
}
type Grant = { request: PermissionRequest; scope: PermissionDecision['scope'] };
type Task = {
  id: string; sessionId: string; principal: Principal; controller: AbortController;
  adapter?: AgentAdapter; text: string; terminal: boolean; grants: Grant[];
  toolQueue: Promise<void>; execution?: ToolExecutionContext; emittedToolError?: ToolResult;
  deltaPending: string; outputPending: Map<string, {stream: 'stdout' | 'stderr' | 'status'; toolCallId: string; text: string}>;
};
type Pending = {request: PermissionRequest; task: Task; promise: Promise<PermissionDecision>; resolve: (decision: PermissionDecision) => void};
type PermissionInput = Omit<PermissionRequest, 'id' | 'principalId' | 'sessionId' | 'taskId'>;
const denied = (message: string): ToolResult => ({ ok: false, error: { code: 'PERMISSION_DENIED', message } });
const clone = <T>(value: T): T => structuredClone(value);

/** Construct once in Electron main (or an authenticated transport host), never in the renderer. */
export async function createGateway(options: GatewayOptions): Promise<DesktopGateway> {
  const gateway = new Gateway(options);
  try { await gateway.initialize(); return gateway; }
  catch (error) { await gateway.close(); throw error; }
}

class Gateway implements DesktopGateway {
  private readonly store: Store;
  private readonly localId: string;
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly listeners = new Map<string, Set<(event: DesktopEvent) => void>>();
  private readonly tasks = new Map<string, Task>();
  private readonly pending = new Map<string, Pending>();
  private readonly inFlight = new Map<string, {fingerprint: string; promise: Promise<CommandResult>}>();
  private agents: AgentInfo[] = [];
  private secrets: string[];
  private closed = false;
  private closing?: Promise<void>;
  private settingsBusy = false;
  private readonly lifetime = new AbortController();
  private readonly deletingSessions = new Set<string>();
  constructor(private readonly options: GatewayOptions) {
    this.localId = options.localPrincipalId ?? 'local';
    string(this.localId, 'local principal id', 256);
    assert(options.cleanupTimeoutMs === undefined || (Number.isSafeInteger(options.cleanupTimeoutMs) && options.cleanupTimeoutMs > 0), 'Invalid cleanup timeout');
    this.store = new Store(options.databasePath);
    this.secrets = this.store.secrets();
  }
  async initialize(): Promise<void> {
    this.store.bindLocalIdentity(this.localId);
    this.setAdapters(this.options.adapters ?? []);
    const settings = this.store.settings(this.localId);
    this.rememberSecrets(settings);
    if (this.options.onSettingsChanged) {
      const replacement = await this.dependency(Promise.resolve(this.options.onSettingsChanged(clone(settings), { signal: this.lifetime.signal })));
      if (replacement) await this.replaceAdapters(replacement);
    }
    await this.refreshAgents();
    for (const task of this.store.interruptedTasks()) {
      this.emit(task.owner, { type: 'task.cancelled', taskId: task.id, sessionId: task.sessionId });
      this.store.finishTask(task.id);
    }
  }
  private setAdapters(adapters: readonly AgentAdapter[]): void {
    const ids = new Set<string>();
    for (const adapter of adapters) { string(adapter.id, 'adapter id', 256); assert(!ids.has(adapter.id), 'Duplicate adapter id'); ids.add(adapter.id); }
    this.adapters.clear(); for (const adapter of adapters) this.adapters.set(adapter.id, adapter);
  }
  private async replaceAdapters(adapters: readonly AgentAdapter[]): Promise<void> {
    const old = [...this.adapters.values()];
    this.setAdapters(adapters);
    await this.cleanup(old.filter(adapter => !adapters.includes(adapter)).map(adapter => () => adapter.close()));
  }
  private principal(value: Principal): Principal {
    if (this.closed) throw new GatewayError('CLOSED', 'Gateway is closed');
    const principal = validatePrincipal(value);
    if ((principal.kind === 'local' && principal.id !== this.localId) || (principal.kind === 'remote' && principal.id === this.localId)) throw new GatewayError('IDENTITY_MISMATCH', 'Local identity is reserved for the authenticated local host');
    this.store.bind(principal); return principal;
  }
  private require(principal: Principal, capability: Capability): void {
    if (!principal.capabilities.includes(capability)) throw new GatewayError('FORBIDDEN', `Principal cannot request ${capability}`);
  }
  private rememberSecrets(settings: AppSettings): void {
    for (const provider of settings.providers) if (provider.apiKey && !this.secrets.includes(provider.apiKey)) {
      this.secrets.push(provider.apiKey); this.store.rememberSecret(provider.apiKey);
    }
  }
  private scrub<T>(value: T): T {
    const structural = new Set(['id', 'type', 'kind', 'version', 'role', 'capability', 'access', 'scope', 'outcome', 'stream', 'principalId', 'sessionId', 'taskId', 'toolCallId', 'commandId', 'requestId', 'agentId', 'modelId', 'createdAt', 'updatedAt', 'timestamp', 'code']);
    const clean = (item: unknown, key?: string): unknown => {
      if (typeof item === 'string') {
        if (key && structural.has(key)) return item;
        let text = item;
        for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
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
  private emit(owner: string, payload: EventPayload): DesktopEvent {
    const event = this.store.append(owner, this.scrub(payload), new Date().toISOString());
    this.deliver(owner, event); return event;
  }
  private deliver(owner: string, event: DesktopEvent): void {
    for (const listener of this.listeners.get(owner) ?? []) {
      try { listener(clone(this.scrub(event))); } catch { /* Subscribers cannot disrupt persistence or other listeners. */ }
    }
  }
  subscribe(listener: (event: DesktopEvent) => void, input: Principal): Unsubscribe {
    const principal = this.principal(input); this.require(principal, 'conversation');
    if (typeof listener !== 'function') throw new GatewayError('INVALID_INPUT', 'Listener must be a function');
    const listeners = this.listeners.get(principal.id) ?? new Set(); listeners.add(listener); this.listeners.set(principal.id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(principal.id); };
  }
  async dispatch(input: DesktopCommand, identity: Principal): Promise<CommandResult> {
    let id = '';
    try {
      if (input && typeof input.id === 'string' && input.id.length <= 256) id = input.id;
      const principal = this.principal(identity); const command = validateCommand(input); id = command.id;
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
        let result: CommandResult;
        try { result = this.scrub(await this.route(command, principal)); }
        catch (error) { result = { ok: false, commandId: id, error: this.error(error) }; }
        this.store.saveCommand(principal.id, id, fingerprint, result); return result;
      });
      this.inFlight.set(key, { fingerprint, promise });
      try { return clone(this.scrub(await promise)); } finally { this.inFlight.delete(key); }
    } catch (error) { return { ok: false, commandId: id, error: this.error(error) }; }
  }
  private authorizeCommand(command: DesktopCommand, principal: Principal): void {
    if (command.type === 'settings.update') {
      this.require(principal, 'settings');
      if (principal.kind !== 'local' || principal.id !== this.localId) throw new GatewayError('FORBIDDEN', 'Provider settings are local-owner only');
    } else this.require(principal, 'conversation');
    if (command.type === 'tool.run') this.require(principal, 'tool.execute');
  }
  private snapshot(principal: Principal): AppSnapshot {
    return this.scrub({
      sessions: this.store.sessions(principal.id), agents: clone(this.agents),
      settings: principal.id === this.localId && principal.capabilities.includes('settings') ? this.store.settings(this.localId) : { providers: [] },
      activeTasks: [...this.tasks.values()].filter(task => task.principal.id === principal.id && !task.terminal).map(task => ({ id: task.id, sessionId: task.sessionId })),
      pendingPermissions: [...this.pending.values()].filter(pending => pending.request.principalId === principal.id).map(pending => clone(pending.request)),
      lastSequence: this.store.lastSequence(principal.id)
    });
  }
  private busy(sessionId: string): boolean { return this.deletingSessions.has(sessionId) || [...this.tasks.values()].some(task => task.sessionId === sessionId && !task.terminal); }
  private availableAgent(id: string, modelId?: string): AgentAdapter {
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
  private async route(command: DesktopCommand, principal: Principal): Promise<CommandResult> {
    if (this.closed) throw new GatewayError('CLOSED', 'Gateway is closed');
    const success = { ok: true as const, commandId: command.id };
    switch (command.type) {
      case 'state.sync': {
        if (command.afterSequence !== undefined) {
          if (command.afterSequence > this.store.lastSequence(principal.id)) throw new GatewayError('INVALID_CURSOR', 'Sequence is ahead of this principal');
          for (const event of this.store.replay(principal.id, command.afterSequence)) this.deliver(principal.id, event);
        }
        const event = this.emit(principal.id, { type: 'state.snapshot', snapshot: this.snapshot(principal) });
        return { ...success, snapshot: event.type === 'state.snapshot' ? event.snapshot : undefined };
      }
      case 'session.create': {
        this.availableAgent(command.agentId, command.modelId);
        const now = new Date().toISOString();
        const session: Session = { id: randomUUID(), title: command.title ?? 'New conversation', agentId: command.agentId, ...(command.modelId ? {modelId: command.modelId} : {}), createdAt: now, updatedAt: now, messages: [] };
        this.store.saveSession(principal.id, session); this.emit(principal.id, { type: 'session.updated', session });
        return { ...success, sessionId: session.id, session: this.scrub(session) };
      }
      case 'session.open': return { ...success, sessionId: command.sessionId, session: this.scrub(this.store.getSession(command.sessionId, principal.id)) };
      case 'session.delete': {
        this.store.getSession(command.sessionId, principal.id);
        if (this.deletingSessions.has(command.sessionId)) throw new GatewayError('SESSION_BUSY', 'Session deletion is in progress');
        this.deletingSessions.add(command.sessionId);
        try {
          for (const task of [...this.tasks.values()]) if (task.sessionId === command.sessionId) await this.cancelTask(task.id, principal);
          this.store.deleteSession(command.sessionId, principal.id); this.emit(principal.id, { type: 'session.deleted', sessionId: command.sessionId }); return success;
        } finally { this.deletingSessions.delete(command.sessionId); }
      }
      case 'session.selectAgent': {
        const session = this.store.getSession(command.sessionId, principal.id);
        if (this.busy(session.id)) throw new GatewayError('SESSION_BUSY', 'Cancel the active task before changing agent');
        this.availableAgent(command.agentId, command.modelId);
        session.agentId = command.agentId; delete session.modelId; if (command.modelId) session.modelId = command.modelId;
        session.updatedAt = new Date().toISOString(); this.store.saveSession(principal.id, session); this.emit(principal.id, { type: 'session.updated', session });
        return { ...success, sessionId: session.id, session: this.scrub(session) };
      }
      case 'message.send': {
        if (this.settingsBusy) throw new GatewayError('SETTINGS_BUSY', 'Provider reload is in progress');
        const session = this.store.getSession(command.sessionId, principal.id);
        if (this.busy(session.id)) throw new GatewayError('SESSION_BUSY', 'A task is already running in this session');
        const adapter = this.availableAgent(session.agentId, session.modelId); const task = this.newTask(session, principal, adapter);
        if (!session.messages.length && session.title === 'New conversation') session.title = command.content.split('\n')[0].trim().slice(0, 80) || 'New conversation';
        session.messages.push({ id: randomUUID(), role: 'user', content: command.content, createdAt: new Date().toISOString(), taskId: task.id });
        session.updatedAt = new Date().toISOString(); this.store.saveSession(principal.id, session); this.emit(principal.id, { type: 'session.updated', session });
        this.emit(principal.id, { type: 'task.started', taskId: task.id, sessionId: session.id });
        queueMicrotask(() => { void this.runAgent(task, session); });
        return { ...success, sessionId: session.id, taskId: task.id };
      }
      case 'tool.run': {
        if (this.settingsBusy) throw new GatewayError('SETTINGS_BUSY', 'Provider reload is in progress');
        const session = this.store.getSession(command.sessionId, principal.id);
        if (this.busy(session.id)) throw new GatewayError('SESSION_BUSY', 'A task is already running in this session');
        const task = this.newTask(session, principal); this.emit(principal.id, { type: 'task.started', taskId: task.id, sessionId: session.id });
        queueMicrotask(() => { void this.runDirectTool(task, command.invocation); });
        return { ...success, sessionId: session.id, taskId: task.id };
      }
      case 'task.cancel': await this.cancelTask(command.taskId, principal); return success;
      case 'permission.decide': {
        const pending = this.pending.get(command.decision.requestId);
        if (!pending || pending.task.terminal || pending.request.principalId !== principal.id) throw new GatewayError('NOT_FOUND', 'Live permission request not found');
        this.require(principal, pending.request.capability);
        // The decision carries no scope data; grants always copy the original gateway-issued request.
        this.settlePermission(pending, command.decision); return success;
      }
      case 'settings.update': {
        if (this.settingsBusy || this.tasks.size) throw new GatewayError('SETTINGS_BUSY', 'Provider settings require idle tasks');
        this.settingsBusy = true;
        try {
          const settings = validateSettings(command.settings); const previous = this.store.settings(this.localId);
          for (const provider of settings.providers) if (!Object.hasOwn(provider, 'apiKey')) {
            const secret = previous.providers.find(old => old.id === provider.id)?.apiKey;
            if (secret) provider.apiKey = secret;
          }
          this.rememberSecrets(settings);
          const replacement = await this.dependency(Promise.resolve(this.options.onSettingsChanged?.(clone(settings), { signal: this.lifetime.signal })));
          if (replacement) await this.replaceAdapters(replacement);
          if (this.closed) throw new GatewayError('CLOSED', 'Gateway is closed');
          this.store.saveSettings(this.localId, settings); await this.refreshAgents();
          this.emit(principal.id, { type: 'agents.updated', agents: this.agents });
          this.emit(principal.id, { type: 'state.snapshot', snapshot: this.snapshot(principal) }); return success;
        } finally { this.settingsBusy = false; }
      }
      case 'models.refresh': {
        if (this.settingsBusy) throw new GatewayError('SETTINGS_BUSY', 'Provider reload is in progress');
        await this.refreshAgents(command.agentId); this.emit(principal.id, { type: 'agents.updated', agents: this.agents }); return success;
      }
    }
  }
  private newTask(session: Session, principal: Principal, adapter?: AgentAdapter): Task {
    const task: Task = { id: randomUUID(), sessionId: session.id, principal: clone(principal), controller: new AbortController(), adapter, text: '', terminal: false, grants: [], toolQueue: Promise.resolve(), deltaPending: '', outputPending: new Map() };
    this.tasks.set(task.id, task); this.store.startTask(task.id, principal.id, session.id); return task;
  }
  private live(task: Task): boolean { return !this.closed && !task.terminal && !task.controller.signal.aborted; }
  private taskEvent(task: Task, payload: EventPayload): void { if (this.live(task)) this.emit(task.principal.id, payload); }
  private async runAgent(task: Task, session: Session): Promise<void> {
    try {
      if (!this.live(task)) return;
      const context: AgentRunContext = {
        session: this.scrub(clone(session)), taskId: task.id, principal: clone(task.principal), signal: task.controller.signal,
        emit: update => this.agentUpdate(task, update), executeTool: invocation => this.executeTool(task, invocation),
        requestPermission: input => this.issuePermission(task, input)
      };
      await task.adapter!.run(context); await task.toolQueue;
      if (!this.live(task)) return;
      if (task.emittedToolError && !task.emittedToolError.ok) throw new GatewayError(task.emittedToolError.error?.code ?? 'TOOL_FAILED', task.emittedToolError.error?.message ?? 'Tool execution failed');
      if (task.text) {
        const saved = this.store.getSession(task.sessionId, task.principal.id);
        saved.messages.push({ id: randomUUID(), role: 'assistant', content: task.text, taskId: task.id, createdAt: new Date().toISOString() });
        saved.updatedAt = new Date().toISOString(); this.store.saveSession(task.principal.id, this.scrub(saved));
        this.emit(task.principal.id, { type: 'session.updated', session: saved });
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
    const requests: PermissionInput[] = [{ capability: 'tool.execute', reason }];
    for (const path of invocation.paths ?? []) {
      requests.push({ capability: `file.${path.access}`, reason: `Tool ${invocation.id} requests ${path.access} access`, paths: [path] });
    }
    if (invocation.packages?.length) requests.push({ capability: 'library.install', reason: `Install packages for tool ${invocation.id}`, packages: invocation.packages });
    // Check all capabilities before asking for any approvals.
    for (const request of requests) this.require(task.principal, request.capability);
    for (const request of requests) {
      const decision = await this.issuePermission(task, request);
      if (decision.outcome !== 'allow' || !this.live(task)) return denied('Tool permission was denied');
    }
    if (invocation.paths) {
      const checked = await canonicalPaths(invocation.paths, this.store.path);
      if (stableJson(checked) !== stableJson(invocation.paths)) return denied('File target changed after approval');
    }
    if (!this.live(task)) return denied('Task is no longer active');
    const authorization: AuthorizationContext = { principal: clone(task.principal), taskId: task.id, sessionId: task.sessionId, grants: task.grants.map(grant => clone(grant.request)) };
    const context: ToolExecutionContext = {
      authorization, signal: task.controller.signal,
      requestPermission: input => this.issuePermission(task, input),
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
        const session = this.store.getSession(task.sessionId, task.principal.id);
        session.messages.push({ id: randomUUID(), role: 'tool', taskId: task.id, createdAt: new Date().toISOString(), content: JSON.stringify({toolCallId: invocation.id, result}) });
        session.updatedAt = new Date().toISOString(); this.store.saveSession(task.principal.id, session);
        this.emit(task.principal.id, { type: 'session.updated', session });
      }
      return result;
    } finally {
      task.execution = undefined;
    }
  }
  private covers(grant: PermissionRequest, request: PermissionInput): boolean {
    if (grant.capability !== request.capability) return false;
    if (grant.capability === 'tool.execute' && (grant.reason.startsWith('Execute custom Python sha256:') || request.reason.startsWith('Execute custom Python sha256:')) && grant.reason !== request.reason) return false;
    if (request.paths && !request.paths.every(path => grant.paths?.some(allowed => allowed.path === path.path && allowed.access === path.access))) return false;
    if (request.packages && !request.packages.every(pkg => grant.packages?.includes(pkg))) return false;
    return true;
  }
  private async issuePermission(task: Task, raw: PermissionInput): Promise<PermissionDecision> {
    const input = validatePermissionInput(raw); this.require(task.principal, input.capability);
    if (input.capability === 'conversation' || input.capability === 'settings') throw new GatewayError('FORBIDDEN', 'Permission requests are limited to tool capabilities');
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
    if (!this.live(task)) return { requestId: randomUUID(), outcome: 'deny', scope: 'once' };
    const existing = task.grants.find(grant => this.covers(grant.request, input));
    if (existing) return { requestId: existing.request.id, outcome: 'allow', scope: existing.scope };
    const request: PermissionRequest = { ...input, id: randomUUID(), principalId: task.principal.id, sessionId: task.sessionId, taskId: task.id };
    let settle!: (decision: PermissionDecision) => void;
    const promise = new Promise<PermissionDecision>(resolve => { settle = resolve; });
    const pending: Pending = { request, task, promise, resolve: settle }; this.pending.set(request.id, pending);
    // Public full-request API accepts only already registered, byte-equivalent requests.
    const waiting = this.requestPermission(clone(request));
    this.taskEvent(task, { type: 'permission.requested', request }); return waiting;
  }
  async requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    if (this.closed) throw new GatewayError('CLOSED', 'Gateway is closed');
    const pending = this.pending.get(request?.id);
    if (!pending || stableJson(pending.request) !== stableJson(request)) throw new GatewayError('INVALID_PERMISSION', 'Permission must be an unchanged gateway-issued live request');
    return clone(await pending.promise);
  }
  private settlePermission(pending: Pending, decision: PermissionDecision): void {
    if (!this.pending.delete(pending.request.id)) return;
    if (decision.outcome === 'allow' && this.live(pending.task)) {
      const grant = clone(pending.request);
      pending.task.grants.push({ request: grant, scope: decision.scope });
      // Executors keep this context by reference while awaiting additional permissions.
      if (pending.task.execution) pending.task.execution.authorization.grants.push(clone(grant));
    }
    this.emit(pending.request.principalId, { type: 'permission.resolved', requestId: pending.request.id, outcome: decision.outcome });
    pending.resolve(clone(decision));
  }
  private finish(task: Task, status: 'completed' | 'cancelled' | 'failed', error?: {code: string; message: string}): void {
    if (task.terminal) return;
    if (status === 'completed') {
      if (task.deltaPending) this.emit(task.principal.id, { type: 'message.delta', taskId: task.id, sessionId: task.sessionId, text: '[REDACTED]' });
      for (const pending of task.outputPending.values()) if (pending.text) this.emit(task.principal.id, { type: 'tool.output', taskId: task.id, sessionId: task.sessionId, toolCallId: pending.toolCallId, stream: pending.stream, text: '[REDACTED]' });
    }
    task.terminal = true; this.store.finishTask(task.id);
    if (status === 'failed') {
      task.controller.abort();
      void this.cleanup([() => this.options.executor.cancel(task.id), ...(task.adapter ? [() => task.adapter!.cancel(task.id)] : [])]);
    }
    for (const pending of [...this.pending.values()]) if (pending.task === task) this.settlePermission(pending, { requestId: pending.request.id, outcome: 'deny', scope: 'once' });
    task.grants = []; if (task.execution) task.execution.authorization.grants.length = 0;
    this.tasks.delete(task.id);
    if (status === 'failed') this.emit(task.principal.id, { type: 'task.failed', taskId: task.id, sessionId: task.sessionId, error: error ?? { code: 'TASK_FAILED', message: 'Task failed' } });
    else this.emit(task.principal.id, { type: status === 'completed' ? 'task.completed' : 'task.cancelled', taskId: task.id, sessionId: task.sessionId });
  }
  async cancelTask(taskId: string, input: Principal): Promise<void> {
    const principal = this.principal(input); this.require(principal, 'conversation'); string(taskId, 'task id', 256);
    const task = this.tasks.get(taskId);
    if (!task || task.principal.id !== principal.id) throw new GatewayError('NOT_FOUND', 'Active task not found');
    await this.cancel(task);
  }
  private async cancel(task: Task): Promise<void> {
    if (task.terminal) return;
    task.controller.abort(); this.finish(task, 'cancelled');
    await this.cleanup([() => this.options.executor.cancel(task.id), ...(task.adapter ? [() => task.adapter!.cancel(task.id)] : [])]);
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
    let safe = this.scrub(value); let suffix = 0;
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
      await this.cleanup([() => this.options.executor.close(), ...[...this.adapters.values()].map(adapter => () => adapter.close())]);
      this.listeners.clear(); this.pending.clear(); this.store.close();
    })(); return this.closing;
  }
}
