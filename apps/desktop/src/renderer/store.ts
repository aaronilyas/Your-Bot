import type { AppSnapshot, BackendTransport, CommandPayload, CommandResult, DesktopCommand, DesktopEvent, Session, TaskId } from '@your-bot/contracts';
export interface TaskActivity {
  id: TaskId; sessionId: string; status: string; text: string;
  output: { toolCallId: string; stream: 'stdout' | 'stderr' | 'status'; text: string }[];
  running: boolean;
}
export interface DesktopState {
  snapshot: AppSnapshot;
  selectedSessionId?: string;
  connection: 'loading' | 'connected' | 'disconnected' | 'error';
  error?: string;
  tasks: Record<string, TaskActivity>;
  pendingCommands: number;
}
export const emptySnapshot = (): AppSnapshot => ({ sessions: [], agents: [], settings: { providers: [] }, activeTasks: [], pendingPermissions: [], lastSequence: 0 });
const MAX_OUTPUT = 65536;
export class DesktopStore {
  private state: DesktopState = { snapshot: emptySnapshot(), connection: 'loading', tasks: {}, pendingCommands: 0 };
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private generation = 0;
  private syncing?: Promise<void>;
  private syncActive = false;
  private buffered: DesktopEvent[] = [];
  constructor(private readonly transport: BackendTransport, private readonly timeoutMs = 15000) {}
  getState = (): DesktopState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<DesktopState>): void { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
  clearError = (): void => this.update({ error: undefined });
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
  reconnect = (): void => { this.syncing = undefined; this.start(); };
  private applySnapshot(snapshot: AppSnapshot): void {
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
  private setSession(session: Session): void {
    const sessions = this.state.snapshot.sessions;
    const current = sessions.find(existing => existing.id === session.id);
    if (current && current.updatedAt > session.updatedAt) return;
    const tasks = { ...this.state.tasks };
    for (const message of session.messages) if (message.role === 'assistant' && message.taskId && tasks[message.taskId]) tasks[message.taskId] = { ...tasks[message.taskId], text: '' };
    this.update({ tasks, snapshot: { ...this.state.snapshot, sessions: sessions.some(s => s.id === session.id) ? sessions.map(s => s.id === session.id ? session : s) : [session, ...sessions] } });
  }
  async command(payload: CommandPayload): Promise<CommandResult | undefined> {
    const generation = this.generation;
    // IPC preserves undefined properties; the wire contract is JSON. Normalize
    // optional fields consistently with the future WebSocket transport.
    const command: DesktopCommand = JSON.parse(JSON.stringify({ ...payload, version: 1, id: crypto.randomUUID() }));
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
      } else {
        if (result.snapshot) this.applySnapshot(result.snapshot);
        if (result.session) this.setSession(result.session);
        if (payload.type === 'session.create' && result.sessionId) this.update({ selectedSessionId: result.sessionId });
      }
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
  private event(event: DesktopEvent, replay = false): void {
    if (this.syncActive) { this.buffered.push(event); return; }
    if (event.version !== 1 || !Number.isSafeInteger(event.sequence) || event.sequence <= this.state.snapshot.lastSequence) return;
    if (event.type === 'state.snapshot') { this.applySnapshot(event.snapshot); this.update({ connection: 'connected' }); return; }
    if (!replay && event.sequence > this.state.snapshot.lastSequence + 1) { this.buffered.push(event); void this.sync(); return; }
    this.update({ snapshot: { ...this.state.snapshot, lastSequence: event.sequence }, connection: 'connected' });
    if (event.type === 'session.updated') { this.setSession(event.session); return; }
    if (event.type === 'session.deleted') {
      const sessions = this.state.snapshot.sessions.filter(s => s.id !== event.sessionId);
      const tasks = Object.fromEntries(Object.entries(this.state.tasks).filter(([, task]) => task.sessionId !== event.sessionId));
      this.update({ tasks, selectedSessionId: this.state.selectedSessionId === event.sessionId ? sessions[0]?.id : this.state.selectedSessionId, snapshot: { ...this.state.snapshot, sessions, activeTasks: this.state.snapshot.activeTasks.filter(t => t.sessionId !== event.sessionId), pendingPermissions: this.state.snapshot.pendingPermissions.filter(p => p.sessionId !== event.sessionId) } }); return;
    }
    if (event.type === 'agents.updated') { this.update({ snapshot: { ...this.state.snapshot, agents: event.agents } }); return; }
    if (event.type === 'permission.requested') {
      this.update({ snapshot: { ...this.state.snapshot, pendingPermissions: [...this.state.snapshot.pendingPermissions.filter(p => p.id !== event.request.id), event.request] } }); return;
    }
    if (event.type === 'permission.resolved') {
      this.update({ snapshot: { ...this.state.snapshot, pendingPermissions: this.state.snapshot.pendingPermissions.filter(p => p.id !== event.requestId) } }); return;
    }
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
}
