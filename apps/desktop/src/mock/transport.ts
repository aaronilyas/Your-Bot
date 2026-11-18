import type {
  AppSnapshotV2, Bot, CommandResultV2, DesktopCommandV2, DesktopEventV2, EventPayloadV2, GrantAuditEntry, MemoryEntry, PermissionRequestV2,
  Routine, RoutineRun, SessionV2, StandingGrant, StandingGrantScope,
} from '@your-bot/contracts';
import type { DesktopTransport } from '../renderer/store';
import type { AgentRowInfo, ProvidersApi } from '../shared/ipc';

export interface MockTransportOptions { chunkDelayMs?: number; permissionDemo?: boolean; }

const V2_EVENTS = new Set(['bot.updated', 'bot.deleted', 'grant.updated', 'grant.audited', 'memory.updated', 'routine.updated', 'routine.deleted', 'routine.run', 'notification', 'device.updated', 'skills.updated', 'state.snapshot', 'session.updated', 'permission.requested']);
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
const ahead = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString();
const within = (path: string, folder: string): boolean => path === folder || path.startsWith(folder.endsWith('/') ? folder : `${folder}/`);

/**
 * In-memory browser demonstration only, and clearly SIMULATED: every bot, approval, grant, routine, device and
 * pairing code below is fabricated. It never executes tools, connects providers, pairs devices or touches files.
 */
export function createMockTransport(options: MockTransportOptions = {}): DesktopTransport {
  const now = () => new Date().toISOString();
  const delay = options.chunkDelayMs ?? 35;
  const listeners = new Set<(event: DesktopEventV2) => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const continuations = new Map<string, (allow: boolean) => void>();
  const results = new Map<string, CommandResultV2>();
  let closed = false;
  const bots: Bot[] = [
    { id: 'bot-assistant', name: 'Local assistant', instructions: 'Be a concise, thoughtful thinking partner.', agentId: 'local-demo', modelId: 'demo-model', profile: 'strict', mcpServers: [], skills: [], memoryEnabled: true, createdAt: ago(900), updatedAt: ago(900) },
    { id: 'bot-coder', name: 'Coding bot (simulated)', instructions: 'Work inside the project workspace. Prefer small, reviewable changes and run the tests.', agentId: 'acp-demo', modelId: 'demo-code', workspace: '/demo/workspace', profile: 'trusted',
      mcpServers: [{ id: 'browser', name: 'Browser automation', enabled: true, preset: 'browser', transport: 'stdio', command: 'npx' }, { id: 'tracker', name: 'Issue tracker', enabled: true, transport: 'http', url: 'https://issues.example.invalid/mcp', headers: { Authorization: '' } }],
      skills: ['summarize'], memoryEnabled: true, compaction: { maxMessages: 60, keepRecent: 12 }, createdAt: ago(800), updatedAt: ago(800) },
  ];
  const snapshot: AppSnapshotV2 = {
    sessions: [
      { id: 'welcome', botId: 'bot-assistant', title: 'A fresh perspective', agentId: 'local-demo', modelId: 'demo-model', createdAt: now(), updatedAt: now(), messages: [{ id: 'intro', role: 'assistant', content: 'Hello. I’m Your Bot, your local thinking partner.\n\nWe can work through an idea, draft something together, or explore your workspace with your permission. What would you like to do?', createdAt: now() }] },
      { id: 'refactor', botId: 'bot-coder', title: 'Tidy the project (simulated)', agentId: 'acp-demo', modelId: 'demo-code', createdAt: ago(120), updatedAt: ago(120), messages: [{ id: 'r1', role: 'user', content: 'Run the tests and tell me what fails.', createdAt: ago(121) }, { id: 'r2', role: 'assistant', content: 'This is a simulated earlier conversation. Try sending “run the tests” to see a command approval.', createdAt: ago(120) }] },
    ],
    agents: [{ id: 'local-demo', name: 'Local assistant', kind: 'local', models: [{ id: 'demo-model', name: 'Demo · local' }, { id: 'demo-reasoning', name: 'Demo · reasoning' }], available: true }, { id: 'acp-demo', name: 'Coding agent', kind: 'acp', models: [{ id: 'demo-code', name: 'Demo · code' }], available: true, limitation: 'Browser demonstration; no process is launched.' }],
    settings: { providers: [{ id: 'local-provider', name: 'LM Studio', kind: 'lmstudio', endpoint: 'http://127.0.0.1:1234/v1', enabled: true }] },
    activeTasks: [], pendingPermissions: [], lastSequence: 0,
    bots,
    grants: [{ id: 'grant-docs', botId: 'bot-coder', capability: 'file.read', scope: { folder: '/demo/workspace/docs' }, createdAt: ago(600), createdBy: 'demo-owner' }],
    routines: [
      { id: 'routine-morning', botId: 'bot-coder', name: 'Morning repo check', prompt: 'Run the test suite and summarise anything that fails.', schedule: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'UTC' }, missedRunPolicy: 'runAll', maxCatchUp: 3, enabled: true, sessionMode: 'new', lastRunAt: ago(1500), nextRunAt: ahead(300), createdAt: ago(5000), updatedAt: ago(5000) },
      { id: 'routine-digest', botId: 'bot-assistant', name: 'Hourly digest', prompt: 'Summarise what changed in my notes.', schedule: { kind: 'interval', everyMinutes: 60 }, missedRunPolicy: 'skip', enabled: false, sessionMode: 'reuse', createdAt: ago(4000), updatedAt: ago(4000) },
    ],
    routineRuns: [
      { id: 'run-1', routineId: 'routine-morning', botId: 'bot-coder', trigger: 'schedule', scheduledFor: ago(1500), status: 'completed', startedAt: ago(1500), finishedAt: ago(1498) },
      { id: 'run-2', routineId: 'routine-morning', botId: 'bot-coder', trigger: 'schedule', scheduledFor: ago(2940), status: 'failed', startedAt: ago(2940), finishedAt: ago(2939), error: { code: 'ADAPTER_ERROR', message: 'Simulated failure: the agent exited unexpectedly.' } },
    ],
    notifications: [
      { id: 'note-1', kind: 'routine.failed', title: 'Morning repo check failed (simulated)', body: 'The agent exited unexpectedly.', botId: 'bot-coder', routineRunId: 'run-2', createdAt: ago(2939) },
      { id: 'note-2', kind: 'device.paired', title: 'Device paired (simulated)', body: 'Phone (simulated) can now answer approvals.', createdAt: ago(3000), acknowledgedAt: ago(2990) },
    ],
    skills: [
      { id: 'summarize', name: 'Summarize', description: 'Condense long text into short, accurate bullet points.', source: 'global', folder: '/demo/skills/summarize' },
      { id: 'release-notes', name: 'Release notes', description: 'Draft release notes from the commit history.', source: 'workspace', folder: '/demo/workspace/.your-bot/skills/release-notes' },
      { id: 'broken-skill', name: 'broken-skill', description: '', source: 'workspace', folder: '/demo/workspace/.your-bot/skills/broken-skill', error: 'SKILL.md is missing a description.' },
    ],
    devices: [{ id: 'device-phone', name: 'Phone (simulated)', capabilities: ['conversation', 'file.read', 'tool.execute'], pairedAt: ago(3000), lastSeenAt: ago(30) }],
    host: { id: 'demo-host', name: 'Demo host (simulated)' },
  };
  const memory: Record<string, MemoryEntry[]> = {
    'bot-assistant': [{ id: 'mem-1', botId: 'bot-assistant', content: 'The owner prefers short answers with one concrete next step.', source: 'owner', createdAt: ago(700) }],
    'bot-coder': [{ id: 'mem-2', botId: 'bot-coder', content: 'Tests run with `npm test`; the lockfile is committed.', source: 'agent', createdAt: ago(500) }],
  };
  const audit: GrantAuditEntry[] = [
    { id: 'audit-3', at: ago(1498), botId: 'bot-coder', taskId: 'task-old', sessionId: 'refactor', requestId: 'req-3', capability: 'file.read', subject: '/demo/workspace/docs/guide.md', outcome: 'allow', via: 'standing', grantId: 'grant-docs', decidedBy: 'demo-owner', routineRunId: 'run-1' },
    { id: 'audit-2', at: ago(1499), botId: 'bot-coder', taskId: 'task-old', sessionId: 'refactor', requestId: 'req-2', capability: 'process.spawn', subject: 'npm test --silent', outcome: 'allow', via: 'interactive', decidedBy: 'demo-owner' },
    { id: 'audit-1', at: ago(2900), botId: 'bot-coder', taskId: 'task-old2', sessionId: 'refactor', requestId: 'req-1', capability: 'file.write', subject: '/etc/hosts', outcome: 'deny', via: 'policy' },
  ];
  let auditCounter = audit.length;
  const clone = <T,>(value: T): T => structuredClone(value);
  const emit = (payload: EventPayloadV2): void => {
    if (closed) return;
    const event = { ...payload, version: V2_EVENTS.has(payload.type) ? 2 as const : 1 as const, sequence: ++snapshot.lastSequence, timestamp: now(), principalId: 'demo-owner' } as DesktopEventV2;
    listeners.forEach(fn => fn(clone(event)));
  };
  const record = (request: PermissionRequestV2, outcome: 'allow' | 'deny', via: GrantAuditEntry['via'], grantId?: string): void => {
    if (!request.botId) return;
    const entry: GrantAuditEntry = { id: `audit-${++auditCounter}`, at: now(), botId: request.botId, taskId: request.taskId, sessionId: request.sessionId, requestId: request.id, capability: request.capability, subject: subjectOf(request), outcome, via, ...(grantId ? { grantId } : {}), ...(via !== 'policy' ? { decidedBy: 'demo-owner' } : {}), ...(request.routineRunId ? { routineRunId: request.routineRunId } : {}) };
    audit.unshift(entry); emit({ type: 'grant.audited', entry: clone(entry) });
  };
  const subjectOf = (r: PermissionRequestV2): string => r.paths?.map(p => p.path).join(', ') ?? (r.command ? [r.command.command, ...r.command.args].join(' ') : r.mcp ? `${r.mcp.serverId}/${r.mcp.tool}` : r.agentTool?.title ?? r.reason);
  const standingFor = (request: PermissionRequestV2): StandingGrant | undefined => snapshot.grants.find(grant => {
    if (grant.botId !== request.botId || grant.capability !== request.capability || grant.revokedAt) return false;
    const s = grant.scope;
    if (request.paths) return Boolean(s.folder) && request.paths.every(p => within(p.path, s.folder!));
    if (request.command) { const argv = [request.command.command, ...request.command.args]; return Boolean(s.commandPrefix) && s.commandPrefix!.every((token, i) => argv[i] === token); }
    if (request.mcp) return s.mcp?.serverId === request.mcp.serverId && (!s.mcp.tool || s.mcp.tool === request.mcp.tool);
    return Boolean(request.agentTool?.kind) && s.agentToolKind === request.agentTool!.kind;
  });
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
        timers.set(taskId, setTimeout(tick, delay));
      } else {
        session.messages.push({ id: crypto.randomUUID(), role: 'assistant', content, taskId, createdAt: now() });
        session.updatedAt = now(); emit({ type: 'session.updated', session: clone(session) }); stop(taskId, sessionId);
      }
    };
    timers.set(taskId, setTimeout(tick, delay));
  };
  /** Demonstration requests chosen from the message wording; each goes through standing grants first. */
  const demoRequest = (session: SessionV2, taskId: string, content: string): PermissionRequestV2 | undefined => {
    const base = { id: crypto.randomUUID(), principalId: 'demo-owner', sessionId: session.id, taskId, ...(session.botId ? { botId: session.botId } : {}) };
    if (/workspace|file|read/i.test(content)) return { ...base, capability: 'file.read', reason: 'Inspect the project overview to understand your workspace.', paths: [{ path: '/demo/workspace/README.md', access: 'read' }] };
    if (/\b(run|test|build|command)\b/i.test(content)) return { ...base, capability: 'process.spawn', reason: 'Run the test suite in the workspace.', command: { command: 'npm', args: ['test', '--silent'], cwd: '/demo/workspace' } };
    if (/browser|web|search/i.test(content)) return { ...base, capability: 'mcp.call', reason: 'Open a page with the browser tool.', mcp: { serverId: 'browser', tool: 'browser_navigate' } };
    if (/edit|refactor|write/i.test(content)) return { ...base, capability: 'tool.execute', reason: 'The agent wants to edit a file.', agentTool: { toolCallId: crypto.randomUUID(), title: 'Edit src/index.ts', kind: 'edit' } };
    return undefined;
  };
  const upsertRun = (runRecord: RoutineRun): void => { snapshot.routineRuns = [runRecord, ...snapshot.routineRuns.filter(r => r.id !== runRecord.id)]; emit({ type: 'routine.run', run: clone(runRecord) }); };
  const notify = (notification: Omit<(typeof snapshot.notifications)[number], 'id' | 'createdAt'>): void => {
    const full = { ...notification, id: crypto.randomUUID(), createdAt: now() };
    snapshot.notifications.unshift(full); emit({ type: 'notification', notification: clone(full) });
  };
  const startRoutine = (routine: Routine): RoutineRun => {
    const bot = bots.find(b => b.id === routine.botId)!;
    const taskId = crypto.randomUUID();
    const session: SessionV2 = { id: crypto.randomUUID(), botId: bot.id, title: `${routine.name} (simulated run)`, agentId: bot.agentId, ...(bot.modelId ? { modelId: bot.modelId } : {}), createdAt: now(), updatedAt: now(), messages: [{ id: crypto.randomUUID(), role: 'user', content: routine.prompt, createdAt: now(), taskId }] };
    snapshot.sessions.unshift(session); emit({ type: 'session.updated', session: clone(session) });
    const runRecord: RoutineRun = { id: crypto.randomUUID(), routineId: routine.id, botId: bot.id, trigger: 'manual', scheduledFor: now(), status: 'running', sessionId: session.id, taskId, startedAt: now() };
    upsertRun(runRecord);
    const finish = (status: RoutineRun['status'], error?: RoutineRun['error']): void => { upsertRun({ ...runRecord, status, finishedAt: now(), blockedOn: undefined, ...(error ? { error } : {}) }); routine.lastRunAt = now(); emit({ type: 'routine.updated', routine: clone(routine) }); };
    timers.set(runRecord.id, setTimeout(() => {
      if (closed) return;
      if (bot.profile !== 'trusted' || options.permissionDemo === false) { finish('completed'); return; }
      const request: PermissionRequestV2 = { id: crypto.randomUUID(), principalId: 'demo-owner', sessionId: session.id, taskId, botId: bot.id, routineRunId: runRecord.id, capability: 'process.spawn', reason: 'Routine run: execute the test suite.', command: { command: 'npm', args: ['test', '--silent'], cwd: bot.workspace ?? '/demo/workspace' } };
      const grant = standingFor(request);
      if (grant) { record(request, 'allow', 'standing', grant.id); finish('completed'); return; }
      snapshot.pendingPermissions.push(request); snapshot.activeTasks.push({ id: taskId, sessionId: session.id });
      continuations.set(request.id, allow => { snapshot.activeTasks = snapshot.activeTasks.filter(t => t.id !== taskId); if (allow) finish('completed'); else finish('failed', { code: 'PERMISSION_DENIED', message: 'You denied the request this run was waiting on.' }); });
      upsertRun({ ...runRecord, status: 'blocked', blockedOn: [request.id] });
      notify({ kind: 'approval.required', title: `${routine.name} needs approval (simulated)`, body: `Run the command: npm test --silent`, botId: bot.id, routineRunId: runRecord.id, requestId: request.id });
      emit({ type: 'permission.requested', request: clone(request) });
    }, delay * 3));
    return runRecord;
  };
  const dispatch = async (command: DesktopCommandV2): Promise<CommandResultV2> => {
    if (closed) return { ok: false, commandId: command.id, error: { code: 'DISCONNECTED', message: 'The demo transport is closed', retryable: true } };
    const previous = results.get(command.id); if (previous) return clone(previous);
    const success = (extra: object = {}): CommandResultV2 => ({ ok: true, commandId: command.id, ...extra });
    const failure = (message: string, code = 'DEMO_ERROR'): CommandResultV2 => ({ ok: false, commandId: command.id, error: { code, message } });
    const session = 'sessionId' in command ? snapshot.sessions.find(s => s.id === command.sessionId) : undefined;
    let result: CommandResultV2;
    switch (command.type) {
      case 'state.sync': result = success({ snapshot: clone(snapshot) }); break;
      case 'session.create': case 'bot.session.create': {
        const bot = command.type === 'bot.session.create' ? bots.find(b => b.id === command.botId) : bots.find(b => b.agentId === command.agentId && b.profile === 'strict') ?? bots[0];
        const agentId = command.type === 'bot.session.create' ? bot?.agentId : command.agentId;
        const agent = snapshot.agents.find(a => a.id === agentId && a.available);
        if (!agent || (command.type === 'bot.session.create' && !bot)) { result = failure(command.type === 'bot.session.create' ? 'Bot not found' : 'Choose an available agent'); break; }
        const modelId = command.type === 'bot.session.create' ? bot!.modelId ?? agent.models[0]?.id : command.modelId ?? agent.models[0]?.id;
        const created: SessionV2 = { id: crypto.randomUUID(), ...(bot ? { botId: bot.id } : {}), title: command.title ?? 'New conversation', agentId: agent.id, ...(modelId ? { modelId } : {}), createdAt: now(), updatedAt: now(), messages: [] };
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
      case 'session.compact': result = session ? success({ session: clone(session) }) : failure('Conversation not found'); break;
      case 'message.send': {
        if (!session) { result = failure('Conversation not found'); break; }
        if (snapshot.activeTasks.some(t => t.sessionId === session.id)) { result = failure('A task is already running'); break; }
        if (!command.content.trim()) { result = failure('Write a message first'); break; }
        const taskId = crypto.randomUUID();
        session.messages.push({ id: crypto.randomUUID(), role: 'user', content: command.content, createdAt: now(), taskId });
        if (session.title === 'New conversation') session.title = command.content.slice(0, 44);
        session.updatedAt = now(); emit({ type: 'session.updated', session: clone(session) });
        snapshot.activeTasks.push({ id: taskId, sessionId: session.id }); emit({ type: 'task.started', taskId, sessionId: session.id });
        const request = options.permissionDemo !== false ? demoRequest(session, taskId, command.content) : undefined;
        const grant = request && standingFor(request);
        if (request && grant) {
          record(request, 'allow', 'standing', grant.id);
          emit({ type: 'tool.output', taskId, sessionId: session.id, toolCallId: 'demo-standing', stream: 'status', text: `Simulated: allowed by your standing grant (${subjectOf(request)})` }); run(taskId, session.id, command.content);
        } else if (request) {
          snapshot.pendingPermissions.push(request);
          continuations.set(request.id, allow => {
            if (allow) { emit({ type: 'tool.output', taskId, sessionId: session.id, toolCallId: 'demo-read', stream: 'status', text: request.capability === 'file.read' ? `Simulated read: ${request.paths?.[0]?.path}` : `Simulated ${request.capability}: ${subjectOf(request)}` }); run(taskId, session.id, command.content); }
            else { emit({ type: 'task.status', taskId, sessionId: session.id, status: 'Permission denied' }); stop(taskId, session.id, true); }
          });
          emit({ type: 'task.status', taskId, sessionId: session.id, status: 'Waiting for permission' }); emit({ type: 'permission.requested', request: clone(request) });
        } else run(taskId, session.id, command.content);
        result = success({ taskId, sessionId: session.id }); break;
      }
      case 'task.cancel': {
        const active = snapshot.activeTasks.find(t => t.id === command.taskId);
        if (!active) { result = failure('Task is no longer running'); break; }
        stop(active.id, active.sessionId, true); result = success(); break;
      }
      case 'permission.decide': {
        const decision = command.decision;
        const request = snapshot.pendingPermissions.find(p => p.id === decision.requestId);
        if (!request) { result = failure('Permission request is no longer pending'); break; }
        let grantId: string | undefined;
        if (decision.scope === 'standing') {
          if (!decision.standing || !request.botId) { result = failure('A standing decision needs a scope', 'STANDING_FORBIDDEN'); break; }
          const grant: StandingGrant = { id: crypto.randomUUID(), botId: request.botId, capability: request.capability, scope: clone(decision.standing as StandingGrantScope), createdAt: now(), createdBy: 'demo-owner', ...(decision.standingExpiresAt ? { expiresAt: decision.standingExpiresAt } : {}) };
          snapshot.grants.push(grant); grantId = grant.id; emit({ type: 'grant.updated', grant: clone(grant) });
        }
        snapshot.pendingPermissions = snapshot.pendingPermissions.filter(p => p.id !== request.id);
        record(request, decision.outcome, 'interactive', grantId);
        emit({ type: 'permission.resolved', requestId: request.id, outcome: decision.outcome });
        const resume = continuations.get(request.id); continuations.delete(request.id); resume?.(decision.outcome === 'allow'); result = success(); break;
      }
      case 'settings.update': snapshot.settings = clone({ providers: command.settings.providers.map(({ apiKey: _secret, ...provider }) => provider) }); emit({ type: 'state.snapshot', snapshot: { ...clone(snapshot), lastSequence: snapshot.lastSequence + 1 } }); result = success({ snapshot: clone(snapshot) }); break;
      case 'models.refresh': emit({ type: 'agents.updated', agents: clone(snapshot.agents) }); result = success(); break;
      case 'tool.run': result = failure('Direct tool execution is not available in browser demonstration mode'); break;
      case 'bot.create': {
        const bot: Bot = { ...clone(command.bot), id: crypto.randomUUID(), createdAt: now(), updatedAt: now() };
        if (bot.profile === 'trusted' && !bot.workspace) { result = failure('Trusted bots need a workspace', 'INVALID_WORKSPACE'); break; }
        bots.push(bot); emit({ type: 'bot.updated', bot: clone(bot) }); result = success({ bot: clone(bot) }); break;
      }
      case 'bot.update': {
        const bot = bots.find(b => b.id === command.botId);
        if (!bot) { result = failure('Bot not found', 'NOT_FOUND'); break; }
        for (const [key, value] of Object.entries(command.patch)) { if (value === null) delete (bot as unknown as Record<string, unknown>)[key]; else (bot as unknown as Record<string, unknown>)[key] = clone(value); }
        if (bot.profile === 'trusted' && !bot.workspace) { result = failure('Trusted bots need a workspace', 'INVALID_WORKSPACE'); break; }
        bot.updatedAt = now(); emit({ type: 'bot.updated', bot: clone(bot) }); result = success({ bot: clone(bot) }); break;
      }
      case 'bot.delete': {
        const index = bots.findIndex(b => b.id === command.botId);
        if (index < 0) { result = failure('Bot not found', 'NOT_FOUND'); break; }
        bots.splice(index, 1);
        for (const removed of snapshot.sessions.filter(s => s.botId === command.botId)) { snapshot.sessions = snapshot.sessions.filter(s => s.id !== removed.id); emit({ type: 'session.deleted', sessionId: removed.id }); }
        snapshot.grants = snapshot.grants.filter(g => g.botId !== command.botId); snapshot.routines = snapshot.routines.filter(r => r.botId !== command.botId);
        emit({ type: 'bot.deleted', botId: command.botId }); result = success(); break;
      }
      case 'grant.create': {
        const grant: StandingGrant = { id: crypto.randomUUID(), ...clone(command.grant), createdAt: now(), createdBy: 'demo-owner' };
        snapshot.grants.push(grant); emit({ type: 'grant.updated', grant: clone(grant) }); result = success({ grant: clone(grant) }); break;
      }
      case 'grant.revoke': {
        const grant = snapshot.grants.find(g => g.id === command.grantId);
        if (!grant) { result = failure('Grant not found', 'NOT_FOUND'); break; }
        snapshot.grants = snapshot.grants.filter(g => g.id !== grant.id);
        emit({ type: 'grant.updated', grant: { ...clone(grant), revokedAt: now(), revokedBy: 'demo-owner' } }); result = success(); break;
      }
      case 'audit.list': {
        const filtered = audit.filter(entry => !command.botId || entry.botId === command.botId);
        const start = command.beforeId ? filtered.findIndex(entry => entry.id === command.beforeId) + 1 : 0;
        result = success({ audit: clone(filtered.slice(start, start + (command.limit ?? 50))) }); break;
      }
      case 'memory.list': result = success({ memory: clone(memory[command.botId] ?? []) }); break;
      case 'memory.add': {
        const entry: MemoryEntry = { id: crypto.randomUUID(), botId: command.botId, content: command.content, source: 'owner', createdAt: now() };
        memory[command.botId] = [entry, ...(memory[command.botId] ?? [])]; emit({ type: 'memory.updated', botId: command.botId, memory: clone(memory[command.botId]) }); result = success({ memory: clone(memory[command.botId]) }); break;
      }
      case 'memory.delete':
        memory[command.botId] = (memory[command.botId] ?? []).filter(entry => entry.id !== command.memoryId); emit({ type: 'memory.updated', botId: command.botId, memory: clone(memory[command.botId]) }); result = success({ memory: clone(memory[command.botId]) }); break;
      case 'routine.create': {
        const routine: Routine = { ...clone(command.routine), id: crypto.randomUUID(), nextRunAt: ahead(60), createdAt: now(), updatedAt: now() };
        snapshot.routines.push(routine); emit({ type: 'routine.updated', routine: clone(routine) }); result = success({ routine: clone(routine) }); break;
      }
      case 'routine.update': {
        const routine = snapshot.routines.find(r => r.id === command.routineId);
        if (!routine) { result = failure('Routine not found', 'NOT_FOUND'); break; }
        Object.assign(routine, clone(command.patch), { updatedAt: now() }); emit({ type: 'routine.updated', routine: clone(routine) }); result = success({ routine: clone(routine) }); break;
      }
      case 'routine.delete':
        snapshot.routines = snapshot.routines.filter(r => r.id !== command.routineId); snapshot.routineRuns = snapshot.routineRuns.filter(r => r.routineId !== command.routineId); emit({ type: 'routine.deleted', routineId: command.routineId }); result = success(); break;
      case 'routine.runNow': {
        const routine = snapshot.routines.find(r => r.id === command.routineId);
        result = routine ? success({ routine: clone(routine), runs: [clone(startRoutine(routine))] }) : failure('Routine not found', 'NOT_FOUND'); break;
      }
      case 'routine.runs': result = success({ runs: clone(snapshot.routineRuns.filter(r => r.routineId === command.routineId).slice(0, command.limit ?? 20)) }); break;
      case 'notification.ack': {
        const notification = snapshot.notifications.find(n => n.id === command.notificationId);
        if (!notification) { result = failure('Notification not found', 'NOT_FOUND'); break; }
        notification.acknowledgedAt ??= now(); emit({ type: 'notification', notification: clone(notification) }); result = success(); break;
      }
      case 'device.pair.start': {
        const suffix = Array.from(crypto.getRandomValues(new Uint8Array(9)), byte => byte.toString(16).padStart(2, '0')).join('');
        result = success({ pairing: { code: `ybp1.SIMULATED-NOT-A-REAL-CODE-${suffix}`, expiresAt: ahead(10), hostFingerprint: 'SIMULATED:DE:MO:00:00', urls: ['wss://demo-host.invalid:0 (simulated)'] } }); break;
      }
      case 'device.list': result = success({ devices: clone(snapshot.devices) }); break;
      case 'device.revoke': {
        const device = snapshot.devices.find(d => d.id === command.deviceId);
        if (!device) { result = failure('Device not found', 'NOT_FOUND'); break; }
        device.revokedAt = now(); emit({ type: 'device.updated', device: clone(device) }); result = success(); break;
      }
      case 'skills.refresh': emit({ type: 'skills.updated', skills: clone(snapshot.skills) }); result = success({ skills: clone(snapshot.skills) }); break;
    }
    results.set(command.id, clone(result)); if (results.size > 500) results.delete(results.keys().next().value!);
    return result;
  };
  // Simulated provider detection: fictional agents, nothing is run or read from this computer.
  const fakeAgents: AgentRowInfo[] = [
    { id: 'claude', name: 'Claude Code', installed: true, version: '2.1.0', latestVersion: '2.2.0', updateAvailable: true, install: { kind: 'npm', label: 'npm (claude)' }, update: { command: 'npm install -g @anthropic-ai/claude-code' }, auth: 'signed-in', providerId: 'agent-claude', linked: false, installHint: 'npm install -g @anthropic-ai/claude-code', docs: 'https://docs.claude.com/claude-code' },
    { id: 'codex', name: 'Codex', installed: true, version: '0.9.0', install: { kind: 'brew', label: 'Homebrew (codex)' }, update: { manual: 'Update with: brew upgrade codex' }, auth: 'signed-out', login: 'codex login', providerId: 'agent-codex', linked: false, installHint: 'npm install -g @openai/codex', docs: 'https://github.com/openai/codex' },
    { id: 'grok', name: 'Grok Build', installed: false, auth: 'unknown', providerId: 'agent-grok', linked: false, installHint: 'curl -fsSL https://x.ai/cli/install.sh | bash', docs: 'https://docs.x.ai' },
  ];
  const providers: ProvidersApi = {
    async scan() {
      const ids = new Set(snapshot.settings.providers.map(provider => provider.id));
      return clone({ agents: fakeAgents.map(agent => ({ ...agent, linked: ids.has(agent.providerId) })), servers: [{ id: 'ollama', name: 'Ollama', endpoint: 'http://127.0.0.1:11434/v1', running: true, models: ['llama3'], providerId: 'local-ollama', linked: ids.has('local-ollama') }] });
    },
    async link(targets) {
      const wanted = targets === 'all' ? ['claude', 'codex', 'ollama'] : targets;
      const linked: { id: string; name: string; providerId: string; created: boolean }[] = [];
      for (const id of wanted) {
        const agent = fakeAgents.find(entry => entry.id === id && entry.installed);
        const providerId = agent?.providerId ?? (id === 'ollama' ? 'local-ollama' : undefined);
        if (!providerId) continue;
        const created = !snapshot.settings.providers.some(provider => provider.id === providerId);
        if (created) snapshot.settings.providers.push(agent ? { id: providerId, name: agent.name, kind: 'acp', launch: 'host', command: agent.id, args: [], enabled: true } : { id: providerId, name: 'Ollama', kind: 'openai-compatible', endpoint: 'http://127.0.0.1:11434/v1', enabled: true });
        linked.push({ id, name: agent?.name ?? 'Ollama', providerId, created });
      }
      if (linked.length) emit({ type: 'state.snapshot', snapshot: { ...clone(snapshot), lastSequence: snapshot.lastSequence + 1 } });
      return { linked, skipped: [] };
    },
    async update(id) { const agent = fakeAgents.find(entry => entry.id === id); if (agent) { agent.updateAvailable = false; agent.version = agent.latestVersion ?? agent.version; } return { ok: !!agent, message: agent ? `${agent.name} updated (simulated).` : 'Unknown agent', output: 'simulated update\nnothing was installed' }; },
    async login(id) { const agent = fakeAgents.find(entry => entry.id === id); if (agent) agent.auth = 'signed-in'; return { ok: true }; },
  };
  return {
    dispatch,
    providers,
    subscribe(listener) { if (closed) throw new Error('Demo transport is closed'); listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Simulated: nothing is read from disk; a fixed fictional path is returned. */
    async chooseDirectory() { return closed ? undefined : '/demo/workspace'; },
    async close() { closed = true; timers.forEach(clearTimeout); timers.clear(); continuations.clear(); listeners.clear(); },
  };
}
