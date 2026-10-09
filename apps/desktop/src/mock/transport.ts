import type { BackendTransport, AppSnapshot, DesktopEvent, EventPayload, DesktopCommand, CommandResult, PermissionRequest } from '@your-bot/contracts';
export interface MockTransportOptions { chunkDelayMs?: number; permissionDemo?: boolean; }
/** In-memory browser demonstration only. Never executes tools, connects providers, or touches files. */
export function createMockTransport(options: MockTransportOptions = {}): BackendTransport {
  const now = () => new Date().toISOString();
  const listeners = new Set<(event: DesktopEvent) => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const continuations = new Map<string, (allow: boolean) => void>();
  const results = new Map<string, CommandResult>();
  let closed = false;
  const snapshot: AppSnapshot = {
    sessions: [{ id: 'welcome', title: 'A fresh perspective', agentId: 'local-demo', modelId: 'demo-model', createdAt: now(), updatedAt: now(), messages: [{ id: 'intro', role: 'assistant', content: 'Hello. I’m Your Bot, your local thinking partner.\n\nWe can work through an idea, draft something together, or explore your workspace with your permission. What would you like to do?', createdAt: now() }] }],
    agents: [{ id: 'local-demo', name: 'Local assistant', kind: 'local', models: [{ id: 'demo-model', name: 'Demo · local' }, { id: 'demo-reasoning', name: 'Demo · reasoning' }], available: true }, { id: 'acp-demo', name: 'Coding agent', kind: 'acp', models: [{ id: 'demo-code', name: 'Demo · code' }], available: true, limitation: 'Browser demonstration; no process is launched.' }],
    settings: { providers: [{ id: 'local-provider', name: 'LM Studio', kind: 'lmstudio', endpoint: 'http://127.0.0.1:1234/v1', enabled: true }] }, activeTasks: [], pendingPermissions: [], lastSequence: 0,
  };
  const clone = <T,>(value: T): T => structuredClone(value);
  const emit = (payload: EventPayload): void => {
    if (closed) return;
    const event = { ...payload, version: 1 as const, sequence: ++snapshot.lastSequence, timestamp: now(), principalId: 'demo-owner' };
    listeners.forEach(fn => fn(clone(event)));
  };
  const stop = (taskId: string, sessionId: string, cancelled = false): void => {
    clearTimeout(timers.get(taskId)); timers.delete(taskId);
    for (const request of snapshot.pendingPermissions.filter(p => p.taskId === taskId)) continuations.delete(request.id);
    snapshot.pendingPermissions = snapshot.pendingPermissions.filter(p => p.taskId !== taskId);
    snapshot.activeTasks = snapshot.activeTasks.filter(t => t.id !== taskId);
    emit({ type: cancelled ? 'task.cancelled' : 'task.completed', taskId, sessionId });
  };
  const run = (taskId: string, sessionId: string, input: string): void => {
    const session = snapshot.sessions.find(s => s.id === sessionId)!;
    const response = /workspace|file|read/i.test(input)
      ? 'The permission flow is ready. This browser demonstration uses simulated file activity; no files were accessed.\n\nWith the real gateway connected, your agent can inspect only the exact paths you approve. You stay in control of each task.'
      : 'Let’s make this concrete. Start with the outcome you want, then identify the smallest useful next step.\n\nI can help you shape a plan, compare approaches, or turn a rough idea into a clear draft. This is a simulated reply; connect your local provider to start a real conversation.';
    const chunks = response.match(/.{1,14}/gs) ?? [];
    let index = 0, content = '';
    emit({ type: 'task.status', taskId, sessionId, status: 'Writing a response' });
    const tick = (): void => {
      if (closed || !snapshot.activeTasks.some(t => t.id === taskId)) return;
      const text = chunks[index++];
      if (text !== undefined) {
        content += text; emit({ type: 'message.delta', taskId, sessionId, text });
        timers.set(taskId, setTimeout(tick, options.chunkDelayMs ?? 35));
      } else {
        session.messages.push({ id: crypto.randomUUID(), role: 'assistant', content, taskId, createdAt: now() });
        session.updatedAt = now(); emit({ type: 'session.updated', session: clone(session) }); stop(taskId, sessionId);
      }
    };
    timers.set(taskId, setTimeout(tick, options.chunkDelayMs ?? 35));
  };
  const dispatch = async (command: DesktopCommand): Promise<CommandResult> => {
    if (closed) return { ok: false, commandId: command.id, error: { code: 'DISCONNECTED', message: 'The demo transport is closed', retryable: true } };
    const previous = results.get(command.id); if (previous) return clone(previous);
    const success = (extra: object = {}): CommandResult => ({ ok: true, commandId: command.id, ...extra });
    const failure = (message: string): CommandResult => ({ ok: false, commandId: command.id, error: { code: 'DEMO_ERROR', message } });
    const session = 'sessionId' in command ? snapshot.sessions.find(s => s.id === command.sessionId) : undefined;
    let result: CommandResult;
    switch (command.type) {
      case 'state.sync': result = success({ snapshot: clone(snapshot) }); break;
      case 'session.create': {
        const agent = snapshot.agents.find(a => a.id === command.agentId && a.available);
        if (!agent) { result = failure('Choose an available agent'); break; }
        const created = { id: crypto.randomUUID(), title: command.title ?? 'New conversation', agentId: command.agentId, modelId: command.modelId ?? agent.models[0]?.id, createdAt: now(), updatedAt: now(), messages: [] };
        snapshot.sessions.unshift(created); emit({ type: 'session.updated', session: clone(created) }); result = success({ sessionId: created.id, session: clone(created) }); break;
      }
      case 'session.open': result = session ? success({ session: clone(session) }) : failure('Conversation not found'); break;
      case 'session.delete':
        if (!session) { result = failure('Conversation not found'); break; }
        snapshot.activeTasks.filter(t => t.sessionId === session.id).forEach(t => stop(t.id, session.id, true));
        snapshot.sessions = snapshot.sessions.filter(s => s.id !== session.id); emit({ type: 'session.deleted', sessionId: session.id }); result = success(); break;
      case 'session.selectAgent': {
        if (!session) { result = failure('Conversation not found'); break; }
        if (snapshot.activeTasks.some(t => t.sessionId === session.id)) { result = failure('Stop the current task before changing agents'); break; }
        const agent = snapshot.agents.find(a => a.id === command.agentId && a.available);
        if (!agent || command.modelId && !agent.models.some(m => m.id === command.modelId)) { result = failure('Agent or model is unavailable'); break; }
        session.agentId = command.agentId; session.modelId = command.modelId ?? agent.models[0]?.id; session.updatedAt = now();
        emit({ type: 'session.updated', session: clone(session) }); result = success(); break;
      }
      case 'message.send': {
        if (!session) { result = failure('Conversation not found'); break; }
        if (snapshot.activeTasks.some(t => t.sessionId === session.id)) { result = failure('A task is already running'); break; }
        if (!command.content.trim()) { result = failure('Write a message first'); break; }
        const taskId = crypto.randomUUID();
        session.messages.push({ id: crypto.randomUUID(), role: 'user', content: command.content, createdAt: now(), taskId });
        if (session.title === 'New conversation') session.title = command.content.slice(0, 44);
        session.updatedAt = now(); emit({ type: 'session.updated', session: clone(session) });
        snapshot.activeTasks.push({ id: taskId, sessionId: session.id }); emit({ type: 'task.started', taskId, sessionId: session.id });
        if (options.permissionDemo !== false && /workspace|file|read/i.test(command.content)) {
          const request: PermissionRequest = { id: crypto.randomUUID(), principalId: 'demo-owner', sessionId: session.id, taskId, capability: 'file.read', reason: 'Inspect the project overview to understand your workspace.', paths: [{ path: '/demo/workspace/README.md', access: 'read' }] };
          snapshot.pendingPermissions.push(request);
          continuations.set(request.id, allow => {
            if (allow) { emit({ type: 'tool.output', taskId, sessionId: session.id, toolCallId: 'demo-read', stream: 'status', text: 'Simulated read: /demo/workspace/README.md' }); run(taskId, session.id, command.content); }
            else { emit({ type: 'task.status', taskId, sessionId: session.id, status: 'Permission denied' }); stop(taskId, session.id, true); }
          });
          emit({ type: 'task.status', taskId, sessionId: session.id, status: 'Waiting for permission' }); emit({ type: 'permission.requested', request });
        } else run(taskId, session.id, command.content);
        result = success({ taskId, sessionId: session.id }); break;
      }
      case 'task.cancel': {
        const active = snapshot.activeTasks.find(t => t.id === command.taskId);
        if (!active) { result = failure('Task is no longer running'); break; }
        stop(active.id, active.sessionId, true); result = success(); break;
      }
      case 'permission.decide': {
        const request = snapshot.pendingPermissions.find(p => p.id === command.decision.requestId);
        if (!request) { result = failure('Permission request is no longer pending'); break; }
        snapshot.pendingPermissions = snapshot.pendingPermissions.filter(p => p.id !== request.id);
        emit({ type: 'permission.resolved', requestId: request.id, outcome: command.decision.outcome });
        const resume = continuations.get(request.id); continuations.delete(request.id); resume?.(command.decision.outcome === 'allow'); result = success(); break;
      }
      case 'settings.update': snapshot.settings = clone({ providers: command.settings.providers.map(({ apiKey: _secret, ...provider }) => provider) }); emit({ type: 'state.snapshot', snapshot: { ...clone(snapshot), lastSequence: snapshot.lastSequence + 1 } }); result = success({ snapshot: clone(snapshot) }); break;
      case 'models.refresh': emit({ type: 'agents.updated', agents: clone(snapshot.agents) }); result = success(); break;
      case 'tool.run': result = failure('Direct tool execution is not available in browser demonstration mode'); break;
    }
    results.set(command.id, clone(result)); if (results.size > 500) results.delete(results.keys().next().value!);
    return result;
  };
  return {
    dispatch,
    subscribe(listener) { if (closed) throw new Error('Demo transport is closed'); listeners.add(listener); return () => { listeners.delete(listener); }; },
    async close() { closed = true; timers.forEach(clearTimeout); timers.clear(); continuations.clear(); listeners.clear(); },
  };
}
