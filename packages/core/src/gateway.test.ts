import { afterEach, describe, expect, it, vi } from 'vitest';
import { link, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentAdapter, AgentRunContext, AppSettings, CommandPayload, CommandResult, DesktopCommand, DesktopEvent, DesktopGateway, PermissionRequest, Principal, ToolExecutionContext, ToolExecutor, ToolInvocation } from '@your-bot/contracts';
import { createGateway, type GatewayOptions } from './index.js';

const local: Principal = { id: 'owner', kind: 'local', capabilities: ['conversation', 'settings', 'tool.execute', 'file.read', 'file.write', 'file.delete', 'library.install', 'network', 'process.spawn'] };
const remote: Principal = { id: 'remote', kind: 'remote', capabilities: [...local.capabilities] };
const python: ToolInvocation = { id: 'call', kind: 'python', input: null, code: 'print("hello")' };
const gateways: DesktopGateway[] = []; const directories: string[] = []; let nextCommand = 0;
function cmd(payload: CommandPayload, id = `cmd-${++nextCommand}`): DesktopCommand { return { ...payload, version: 1, id }; }
function ok(result: CommandResult): asserts result is Extract<CommandResult, {ok: true}> { expect(result.ok).toBe(true); if (!result.ok) throw new Error(JSON.stringify(result.error)); }
function adapter(run: (context: AgentRunContext) => Promise<void> = async context => { context.emit({type: 'text', text: 'Hello'}); }): AgentAdapter {
  return { id: 'fake', getInfo: vi.fn(async () => ({id: 'fake', name: 'Fake', kind: 'local' as const, available: true, models: [{id: 'model', name: 'Model'}]})), run: vi.fn(run), cancel: vi.fn(async () => {}), close: vi.fn(async () => {}) };
}
function executor(run: (invocation: ToolInvocation, context: ToolExecutionContext) => ReturnType<ToolExecutor['execute']> = async () => ({ok: true, value: 'done'})): ToolExecutor {
  return { execute: vi.fn(run), cancel: vi.fn(async () => {}), close: vi.fn(async () => {}) };
}
async function directory(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'your-bot-core-')); directories.push(dir); return dir; }
async function setup(options: Partial<GatewayOptions> = {}) {
  const a = options.adapters?.[0] ?? adapter(); const e = options.executor ?? executor();
  const gateway = await createGateway({ databasePath: ':memory:', localPrincipalId: local.id, adapters: [a], executor: e, ...options }); gateways.push(gateway);
  const events: DesktopEvent[] = []; gateway.subscribe(event => events.push(event), local);
  return {gateway, events, adapter: a, executor: e};
}
async function session(gateway: DesktopGateway, principal = local): Promise<string> {
  const result = await gateway.dispatch(cmd({type: 'session.create', agentId: 'fake', modelId: 'model'}), principal); ok(result); return result.sessionId!;
}
async function permission(events: DesktopEvent[], capability?: PermissionRequest['capability'], excluded: string[] = []): Promise<PermissionRequest> {
  let request: PermissionRequest | undefined;
  await vi.waitFor(() => {
    request = events.filter((event): event is Extract<DesktopEvent, {type: 'permission.requested'}> => event.type === 'permission.requested').map(event => event.request).find(request => (!capability || request.capability === capability) && !excluded.includes(request.id));
    expect(request).toBeDefined();
  }); return request!;
}
async function decide(gateway: DesktopGateway, request: PermissionRequest, outcome: 'allow' | 'deny' = 'allow', scope: 'once' | 'task' = 'once', principal = local) {
  return gateway.dispatch(cmd({type: 'permission.decide', decision: {requestId: request.id, outcome, scope}}), principal);
}
async function terminal(events: DesktopEvent[], taskId: string) {
  await vi.waitFor(() => expect(events.some(event => ['task.completed', 'task.failed', 'task.cancelled'].includes(event.type) && 'taskId' in event && event.taskId === taskId)).toBe(true));
}
afterEach(async () => { await Promise.all(gateways.splice(0).map(gateway => gateway.close())); await Promise.all(directories.splice(0).map(dir => rm(dir, {recursive: true, force: true}))); });

describe('strict dispatcher and persistent ownership', () => {
  it('rejects unknown fields, nested spoofed scopes, non-JSON input, and invalid versions', async () => {
    const {gateway} = await setup();
    for (const value of [
      {version: 2, id: 'bad', type: 'state.sync'},
      {version: 1, id: 'bad-type', type: 'toString'},
      {...cmd({type: 'state.sync'}), principalId: 'remote'},
      {...cmd({type: 'state.sync'}), afterSequence: -1},
      {...cmd({type: 'permission.decide', decision: {requestId: 'x', outcome: 'allow', scope: 'once'}}), decision: {requestId: 'x', outcome: 'allow', scope: 'once', paths: [{path: '/', access: 'write'}]}},
      {...cmd({type: 'tool.run', sessionId: 'x', invocation: python}), invocation: {...python, input: undefined}},
      {...cmd({type: 'settings.update', settings: {providers: []}}), settings: {providers: [{id: 'p', name: 'P', kind: 'acp', enabled: true, args: [undefined]}]}}
    ]) {
      const result = await gateway.dispatch(value as DesktopCommand, local);
      expect(result).toMatchObject({ok: false, error: {code: 'INVALID_INPUT'}});
    }
  });
  it('deduplicates concurrent retries per identity and rejects command ID reuse with changed content', async () => {
    const {gateway, events} = await setup(); const command = cmd({type: 'session.create', agentId: 'fake'}, 'same');
    const results = await Promise.all([gateway.dispatch(command, local), gateway.dispatch(command, local)]);
    expect(results[0]).toEqual(results[1]); expect(events.filter(event => event.type === 'session.updated')).toHaveLength(1);
    const other = await gateway.dispatch(command, remote); ok(other); ok(results[0]); expect(other.sessionId).not.toBe(results[0].sessionId);
    expect(await gateway.dispatch(cmd({type: 'session.create', agentId: 'fake', title: 'different'}, command.id), local)).toMatchObject({ok: false, error: {code: 'COMMAND_CONFLICT'}});
  });
  it('separates sessions, events, settings, tasks, and local identity from remote owners', async () => {
    const a = adapter(async context => { await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), {once: true})); });
    const {gateway} = await setup({adapters: [a]}); const id = await session(gateway);
    const remoteEvents: DesktopEvent[] = []; gateway.subscribe(event => remoteEvents.push(event), remote);
    for (const type of ['session.open', 'session.delete', 'session.selectAgent', 'message.send', 'tool.run'] as const) {
      const actual: CommandPayload = type === 'session.selectAgent' ? {type, sessionId: id, agentId: 'fake'} : type === 'message.send' ? {type, sessionId: id, content: 'Hi'} : type === 'tool.run' ? {type, sessionId: id, invocation: python} : {type, sessionId: id};
      expect((await gateway.dispatch(cmd(actual), remote)).ok).toBe(false);
    }
    const started = await gateway.dispatch(cmd({type: 'message.send', sessionId: id, content: 'Hi'}), local); ok(started);
    expect(await gateway.dispatch(cmd({type: 'task.cancel', taskId: started.taskId!}), remote)).toMatchObject({ok: false, error: {code: 'NOT_FOUND'}});
    const synced = await gateway.dispatch(cmd({type: 'state.sync'}), remote); ok(synced); expect(synced.snapshot?.sessions).toEqual([]); expect(synced.snapshot?.activeTasks).toEqual([]); expect(synced.snapshot?.settings.providers).toEqual([]);
    expect(remoteEvents.every(event => event.principalId === remote.id)).toBe(true);
    expect(await gateway.dispatch(cmd({type: 'settings.update', settings: {providers: []}}), remote)).toMatchObject({ok: false, error: {code: 'FORBIDDEN'}});
    expect(await gateway.dispatch(cmd({type: 'state.sync'}), {...remote, id: local.id})).toMatchObject({ok: false, error: {code: 'IDENTITY_MISMATCH'}});
    expect(await gateway.dispatch(cmd({type: 'state.sync'}), {...local, id: 'pretend-owner'})).toMatchObject({ok: false, error: {code: 'IDENTITY_MISMATCH'}});
  });
  it('streams monotonic owner events, persists messages, replays exact cursors, and isolates subscriber failures', async () => {
    const a = adapter(async context => { context.emit({type: 'status', status: 'thinking'}); context.emit({type: 'text', text: 'Hel'}); context.emit({type: 'text', text: 'lo'}); });
    const {gateway, events} = await setup({adapters: [a]}); gateway.subscribe(() => { throw new Error('subscriber'); }, local);
    const id = await session(gateway); const before = events.at(-1)!.sequence;
    const sent = await gateway.dispatch(cmd({type: 'message.send', sessionId: id, content: 'Hi'}), local); ok(sent); await terminal(events, sent.taskId!);
    expect(events.map(event => event.sequence)).toEqual([...events.map(event => event.sequence)].sort((a, b) => a - b));
    expect(new Set(events.map(event => event.sequence)).size).toBe(events.length);
    const historical = events.filter(event => event.sequence > before); const count = events.length;
    const synced = await gateway.dispatch(cmd({type: 'state.sync', afterSequence: before}), local); ok(synced);
    expect(events.slice(count, -1)).toEqual(historical); expect(synced.snapshot?.lastSequence).toBe(events.at(-1)!.sequence);
    expect(synced.snapshot?.sessions[0].messages.map(message => message.content)).toEqual(['Hi', 'Hello']);
  });
  it('deduplicates sync without generating a new event and validates owner cursor bounds', async () => {
    const {gateway, events} = await setup(); const command = cmd({type: 'state.sync'});
    const first = await gateway.dispatch(command, local); const count = events.length;
    expect(await gateway.dispatch(command, local)).toEqual(first); expect(events.length).toBe(count);
    expect(await gateway.dispatch(cmd({type: 'state.sync', afterSequence: 1_000_000}), local)).toMatchObject({ok: false, error: {code: 'INVALID_CURSOR'}});
  });
});

describe('gateway authorization and executor integration', () => {
  it('capabilities allow requests but never silently allow user file writes', async () => {
    const dir = await directory(); const path = join(dir, 'target.txt'); await writeFile(path, 'original');
    const e = executor(async invocation => { await writeFile(invocation.paths![0].path, 'modified'); return {ok: true}; });
    const {gateway, events} = await setup({executor: e}); const id = await session(gateway);
    const sent = await gateway.dispatch(cmd({type: 'tool.run', sessionId: id, invocation: {...python, paths: [{path, access: 'write'}]}}), local); ok(sent);
    expect(e.execute).not.toHaveBeenCalled(); const execute = await permission(events, 'tool.execute'); ok(await decide(gateway, execute));
    const write = await permission(events, 'file.write'); expect(write.paths).toEqual([{path, access: 'write'}]); expect(e.execute).not.toHaveBeenCalled();
    ok(await decide(gateway, write, 'deny')); await terminal(events, sent.taskId!);
    expect(e.execute).not.toHaveBeenCalled(); expect(await readFile(path, 'utf8')).toBe('original');
  });
  it('binds grants to exact task, owner, request, canonical path and approved decision', async () => {
    const dir = await directory(); const path = join(dir, 'data'); const link = join(dir, 'link'); await writeFile(path, 'original'); await symlink(path, link);
    const e = executor(async (invocation, context) => {
      expect(invocation.paths).toEqual([{path, access: 'write'}]); expect(context.authorization.principal.id).toBe(local.id);
      expect(context.authorization.grants.map(grant => grant.capability)).toEqual(['tool.execute', 'file.write']);
      expect(context.authorization.grants.every(grant => grant.principalId === local.id && grant.taskId === context.authorization.taskId)).toBe(true);
      await writeFile(invocation.paths![0].path, 'approved'); return {ok: true};
    });
    const {gateway, events} = await setup({executor: e}); const id = await session(gateway);
    const sent = await gateway.dispatch(cmd({type: 'tool.run', sessionId: id, invocation: {...python, paths: [{path: link, access: 'write'}]}}), local); ok(sent);
    const request = await permission(events);
    expect(await decide(gateway, request, 'allow', 'once', remote)).toMatchObject({ok: false, error: {code: 'NOT_FOUND'}});
    await expect(gateway.requestPermission({...request, capability: 'file.write', paths: [{path: '/', access: 'write'}]})).rejects.toMatchObject({code: 'INVALID_PERMISSION'});
    await expect(gateway.requestPermission({...request, id: 'invented'})).rejects.toMatchObject({code: 'INVALID_PERMISSION'});
    expect(await gateway.dispatch(cmd({type: 'permission.decide', decision: {requestId: 'invented', outcome: 'allow', scope: 'task'}}), local)).toMatchObject({ok: false, error: {code: 'NOT_FOUND'}});
    ok(await decide(gateway, request)); const write = await permission(events, 'file.write'); ok(await decide(gateway, write)); await terminal(events, sent.taskId!);
    expect(await readFile(path, 'utf8')).toBe('approved'); expect(e.execute).toHaveBeenCalledTimes(1);
    expect(await decide(gateway, write)).toMatchObject({ok: false, error: {code: 'NOT_FOUND'}});
  });
  it('rejects absent file capabilities before asking, relative/directory paths, protected DB paths, and unsafe packages', async () => {
    const dir = await directory(); const db = join(dir, 'private', 'gateway.sqlite');
    const {gateway, events, executor: e} = await setup({databasePath: db}); const id = await session(gateway);
    const limited = {...local, capabilities: ['conversation', 'tool.execute'] as Principal['capabilities']};
    const sent = await gateway.dispatch(cmd({type: 'tool.run', sessionId: id, invocation: {...python, paths: [{path: join(dir, 'new'), access: 'write'}]}}), limited); ok(sent); await terminal(events, sent.taskId!);
    expect(events.filter(event => event.type === 'permission.requested')).toHaveLength(0);
    for (const path of ['relative', dir, db]) {
      const result = await gateway.dispatch(cmd({type: 'tool.run', sessionId: id, invocation: {...python, paths: [{path, access: 'write'}]}}), local); ok(result); await terminal(events, result.taskId!);
    }
    for (const pkg of ['--target=/tmp', 'https://evil/pkg.whl', '../local', 'numpy;touch /tmp/x']) {
      expect(await gateway.dispatch(cmd({type: 'tool.run', sessionId: id, invocation: {id: 'install', kind: 'library.install', input: null, packages: [pkg]}}), local)).toMatchObject({ok: false, error: {code: 'INVALID_INPUT'}});
    }
    expect(e.execute).not.toHaveBeenCalled();
  });
  it('requires independent package approval and routes executor requests back through core', async () => {
    let ctx!: ToolExecutionContext;
    const e = executor(async (_, context) => {
      ctx = context; expect(context.authorization.grants.some(grant => grant.capability === 'network')).toBe(false);
      const decision = await context.requestPermission({capability: 'network', reason: 'Download approved package'});
      expect(decision.outcome).toBe('allow'); expect(context.authorization.grants.some(grant => grant.id === decision.requestId && grant.capability === 'network')).toBe(true);
      context.emit({stream: 'stdout', text: 'installed'}); return {ok: true};
    });
    const {gateway, events} = await setup({executor: e}); const id = await session(gateway);
    const sent = await gateway.dispatch(cmd({type: 'tool.run', sessionId: id, invocation: {id: 'install', kind: 'library.install', input: null, packages: ['numpy==2.2.0']}}), local); ok(sent);
    ok(await decide(gateway, await permission(events, 'tool.execute')));
    const install = await permission(events, 'library.install'); expect(install.packages).toEqual(['numpy==2.2.0']); expect(e.execute).not.toHaveBeenCalled(); ok(await decide(gateway, install));
    const network = await permission(events, 'network'); expect(ctx.authorization.grants.some(grant => grant.capability === 'network')).toBe(false); ok(await decide(gateway, network)); await terminal(events, sent.taskId!);
    expect(events.some(event => event.type === 'tool.output' && event.text === 'installed')).toBe(true);
  });
  it('executor denial never adds a grant and adapters tool updates use the same authorization flow', async () => {
    const e = executor(async (_, context) => {
      const decision = await context.requestPermission({capability: 'network', reason: 'External access'});
      expect(decision.outcome).toBe('deny'); expect(context.authorization.grants.some(grant => grant.capability === 'network')).toBe(false);
      return {ok: false, error: {code: 'PERMISSION_DENIED', message: 'Denied network'}};
    });
    const a = adapter(async context => { context.emit({type: 'tool', invocation: python}); });
    const {gateway, events} = await setup({executor: e, adapters: [a]}); const id = await session(gateway);
    const sent = await gateway.dispatch(cmd({type: 'message.send', sessionId: id, content: 'Run'}), local); ok(sent);
    ok(await decide(gateway, await permission(events, 'tool.execute'))); ok(await decide(gateway, await permission(events, 'network'), 'deny')); await terminal(events, sent.taskId!);
    expect(events.some(event => event.type === 'task.failed' && event.taskId === sent.taskId && event.error.code === 'PERMISSION_DENIED')).toBe(true);
  });
  it('consumes once grants for every invocation but reuses task grants only inside the same task', async () => {
    const a = adapter(async context => { await context.executeTool({...python, id: 'one'}); await context.executeTool({...python, id: 'two'}); });
    const {gateway, events, executor: e} = await setup({adapters: [a]}); const id = await session(gateway);
    const once = await gateway.dispatch(cmd({type: 'message.send', sessionId: id, content: 'Run twice'}), local); ok(once);
    const first = await permission(events, 'tool.execute'); ok(await decide(gateway, first));
    const second = await permission(events, 'tool.execute', [first.id]); ok(await decide(gateway, second)); await terminal(events, once.taskId!); expect(e.execute).toHaveBeenCalledTimes(2);
    const taskScope = await gateway.dispatch(cmd({type: 'message.send', sessionId: id, content: 'Again'}), local); ok(taskScope);
    const third = await permission(events, 'tool.execute', [first.id, second.id]); ok(await decide(gateway, third, 'allow', 'task')); await terminal(events, taskScope.taskId!);
    expect(e.execute).toHaveBeenCalledTimes(4); expect(events.filter(event => event.type === 'permission.requested')).toHaveLength(3);
  });
  it('does not retain once grants after a later permission denies that invocation', async () => {
    const dir = await directory(); const path = join(dir, 'new-file');
    const a = adapter(async context => { await context.executeTool({...python, paths: [{path, access: 'write'}]}); await context.executeTool(python); });
    const {gateway, events, executor: e} = await setup({adapters: [a]}); const id = await session(gateway);
    const sent = await gateway.dispatch(cmd({type: 'message.send', sessionId: id, content: 'Tools'}), local); ok(sent);
    const first = await permission(events, 'tool.execute'); ok(await decide(gateway, first)); ok(await decide(gateway, await permission(events, 'file.write'), 'deny'));
    const second = await permission(events, 'tool.execute', [first.id]); expect(e.execute).not.toHaveBeenCalled(); ok(await decide(gateway, second)); await terminal(events, sent.taskId!); expect(e.execute).toHaveBeenCalledTimes(1);
  });
  it('task-scoped file and package approvals cannot broaden to other paths or packages', async () => {
    const dir = await directory(); const firstPath = join(dir, 'first'); const secondPath = join(dir, 'second');
    const a = adapter(async context => {
      await context.executeTool({...python, id: 'first', paths: [{path: firstPath, access: 'write'}], packages: ['numpy']});
      await context.executeTool({...python, id: 'second', paths: [{path: secondPath, access: 'write'}], packages: ['requests']});
    });
    const {gateway, events, executor: e} = await setup({adapters: [a]}); const id = await session(gateway);
    const sent = await gateway.dispatch(cmd({type: 'message.send', sessionId: id, content: 'Run'}), local); ok(sent);
    ok(await decide(gateway, await permission(events, 'tool.execute'), 'allow', 'task'));
    const firstWrite = await permission(events, 'file.write'); ok(await decide(gateway, firstWrite, 'allow', 'task'));
    const firstInstall = await permission(events, 'library.install'); ok(await decide(gateway, firstInstall, 'allow', 'task'));
    const secondWrite = await permission(events, 'file.write', [firstWrite.id]); expect(secondWrite.paths).toEqual([{path: secondPath, access: 'write'}]); expect(e.execute).toHaveBeenCalledTimes(1); ok(await decide(gateway, secondWrite, 'allow', 'task'));
    const secondInstall = await permission(events, 'library.install', [firstInstall.id]); expect(secondInstall.packages).toEqual(['requests']); ok(await decide(gateway, secondInstall, 'deny')); await terminal(events, sent.taskId!);
    expect(e.execute).toHaveBeenCalledTimes(1);
  });
  it('rejects a new symlink substituted after approval, dangling links, and hard links to its database', async () => {
    const dir = await directory(); const path = join(dir, 'target'); const other = join(dir, 'other'); await writeFile(path, 'original'); await writeFile(other, 'other');
    const dbPath = join(dir, 'private', 'gateway.sqlite'); const {gateway, events, executor: e} = await setup({databasePath: dbPath}); const id = await session(gateway);
    const sent = await gateway.dispatch(cmd({type: 'tool.run', sessionId: id, invocation: {...python, paths: [{path, access: 'write'}]}}), local); ok(sent); ok(await decide(gateway, await permission(events, 'tool.execute')));
    const write = await permission(events, 'file.write'); await unlink(path); await symlink(other, path); ok(await decide(gateway, write)); await terminal(events, sent.taskId!); expect(e.execute).not.toHaveBeenCalled(); expect(await readFile(other, 'utf8')).toBe('other');
    const dangling = join(dir, 'dangling'); await symlink(join(dir, 'missing'), dangling); const hard = join(dir, 'hard.sqlite'); await link(dbPath, hard);
    for (const target of [dangling, hard]) {
      const result = await gateway.dispatch(cmd({type: 'tool.run', sessionId: id, invocation: {...python, paths: [{path: target, access: 'write'}]}}), local); ok(result); await terminal(events, result.taskId!);
    }
    expect(e.execute).not.toHaveBeenCalled();
  });
  it('serializes concurrent adapter tool calls and records validated results as tool messages', async () => {
    const a = adapter(async context => { await Promise.all([context.executeTool({...python, id: 'one'}), context.executeTool({...python, id: 'two'})]); });
    const {gateway, events, executor: e} = await setup({adapters: [a]}); const id = await session(gateway);
    const sent = await gateway.dispatch(cmd({type: 'message.send', sessionId: id, content: 'Concurrent tools'}), local); ok(sent);
    const first = await permission(events); expect(events.filter(event => event.type === 'permission.requested')).toHaveLength(1); ok(await decide(gateway, first));
    const second = await permission(events, 'tool.execute', [first.id]); expect(e.execute).toHaveBeenCalledTimes(1); ok(await decide(gateway, second)); await terminal(events, sent.taskId!);
    const opened = await gateway.dispatch(cmd({type: 'session.open', sessionId: id}), local); ok(opened);
    expect(opened.session?.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content).toolCallId)).toEqual(['one', 'two']);
  });
});

describe('cancellation, settings, restart and cleanup', () => {
  it('cancels adapters, execution and approvals, refuses late grants, and suppresses late events', async () => {
    let context!: AgentRunContext;
    const a = adapter(async ctx => { context = ctx; await ctx.executeTool(python); ctx.emit({type: 'text', text: 'late'}); });
    const {gateway, events, executor: e} = await setup({adapters: [a]}); const id = await session(gateway);
    const sent = await gateway.dispatch(cmd({type: 'message.send', sessionId: id, content: 'Run'}), local); ok(sent); const request = await permission(events);
    expect(await gateway.dispatch(cmd({type: 'session.selectAgent', sessionId: id, agentId: 'fake'}), local)).toMatchObject({ok: false, error: {code: 'SESSION_BUSY'}});
    ok(await gateway.dispatch(cmd({type: 'task.cancel', taskId: sent.taskId!}), local)); await terminal(events, sent.taskId!);
    expect(context.signal.aborted).toBe(true); expect(a.cancel).toHaveBeenCalledWith(sent.taskId); expect(e.cancel).toHaveBeenCalledWith(sent.taskId); expect(e.execute).not.toHaveBeenCalled();
    expect(await decide(gateway, request)).toMatchObject({ok: false, error: {code: 'NOT_FOUND'}});
    expect(events.some(event => event.type === 'permission.resolved' && event.requestId === request.id && event.outcome === 'deny')).toBe(true);
    expect(events.some(event => event.type === 'message.delta' && event.text === 'late')).toBe(false);
    const snapshot = await gateway.dispatch(cmd({type: 'state.sync'}), local); ok(snapshot); expect(snapshot.snapshot?.activeTasks).toEqual([]); expect(snapshot.snapshot?.pendingPermissions).toEqual([]);
  });
  it('aborts a running executor and clears its grants before cleanup', async () => {
    let context!: ToolExecutionContext;
    const e = executor(async (_, ctx) => { context = ctx; await new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => resolve(), {once: true})); ctx.emit({stream: 'stdout', text: 'late'}); return {ok: true}; });
    const {gateway, events} = await setup({executor: e}); const id = await session(gateway);
    const sent = await gateway.dispatch(cmd({type: 'tool.run', sessionId: id, invocation: python}), local); ok(sent); ok(await decide(gateway, await permission(events)));
    await vi.waitFor(() => expect(e.execute).toHaveBeenCalledTimes(1)); ok(await gateway.dispatch(cmd({type: 'task.cancel', taskId: sent.taskId!}), local));
    expect(context.signal.aborted).toBe(true); expect(context.authorization.grants).toEqual([]); expect(events.filter(event => event.type === 'task.completed')).toHaveLength(0); expect(events.filter(event => event.type === 'tool.output')).toHaveLength(0);
  });
  it('reloads settings with credentials, preserves omitted keys, and scrubs credentials even across streaming chunks', async () => {
    const secret = 'sk-local-super-secret'; const reload = vi.fn(async (_settings: AppSettings) => undefined);
    const a = adapter(async context => { context.emit({type: 'text', text: 'Answer sk-local-'}); context.emit({type: 'text', text: 'super-secret done'}); });
    const {gateway, events} = await setup({adapters: [a], onSettingsChanged: reload});
    const settings = {providers: [{id: 'p', name: 'Provider', kind: 'openai-compatible' as const, enabled: true, apiKey: secret}]};
    ok(await gateway.dispatch(cmd({type: 'settings.update', settings}), local)); expect(reload.mock.calls.at(-1)?.[0]).toEqual(settings);
    ok(await gateway.dispatch(cmd({type: 'settings.update', settings: {providers: [{id: 'p', name: 'Renamed', kind: 'openai-compatible', enabled: true}]}}), local));
    expect(reload.mock.calls.at(-1)?.[0].providers[0].apiKey).toBe(secret);
    const id = await session(gateway); const sent = await gateway.dispatch(cmd({type: 'message.send', sessionId: id, content: `Key ${secret}`}), local); ok(sent); await terminal(events, sent.taskId!);
    const result = await gateway.dispatch(cmd({type: 'state.sync', afterSequence: 0}), local); ok(result);
    expect(JSON.stringify(result)).not.toContain(secret); expect(JSON.stringify(events)).not.toContain(secret); expect(JSON.stringify(events)).not.toContain('"apiKey"');
    const text = [...new Map(events.filter((event): event is Extract<DesktopEvent, {type: 'message.delta'}> => event.type === 'message.delta').map(event => [event.sequence, event])).values()].map(event => event.text).join('');
    expect(text).toBe('Answer [REDACTED] done'); expect(result.snapshot?.sessions[0].messages[1].content).toBe('Answer [REDACTED] done');
  });
  it('rolls back failed provider reloads, closes replaced adapters, and refreshes model information', async () => {
    const first = adapter(); const second = {...adapter(), id: 'replacement', getInfo: vi.fn(async () => ({id: 'replacement', name: 'Replacement', kind: 'local' as const, models: [], available: true}))};
    let calls = 0;
    const reload = vi.fn(async () => { calls++; if (calls === 1) return; if (calls === 2) throw new Error('credential must stay private'); return [second]; });
    const {gateway} = await setup({adapters: [first], onSettingsChanged: reload});
    const settings = {providers: [{id: 'p', name: 'P', kind: 'lmstudio' as const, enabled: true}]};
    expect(await gateway.dispatch(cmd({type: 'settings.update', settings}), local)).toMatchObject({ok: false, error: {code: 'INTERNAL_ERROR'}});
    const state = await gateway.dispatch(cmd({type: 'state.sync'}), local); ok(state); expect(state.snapshot?.settings.providers).toEqual([]);
    ok(await gateway.dispatch(cmd({type: 'settings.update', settings}), local)); expect(first.close).toHaveBeenCalledTimes(1);
    ok(await gateway.dispatch(cmd({type: 'models.refresh', agentId: 'replacement'}), local)); expect(second.getInfo).toHaveBeenCalled();
  });
  it('scrubs fragmented executor output, retained credentials after removal, and explicit credential clearing', async () => {
    const secret = 'sk-tool-credential'; const reload = vi.fn(async (_settings: AppSettings) => undefined);
    const e = executor(async (_, context) => { context.emit({stream: 'stdout', text: 'sk-tool-'}); context.emit({stream: 'stdout', text: 'credential'}); return {ok: true, value: {apiKey: secret, content: secret}}; });
    const {gateway, events} = await setup({executor: e, onSettingsChanged: reload});
    ok(await gateway.dispatch(cmd({type: 'settings.update', settings: {providers: [{id: 'p', name: 'P', kind: 'lmstudio', enabled: true, apiKey: secret}]}}), local));
    ok(await gateway.dispatch(cmd({type: 'settings.update', settings: {providers: [{id: 'p', name: 'P', kind: 'lmstudio', enabled: true, apiKey: ''}]}}), local)); expect(reload.mock.calls.at(-1)![0].providers[0].apiKey).toBe('');
    const id = await session(gateway); const sent = await gateway.dispatch(cmd({type: 'tool.run', sessionId: id, invocation: python}), local); ok(sent); ok(await decide(gateway, await permission(events))); await terminal(events, sent.taskId!);
    const output = events.filter((event): event is Extract<DesktopEvent, {type: 'tool.output'}> => event.type === 'tool.output').map(event => event.text).join(''); expect(output).toBe('[REDACTED]');
    expect(JSON.stringify(events)).not.toContain(secret); expect(JSON.stringify(events)).not.toContain('"apiKey"');
  });
  it('handles session deletion during cancellation without admitting a replacement task', async () => {
    let release!: () => void; const e = executor(); e.cancel = vi.fn(async () => new Promise<void>(resolve => { release = resolve; }));
    const a = adapter(async context => { await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), {once: true})); });
    const {gateway} = await setup({executor: e, adapters: [a]}); const id = await session(gateway);
    const sent = await gateway.dispatch(cmd({type: 'message.send', sessionId: id, content: 'Hang'}), local); ok(sent);
    const deleting = gateway.dispatch(cmd({type: 'session.delete', sessionId: id}), local); await vi.waitFor(() => expect(e.cancel).toHaveBeenCalled());
    expect(await gateway.dispatch(cmd({type: 'message.send', sessionId: id, content: 'Race'}), local)).toMatchObject({ok: false, error: {code: 'SESSION_BUSY'}}); release(); ok(await deleting);
    expect(await gateway.dispatch(cmd({type: 'session.open', sessionId: id}), local)).toMatchObject({ok: false, error: {code: 'NOT_FOUND'}});
  });
  it('persists owner sessions/settings/dedup/events with private database permissions across restart', async () => {
    const dir = await directory(); const path = join(dir, 'data', 'gateway.sqlite'); const first = await setup({databasePath: path});
    const command = cmd({type: 'session.create', agentId: 'fake'}); const created = await first.gateway.dispatch(command, local); ok(created);
    const sent = await first.gateway.dispatch(cmd({type: 'message.send', sessionId: created.sessionId!, content: 'Persist me'}), local); ok(sent); await terminal(first.events, sent.taskId!);
    const secret = 'restart-api-key'; ok(await first.gateway.dispatch(cmd({type: 'settings.update', settings: {providers: [{id: 'p', name: 'P', kind: 'lmstudio', enabled: true, apiKey: secret}]}}), local));
    const before = first.events.at(-1)!.sequence; expect((await stat(path)).mode & 0o777).toBe(0o600); expect((await stat(join(dir, 'data'))).mode & 0o777).toBe(0o700); await first.gateway.close();
    const reload = vi.fn(async (_settings: AppSettings) => undefined); const second = await setup({databasePath: path, onSettingsChanged: reload}); expect(reload.mock.calls[0][0].providers[0].apiKey).toBe(secret);
    expect(await second.gateway.dispatch(command, local)).toEqual(created); expect(second.events).toEqual([]);
    const state = await second.gateway.dispatch(cmd({type: 'state.sync', afterSequence: 0}), local); ok(state);
    expect(state.snapshot?.sessions[0].messages.map(message => message.content)).toEqual(['Persist me', 'Hello']); expect(state.snapshot?.lastSequence).toBeGreaterThan(before); expect(state.snapshot?.activeTasks).toEqual([]);
    expect(second.events.slice(0, -1)).toEqual(first.events); expect(JSON.stringify(state)).not.toContain(secret);
    await second.gateway.close();
    await expect(createGateway({databasePath: path, localPrincipalId: 'different', adapters: [adapter()], executor: executor()})).rejects.toMatchObject({code: 'IDENTITY_MISMATCH'});
  });
  it('recovers interrupted tasks without reviving approvals and refuses symlink databases', async () => {
    const dir = await directory(); const path = join(dir, 'data', 'gateway.sqlite'); const first = await setup({databasePath: path}); const id = await session(first.gateway); await first.gateway.close();
    const db = new DatabaseSync(path); db.prepare('INSERT INTO tasks(id,owner,session_id,active) VALUES (?,?,?,1)').run('crashed-task', local.id, id); db.close();
    const second = await setup({databasePath: path}); const state = await second.gateway.dispatch(cmd({type: 'state.sync', afterSequence: 0}), local); ok(state);
    expect(second.events.some(event => event.type === 'task.cancelled' && event.taskId === 'crashed-task')).toBe(true); expect(state.snapshot?.activeTasks).toEqual([]); expect(state.snapshot?.pendingPermissions).toEqual([]); await second.gateway.close();
    const link = join(dir, 'data', 'link.sqlite'); await symlink(path, link);
    await expect(createGateway({databasePath: link, localPrincipalId: local.id, adapters: [adapter()], executor: executor()})).rejects.toThrow();
  });
  it('close is idempotent, settles approvals and rejects dispatch/subscribe after close', async () => {
    const {gateway, events, adapter: a, executor: e} = await setup(); const id = await session(gateway);
    const started = await gateway.dispatch(cmd({type: 'tool.run', sessionId: id, invocation: python}), local); ok(started); const request = await permission(events);
    const waiting = gateway.requestPermission(request); await Promise.all([gateway.close(), gateway.close()]); expect(await waiting).toMatchObject({outcome: 'deny'});
    expect(a.close).toHaveBeenCalledTimes(1); expect(e.close).toHaveBeenCalledTimes(1);
    expect(await gateway.dispatch(cmd({type: 'state.sync'}), local)).toMatchObject({ok: false, error: {code: 'CLOSED'}}); expect(() => gateway.subscribe(() => {}, local)).toThrow('Gateway is closed');
  });
  it('close aborts hung provider reloads and bounds unresponsive cleanup', async () => {
    let reloads = 0; let reloadSignal!: AbortSignal;
    const reload: GatewayOptions['onSettingsChanged'] = async (_, context) => { reloads++; if (reloads === 1) return; reloadSignal = context.signal; await new Promise<void>(() => {}); };
    const a = adapter(); a.close = vi.fn(async () => { await new Promise<void>(() => {}); });
    const {gateway} = await setup({adapters: [a], onSettingsChanged: reload, cleanupTimeoutMs: 20});
    const updating = gateway.dispatch(cmd({type: 'settings.update', settings: {providers: []}}), local);
    await vi.waitFor(() => expect(reloads).toBe(2)); await gateway.close(); expect(reloadSignal.aborted).toBe(true);
    expect(await updating).toMatchObject({ok: false, error: {code: 'CLOSED'}});
  });
});
