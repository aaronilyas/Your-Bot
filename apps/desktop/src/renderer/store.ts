import type {
  AppSnapshotV2, Bot, CommandPayloadV2, CommandResultV2, DesktopCommandV2, DesktopEventV2, GrantAuditEntry, MemoryEntry,
  OwnerNotification, RoutineRun, SessionV2, StandingGrant, TaskId, BackendTransportV2, DeviceInfo, PermissionRequestV2, Routine,
} from '@your-bot/contracts';
import type { AppearancePrefs } from '../shared/appearance.js';
import type { ProvidersApi, UpdatesApi } from '../shared/ipc.js';

/** The transport the renderer receives: v2 dispatch/subscribe plus the optional native folder picker. */
export interface DesktopTransport extends BackendTransportV2 {
  chooseDirectory?(): Promise<string | undefined>;
  /** Host-stored display preferences; without them the renderer falls back to browser storage. */
  loadAppearance?(): Promise<AppearancePrefs | undefined>;
  saveAppearance?(prefs: AppearancePrefs): Promise<boolean>;
  /** Agent CLI / local model server detection and one-click connect; absent in old hosts. */
  providers?: ProvidersApi;
  /** In-app updates from published releases; absent in old hosts and in the browser. */
  updates?: UpdatesApi;
}
export interface TaskActivity {
  id: TaskId; sessionId: string; status: string; text: string;
  output: { toolCallId: string; stream: 'stdout' | 'stderr' | 'status'; text: string }[];
  running: boolean;
}
export interface DesktopState {
  snapshot: AppSnapshotV2;
  selectedSessionId?: string;
  connection: 'loading' | 'connected' | 'disconnected' | 'error';
  error?: string;
  tasks: Record<string, TaskActivity>;
  pendingCommands: number;
  /** Audit entries, newest first (audit.list pages and live grant.audited events). */
  audit: GrantAuditEntry[];
  /** True once an audit page came back short: there is nothing older to load. */
  auditComplete: boolean;
  /** Memory per bot, as last listed or pushed. */
  memory: Record<string, MemoryEntry[]>;
}
export const emptySnapshot = (): AppSnapshotV2 => ({
  sessions: [], agents: [], settings: { providers: [] }, activeTasks: [], pendingPermissions: [], lastSequence: 0,
  bots: [], grants: [], routines: [], routineRuns: [], notifications: [], skills: [], devices: [], host: { id: '', name: '' },
});
/** Tolerates v1-shaped snapshots: every v2 collection defaults to empty. */
export function normalizeSnapshot(snapshot: Partial<AppSnapshotV2> & Pick<AppSnapshotV2, 'sessions' | 'agents' | 'settings' | 'activeTasks' | 'pendingPermissions' | 'lastSequence'>): AppSnapshotV2 {
  return { ...emptySnapshot(), ...snapshot, bots: snapshot.bots ?? [], grants: snapshot.grants ?? [], routines: snapshot.routines ?? [], routineRuns: snapshot.routineRuns ?? [], notifications: snapshot.notifications ?? [], skills: snapshot.skills ?? [], devices: snapshot.devices ?? [], host: snapshot.host ?? { id: '', name: '' } };
}
const MAX_OUTPUT = 65536;
const MAX_AUDIT = 1000;
const upsert = <T extends { id: string }>(list: T[], item: T): T[] => list.some(existing => existing.id === item.id) ? list.map(existing => existing.id === item.id ? item : existing) : [...list, item];
const grantActive = (grant: StandingGrant): boolean => !grant.revokedAt && !(grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now());

export class DesktopStore {
  private state: DesktopState = { snapshot: emptySnapshot(), connection: 'loading', tasks: {}, pendingCommands: 0, audit: [], auditComplete: false, memory: {} };
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private generation = 0;
  private syncing?: Promise<void>;
  private syncActive = false;
  private buffered: DesktopEventV2[] = [];
  constructor(private readonly transport: DesktopTransport, private readonly timeoutMs = 15000) {}
  getState = (): DesktopState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<DesktopState>): void { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
  private patchSnapshot(patch: Partial<AppSnapshotV2>): void { this.update({ snapshot: { ...this.state.snapshot, ...patch } }); }
  clearError = (): void => this.update({ error: undefined });
  /** Provider detection API of the host, when it has one. */
  get providers(): ProvidersApi | undefined { return this.transport.providers; }
  /** In-app update API of the host, when it has one. */
  get updates(): UpdatesApi | undefined { return this.transport.updates; }
  get canChooseDirectory(): boolean { return typeof this.transport.chooseDirectory === 'function'; }
  /** Opens the host's native folder dialog; resolves to a path, or undefined if unavailable or cancelled. */
  chooseDirectory = async (): Promise<string | undefined> => {
    try { return await this.transport.chooseDirectory?.(); } catch { return undefined; }
  };
  start = (): (() => void) => {
    this.unsubscribe?.();
    const generation = ++this.generation;
    this.syncing = undefined;
    this.syncActive = false;
    this.buffered = [];
    this.update({ connection: 'loading', error: undefined });
    try {
      this.unsubscribe = this.transport.subscribe(event => { if (generation === this.generation) this.event(event); });
      void this.sync();
    } catch (error) { this.update({ connection: 'disconnected', error: error instanceof Error ? error.message : 'Unable to connect' }); }
    return () => { if (generation === this.generation) { this.generation++; this.unsubscribe?.(); this.unsubscribe = undefined; this.syncing = undefined; this.syncActive = false; this.buffered = []; } };
  };
  /** Resubscribes and replays with state.sync {afterSequence}; events already applied are dropped by sequence. */
  reconnect = (): void => { this.syncing = undefined; this.start(); };
  private applySnapshot(raw: AppSnapshotV2): void {
    const snapshot = normalizeSnapshot(raw);
    if (snapshot.lastSequence < this.state.snapshot.lastSequence) return;
    const tasks = { ...this.state.tasks };
    for (const active of snapshot.activeTasks) {
      tasks[active.id] ??= { ...active, status: 'Working', text: '', output: [], running: true };
      tasks[active.id] = { ...tasks[active.id], running: true };
    }
    for (const task of Object.values(tasks)) {
      if (!snapshot.activeTasks.some(active => active.id === task.id)) tasks[task.id] = { ...task, running: false };
      if (snapshot.sessions.some(session => session.messages.some(message => message.role === 'assistant' && message.taskId === task.id))) tasks[task.id] = { ...tasks[task.id], text: '' };
    }
    this.update({ snapshot, tasks, selectedSessionId: snapshot.sessions.some(s => s.id === this.state.selectedSessionId) ? this.state.selectedSessionId : snapshot.sessions[0]?.id });
  }
  private setSession(session: SessionV2): void {
    const sessions = this.state.snapshot.sessions;
    const current = sessions.find(existing => existing.id === session.id);
    if (current && current.updatedAt > session.updatedAt) return;
    const tasks = { ...this.state.tasks };
    for (const message of session.messages) if (message.role === 'assistant' && message.taskId && tasks[message.taskId]) tasks[message.taskId] = { ...tasks[message.taskId], text: '' };
    this.update({ tasks, snapshot: { ...this.state.snapshot, sessions: sessions.some(s => s.id === session.id) ? sessions.map(s => s.id === session.id ? session : s) : [session, ...sessions] } });
  }
  private setBot(bot: Bot): void { this.patchSnapshot({ bots: upsert(this.state.snapshot.bots, bot) }); }
  private setGrant(grant: StandingGrant): void {
    const rest = this.state.snapshot.grants.filter(existing => existing.id !== grant.id);
    this.patchSnapshot({ grants: grantActive(grant) ? [...rest, grant] : rest });
  }
  private setRoutine(routine: Routine): void { this.patchSnapshot({ routines: upsert(this.state.snapshot.routines, routine) }); }
  private mergeRuns(runs: RoutineRun[]): void {
    let merged = this.state.snapshot.routineRuns;
    for (const run of runs) merged = upsert(merged, run);
    this.patchSnapshot({ routineRuns: merged.sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor)).slice(0, 500) });
  }
  private setNotification(notification: OwnerNotification): void {
    this.patchSnapshot({ notifications: upsert(this.state.snapshot.notifications, notification).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 500) });
  }
  private pushAudit(entry: GrantAuditEntry): void {
    if (this.state.audit.some(existing => existing.id === entry.id)) return;
    this.update({ audit: [entry, ...this.state.audit].slice(0, MAX_AUDIT) });
  }
  private applyResult(payload: CommandPayloadV2, result: Extract<CommandResultV2, { ok: true }>): void {
    if (result.snapshot) this.applySnapshot(result.snapshot);
    if (result.session) this.setSession(result.session);
    if (result.bot) this.setBot(result.bot);
    if (result.grant) this.setGrant(result.grant);
    if (result.routine) this.setRoutine(result.routine);
    if (result.runs) this.mergeRuns(result.runs);
    if (result.devices) this.patchSnapshot({ devices: result.devices });
    if (result.skills) this.patchSnapshot({ skills: result.skills });
    if (result.memory && 'botId' in payload && typeof payload.botId === 'string') this.update({ memory: { ...this.state.memory, [payload.botId]: result.memory } });
    if (payload.type === 'audit.list' && result.audit) {
      const known = new Set(this.state.audit.map(entry => entry.id));
      const audit = (payload.beforeId ? [...this.state.audit, ...result.audit.filter(entry => !known.has(entry.id))] : result.audit).slice(0, MAX_AUDIT);
      this.update({ audit, auditComplete: result.audit.length < (payload.limit ?? 50) });
    }
    if ((payload.type === 'session.create' || payload.type === 'bot.session.create') && result.sessionId) this.update({ selectedSessionId: result.sessionId });
    if (payload.type === 'notification.ack') this.patchSnapshot({ notifications: this.state.snapshot.notifications.map(n => n.id === payload.notificationId ? { ...n, acknowledgedAt: n.acknowledgedAt ?? new Date().toISOString() } : n) });
    if (payload.type === 'bot.delete') this.removeBot(payload.botId);
    if (payload.type === 'routine.delete') this.patchSnapshot({ routines: this.state.snapshot.routines.filter(r => r.id !== payload.routineId), routineRuns: this.state.snapshot.routineRuns.filter(r => r.routineId !== payload.routineId) });
    if (payload.type === 'grant.revoke') this.patchSnapshot({ grants: this.state.snapshot.grants.filter(g => g.id !== payload.grantId) });
    if (payload.type === 'device.revoke') this.patchSnapshot({ devices: this.state.snapshot.devices.map(d => d.id === payload.deviceId ? { ...d, revokedAt: d.revokedAt ?? new Date().toISOString() } : d) });
  }
  private removeBot(botId: string): void {
    const snapshot = this.state.snapshot;
    const memory = { ...this.state.memory }; delete memory[botId];
    this.update({ memory, snapshot: { ...snapshot, bots: snapshot.bots.filter(b => b.id !== botId), grants: snapshot.grants.filter(g => g.botId !== botId), routines: snapshot.routines.filter(r => r.botId !== botId) } });
  }
  async command(payload: CommandPayloadV2): Promise<CommandResultV2 | undefined> {
    const generation = this.generation;
    // IPC preserves undefined properties; the wire contract is JSON (null is meaningful and is kept).
    const command: DesktopCommandV2 = JSON.parse(JSON.stringify({ ...payload, version: 2, id: crypto.randomUUID() }));
    this.update({ pendingCommands: this.state.pendingCommands + 1 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.transport.dispatch(command),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('The backend did not respond. Reconnect to refresh its state.')), this.timeoutMs); }),
      ]);
      if (generation !== this.generation) return undefined;
      if (!result.ok) {
        this.update({ error: result.error.message, ...(result.error.code === 'DISCONNECTED' ? { connection: 'disconnected' as const } : {}) });
      } else this.applyResult(payload, result);
      return result;
    } catch (error) {
      if (generation === this.generation) this.update({ connection: 'disconnected', error: error instanceof Error ? error.message : 'Backend connection lost' });
      return undefined;
    } finally { clearTimeout(timer); this.update({ pendingCommands: Math.max(0, this.state.pendingCommands - 1) }); }
  }
  private sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    const generation = this.generation;
    this.syncActive = true;
    this.syncing = (async () => {
      const result = await this.command({ type: 'state.sync', afterSequence: this.state.snapshot.lastSequence });
      if (generation === this.generation) this.update({ connection: result?.ok ? 'connected' : this.state.connection === 'disconnected' ? 'disconnected' : 'error' });
    })().finally(() => {
      if (generation !== this.generation) return;
      this.syncing = undefined;
      this.syncActive = false;
      const buffered = this.buffered; this.buffered = [];
      for (const event of buffered.sort((a, b) => a.sequence - b.sequence)) this.event(event, true);
    });
    return this.syncing;
  }
  async selectSession(id: string): Promise<void> {
    this.update({ selectedSessionId: id });
    await this.command({ type: 'session.open', sessionId: id });
  }
  private event(event: DesktopEventV2, replay = false): void {
    if (this.syncActive) { this.buffered.push(event); return; }
    if ((event.version !== 1 && event.version !== 2) || !Number.isSafeInteger(event.sequence) || event.sequence <= this.state.snapshot.lastSequence) return;
    if (event.type === 'state.snapshot') { this.applySnapshot(event.snapshot); this.update({ connection: 'connected' }); return; }
    if (!replay && event.sequence > this.state.snapshot.lastSequence + 1) { this.buffered.push(event); void this.sync(); return; }
    this.update({ snapshot: { ...this.state.snapshot, lastSequence: event.sequence }, connection: 'connected' });
    if (this.v2Event(event)) return;
    if (event.type === 'session.updated') { this.setSession(event.session); return; }
    if (event.type === 'session.deleted') {
      const sessions = this.state.snapshot.sessions.filter(s => s.id !== event.sessionId);
      const tasks = Object.fromEntries(Object.entries(this.state.tasks).filter(([, task]) => task.sessionId !== event.sessionId));
      this.update({ tasks, selectedSessionId: this.state.selectedSessionId === event.sessionId ? sessions[0]?.id : this.state.selectedSessionId, snapshot: { ...this.state.snapshot, sessions, activeTasks: this.state.snapshot.activeTasks.filter(t => t.sessionId !== event.sessionId), pendingPermissions: this.state.snapshot.pendingPermissions.filter(p => p.sessionId !== event.sessionId) } }); return;
    }
    if (event.type === 'agents.updated') { this.patchSnapshot({ agents: event.agents }); return; }
    if (event.type === 'permission.requested') { this.addRequest(event.request); return; }
    if (event.type === 'permission.resolved') { this.patchSnapshot({ pendingPermissions: this.state.snapshot.pendingPermissions.filter(p => p.id !== event.requestId) }); return; }
    if (!('taskId' in event)) return;
    const task: TaskActivity = { ...(this.state.tasks[event.taskId] ?? { id: event.taskId, sessionId: event.sessionId, status: 'Working', text: '', output: [], running: true }) };
    switch (event.type) {
      case 'task.started': task.running = true; task.status = 'Thinking'; break;
      case 'message.delta': task.text = (task.text + event.text).slice(-262144); break;
      case 'task.status': task.status = event.status; break;
      case 'tool.output': task.output = [...task.output, { toolCallId: event.toolCallId, stream: event.stream, text: event.text.slice(-MAX_OUTPUT) }].slice(-80); break;
      case 'task.completed': task.running = false; task.status = 'Completed'; break;
      case 'task.cancelled': task.running = false; task.status = 'Cancelled'; break;
      case 'task.failed': task.running = false; task.status = 'Failed'; this.update({ error: event.error.message }); break;
    }
    const activeTasks = this.state.snapshot.activeTasks.filter(t => t.id !== task.id);
    if (task.running) activeTasks.push({ id: task.id, sessionId: task.sessionId });
    this.update({ tasks: { ...this.state.tasks, [task.id]: task }, snapshot: { ...this.state.snapshot, activeTasks, pendingPermissions: task.running ? this.state.snapshot.pendingPermissions : this.state.snapshot.pendingPermissions.filter(p => p.taskId !== task.id) } });
  }
  private addRequest(request: PermissionRequestV2): void {
    this.patchSnapshot({ pendingPermissions: [...this.state.snapshot.pendingPermissions.filter(p => p.id !== request.id), request] });
  }
  /** Handles events defined by contract v2; returns true when consumed. */
  private v2Event(event: DesktopEventV2): boolean {
    switch (event.type) {
      case 'bot.updated': this.setBot(event.bot); return true;
      case 'bot.deleted': this.removeBot(event.botId); return true;
      case 'grant.updated': this.setGrant(event.grant); return true;
      case 'grant.audited': this.pushAudit(event.entry); return true;
      case 'memory.updated': this.update({ memory: { ...this.state.memory, [event.botId]: event.memory } }); return true;
      case 'routine.updated': this.setRoutine(event.routine); return true;
      case 'routine.deleted': this.patchSnapshot({ routines: this.state.snapshot.routines.filter(r => r.id !== event.routineId), routineRuns: this.state.snapshot.routineRuns.filter(r => r.routineId !== event.routineId) }); return true;
      case 'routine.run': this.mergeRuns([event.run]); return true;
      case 'notification': this.setNotification(event.notification); return true;
      case 'device.updated': this.patchSnapshot({ devices: upsert(this.state.snapshot.devices, event.device as DeviceInfo) }); return true;
      case 'skills.updated': this.patchSnapshot({ skills: event.skills }); return true;
      default: return false;
    }
  }
}
