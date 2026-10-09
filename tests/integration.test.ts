import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { CommandPayload, DesktopEvent, DesktopGateway, ToolInvocation } from '@your-bot/contracts';
import { createGateway } from '@your-bot/core';
import { createAdapters, BubblewrapContainmentLauncher } from '@your-bot/adapters';
import { createToolExecutor } from '@your-bot/executor';
import { DesktopStore } from '../apps/desktop/src/renderer/store.js';
import { inProcessTransport, localPrincipal } from './helpers.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function waitFor<T>(read: () => T | undefined, timeout = 15000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Integration condition timed out');
}
async function modelServer(): Promise<string> {
  const server: Server = createServer(async (request, response) => {
    if (request.url === '/v1/models') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'integration-model' }] })); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const messages: {role: string; content: string}[] = payload.messages;
    response.setHeader('Content-Type', 'text/event-stream');
    const frame = (delta: unknown, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (messages.at(-1)?.content === 'calculate' && messages.at(-1)?.role === 'user') {
      const args = JSON.stringify({ kind: 'skill', skillId: 'calculation', input: { operation: 'sum', values: [20, 22] } });
      frame({ tool_calls: [{ index: 0, id: 'model-calculation', type: 'function', function: { name: 'execute_tool', arguments: args } }] });
      frame({}, 'tool_calls');
    } else { frame({ content: 'The answer is ' }); frame({ content: '42.' }); frame({}, 'stop'); }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  return `http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
}
async function fixture(autoApprove = true, includeAcp = false) {
  const root = await mkdtemp(join(tmpdir(), 'your-bot-integration-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const endpoint = await modelServer();
  const executor = createToolExecutor({ environmentRoot: join(root, 'python') });
  const probe = await executor.probe();
  expect(probe.supported, JSON.stringify(probe.error)).toBe(true);
  const config = { id: 'local', name: 'Integration local', kind: 'lmstudio' as const, endpoint, enabled: true };
  const scriptPath = fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url));
  const acpConfig = { id: 'acp', name: 'Contained ACP', kind: 'acp' as const, command: '/usr/bin/node', args: [scriptPath], enabled: true };
  const adapterOptions = { acp: { containment: new BubblewrapContainmentLauncher({ scriptPath }) } };
  const make = () => createGateway({ databasePath: join(root, 'state', 'gateway.sqlite'), localPrincipalId: localPrincipal.id, executor,
    onSettingsChanged: settings => createAdapters(settings.providers.length ? settings.providers : includeAcp ? [config, acpConfig] : [config], adapterOptions), });
  let gateway = await make();
  cleanup.push(() => gateway.close());
  const events: DesktopEvent[] = [];
  const observe = () => gateway.subscribe(event => {
    events.push(event);
    if (autoApprove && event.type === 'permission.requested') void dispatch({ type: 'permission.decide', decision: { requestId: event.request.id, outcome: 'allow', scope: 'once' } });
  }, localPrincipal);
  const dispatch = (payload: CommandPayload) => inProcessTransport(gateway, localPrincipal).dispatch({ ...payload, version: 1, id: randomUUID() });
  observe();
  const created = await dispatch({ type: 'session.create', agentId: 'local', modelId: 'integration-model' });
  if (!created.ok || !created.sessionId) throw new Error(JSON.stringify(created));
  const sessionId = created.sessionId;
  const terminal = (taskId: string) => waitFor(() => events.find(event => 'taskId' in event && event.taskId === taskId && ['task.completed', 'task.failed', 'task.cancelled'].includes(event.type)));
  const tool = async (invocation: ToolInvocation) => {
    const result = await dispatch({ type: 'tool.run', sessionId, invocation });
    if (!result.ok || !result.taskId) throw new Error(JSON.stringify(result));
    return terminal(result.taskId);
  };
  return { root, executor, dispatch, events, sessionId, tool, terminal, transport: {
    dispatch: (command: Parameters<DesktopGateway['dispatch']>[0]) => gateway.dispatch(command, localPrincipal),
    subscribe: (listener: (event: DesktopEvent) => void) => gateway.subscribe(listener, localPrincipal),
  }, restart: async () => {
    await gateway.close();
    // Gateway close owns executor shutdown; a restarted host gets a new executor.
    const replacement = createToolExecutor({ environmentRoot: join(root, 'python') });
    gateway = await createGateway({ databasePath: join(root, 'state', 'gateway.sqlite'), localPrincipalId: localPrincipal.id, executor: replacement, onSettingsChanged: settings => createAdapters(settings.providers.length ? settings.providers : [config]) });
    observe();
  } };
}

describe('integrated headless command transport, local model, SQLite and real Python sandbox', () => {
  it('runs a real contained ACP harness through the same gateway and approved Python executor', async () => {
    const f = await fixture(true, true);
    const store = new DesktopStore(f.transport);
    const unsubscribe = store.start(); cleanup.push(async () => unsubscribe());
    // ACP model selection is optional; undefined must not cross the JSON wire.
    const created = await store.command({ type: 'session.create', agentId: 'acp', modelId: undefined });
    if (!created?.ok || !created.sessionId) throw new Error(JSON.stringify(created));
    const accepted = await store.command({ type: 'message.send', sessionId: created.sessionId, content: 'calculate' });
    if (!accepted?.ok || !accepted.taskId) throw new Error(JSON.stringify(accepted));
    const finished = await f.terminal(accepted.taskId);
    expect(finished.type, JSON.stringify(finished)).toBe('task.completed');
    const reopened = await f.dispatch({ type: 'session.open', sessionId: created.sessionId });
    if (!reopened.ok) throw new Error(JSON.stringify(reopened));
    expect(reopened.session?.messages.at(-1)?.content).toBe('ACP Python result: 42');
    expect(f.events.some(e => e.type === 'permission.requested' && e.request.taskId === accepted.taskId)).toBe(true);
  });
  it('streams local responses, executes an approved model tool, and reopens persisted history after restart', async () => {
    const f = await fixture();
    const accepted = await f.dispatch({ type: 'message.send', sessionId: f.sessionId, content: 'calculate' });
    expect(accepted.ok).toBe(true); if (!accepted.ok || !accepted.taskId) return;
    expect((await f.terminal(accepted.taskId)).type).toBe('task.completed');
    expect(f.events.some(e => e.type === 'message.delta' && e.text.includes('answer'))).toBe(true);
    expect(f.events.some(e => e.type === 'permission.requested' && e.request.capability === 'tool.execute')).toBe(true);
    await f.restart();
    const reopened = await f.dispatch({ type: 'session.open', sessionId: f.sessionId });
    expect(reopened.ok).toBe(true); if (!reopened.ok) return;
    expect(reopened.session?.messages.at(-1)?.content).toBe('The answer is 42.');
    expect(reopened.session?.messages.some(m => m.role === 'tool' && JSON.parse(m.content).result.value === 42)).toBe(true);
  });
  it('blocks undeclared host writes at the actual OS boundary and allows only an approved exact file binding', async () => {
    const f = await fixture(); const sentinel = join(f.root, 'sentinel.txt'); await writeFile(sentinel, 'original');
    const blocked = await f.tool({ id: 'denied-write', kind: 'python', input: null, code: `open(${JSON.stringify(sentinel)}, 'w').write('bad')` });
    expect(blocked.type).toBe('task.failed'); expect(await readFile(sentinel, 'utf8')).toBe('original');
    const allowed = await f.tool({ id: 'scoped-write', kind: 'skill', skillId: 'file.write', input: { path: sentinel, text: 'approved' }, paths: [{ path: sentinel, access: 'write' }] });
    expect(allowed.type).toBe('task.completed'); expect(await readFile(sentinel, 'utf8')).toBe('approved');
    const requested = f.events.filter(e => e.type === 'permission.requested').map(e => e.request);
    expect(requested.some(p => p.capability === 'file.write' && p.paths?.[0].path === sentinel)).toBe(true);
    expect(requested.some(p => p.capability === 'file.read' && p.paths?.[0].path === sentinel)).toBe(true);
    const created = join(f.root, 'new-output.txt');
    const multiFile = await f.tool({ id: 'multiple-exact-files', kind: 'python', input: { created, sentinel }, paths: [{ path: created, access: 'write' }, { path: sentinel, access: 'write' }],
      code: "for name in ['created','sentinel']:\n with open(files[input[name]], 'w') as target:\n  target.write('scoped output')\nresult = True" });
    expect(multiFile.type).toBe('task.completed');
    expect(await readFile(created, 'utf8')).toBe('scoped output');
    expect(await readFile(sentinel, 'utf8')).toBe('scoped output');
  });
  it('keeps a denied permission from reaching Python and clears pending requests when cancelled', async () => {
    const f = await fixture(false);
    const accepted = await f.dispatch({ type: 'tool.run', sessionId: f.sessionId, invocation: { id: 'pending', kind: 'skill', skillId: 'calculation', input: { operation: 'sum', values: [1, 2] } } });
    if (!accepted.ok || !accepted.taskId) throw new Error(JSON.stringify(accepted));
    const permission = await waitFor(() => f.events.find(e => e.type === 'permission.requested'));
    expect(permission.type).toBe('permission.requested');
    const cancelled = await f.dispatch({ type: 'task.cancel', taskId: accepted.taskId }); expect(cancelled.ok).toBe(true);
    expect((await f.terminal(accepted.taskId)).type).toBe('task.cancelled');
    const state = await f.dispatch({ type: 'state.sync' }); if (!state.ok) throw new Error(JSON.stringify(state));
    expect(state.snapshot?.pendingPermissions).toEqual([]);
    expect(f.events.some(e => e.type === 'tool.output')).toBe(false);
  });
  it('cancels a running real worker and rejects process execution inside approved Python', async () => {
    const f = await fixture();
    expect((await f.tool({ id: 'spawn-denied', kind: 'python', input: null, code: "import subprocess\nsubprocess.run(['/usr/bin/true'], check=True)" })).type).toBe('task.failed');
    const accepted = await f.dispatch({ type: 'tool.run', sessionId: f.sessionId, invocation: { id: 'loop', kind: 'python', input: null, code: "import time\nprint('worker ready', flush=True)\nwhile True:\n time.sleep(0.1)", timeoutMs: 10000 } });
    if (!accepted.ok || !accepted.taskId) throw new Error(JSON.stringify(accepted));
    await waitFor(() => f.events.find(e => e.type === 'tool.output' && e.text.includes('worker ready')));
    expect((await f.dispatch({ type: 'task.cancel', taskId: accepted.taskId })).ok).toBe(true);
    expect((await f.terminal(accepted.taskId)).type).toBe('task.cancelled');
    expect((await f.tool({ id: 'after-cancel', kind: 'skill', skillId: 'calculation', input: { operation: 'sum', values: [1, 2] } })).type).toBe('task.completed');
  });
});
