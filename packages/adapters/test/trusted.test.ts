import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunContextV2, AgentUpdate, JsonValue, ProviderConfigV2, WorkspaceHostChannel } from '@your-bot/contracts';
import { AcpAdapter, createAdapters, HostLauncher, type ContainmentLauncher } from '../src/index.js';
import { context, waitUntil } from './helpers.js';

const fixture = fileURLToPath(new URL('./fixtures/trusted-agent.mjs', import.meta.url));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function memoryState(initial?: JsonValue) {
  let value = initial;
  return {
    get: async () => value,
    set: async (next: JsonValue) => { value = next; },
    clear: async () => { value = undefined; },
    current: () => value,
  };
}

function mockHost(delayMs = 0) {
  const calls: unknown[] = [];
  const host: WorkspaceHostChannel = {
    async readTextFile(request) {
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      calls.push(['read', request]);
      return { content: 'line1\nline2' };
    },
    async writeTextFile(request) { calls.push(['write', request]); },
    async createTerminal(request) { calls.push(['create', request]); return { terminalId: 'term-1' }; },
    async terminalOutput(terminalId) { calls.push(['output', terminalId]); return { output: 'ok', truncated: false, exitStatus: { exitCode: 0, signal: null } }; },
    async waitForTerminalExit(terminalId) { calls.push(['wait', terminalId]); return { exitCode: 0, signal: null }; },
    async killTerminal(terminalId) { calls.push(['kill', terminalId]); },
    async releaseTerminal(terminalId) { calls.push(['release', terminalId]); },
  };
  return { host, calls };
}

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'your-bot-trusted-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function runContext(dir: string, state = memoryState(), overrides: Partial<AgentRunContextV2> = {}) {
  const updates: AgentUpdate[] = [];
  const ctx: AgentRunContextV2 & { updates: AgentUpdate[] } = {
    taskId: 'task-1',
    session: { id: 'session-1', agentId: 'trusted', title: 'Test', createdAt: '', updatedAt: '', messages: [{ id: 'm1', role: 'user', content: 'Hello', createdAt: '' }] },
    principal: { id: 'owner', kind: 'local', capabilities: ['conversation', 'tool.execute', 'file.read', 'file.write', 'process.spawn'] },
    signal: new AbortController().signal,
    emit: update => updates.push(update),
    executeTool: vi.fn(async () => ({ ok: true, value: 'host-result' })),
    requestPermission: vi.fn(async () => ({ requestId: 'p1', outcome: 'allow' as const, scope: 'once' as const })),
    profile: 'trusted',
    workspace: dir,
    bot: { id: 'bot-1', name: 'Bot', instructions: '', agentId: 'trusted', profile: 'trusted', workspace: dir, mcpServers: [], skills: [], memoryEnabled: false, createdAt: '', updatedAt: '' },
    state,
    ...overrides,
    updates,
  };
  return ctx;
}

function adapterFor(mode: string, trace: string, options: ConstructorParameters<typeof AcpAdapter>[1] = {}) {
  const adapter = new AcpAdapter({
    id: 'trusted', name: 'Trusted', kind: 'acp', enabled: true,
    command: process.execPath, args: [fixture, mode, trace],
  }, { host: new HostLauncher(), timeoutMs: 5000, ...options });
  cleanup.push(() => adapter.close());
  return adapter;
}

function traceOf(file: string): Array<{ method: string; params?: Record<string, unknown> }> {
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line: string) => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
}

function text(run: { updates: AgentUpdate[] }): string {
  return run.updates.map(update => update.type === 'text' ? update.text : '').join('');
}

describe('trusted ACP host launch', () => {
  it('refuses a strict context without spawning', async () => {
    const host = new HostLauncher();
    const launch = vi.spyOn(host, 'launch');
    const adapter = new AcpAdapter({ id: 'trusted', name: 'Trusted', kind: 'acp', enabled: true, command: 'grok', args: ['agent', 'stdio'] }, { host });
    cleanup.push(() => adapter.close());
    expect(adapter.profiles).toEqual(['trusted']);
    await expect(adapter.run(context())).rejects.toMatchObject({ code: 'PROFILE_UNSUPPORTED' });
    const dir = await workspace();
    await expect(adapter.run(runContext(dir, memoryState(), { profile: 'strict' }))).rejects.toMatchObject({ code: 'PROFILE_UNSUPPORTED' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('refuses a trusted context on the contained adapter', async () => {
    const launch = vi.fn<ContainmentLauncher['launch']>();
    const adapter = new AcpAdapter({ id: 'acp', name: 'Harness', kind: 'acp', enabled: true, command: '/readonly/agent' }, { launcher: { launch } });
    cleanup.push(() => adapter.close());
    expect(adapter.profiles).toEqual(['strict']);
    const dir = await workspace();
    await expect(adapter.run(runContext(dir))).rejects.toMatchObject({ code: 'PROFILE_UNSUPPORTED' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('serves fs, terminal and permission through core and never selects allow_always', async () => {
    const dir = await workspace();
    const trace = join(dir, 'trace.ndjson');
    const { host, calls } = mockHost();
    const run = runContext(dir, memoryState(), { host, instructions: 'Be concise.' });
    await adapterFor('exercise', trace).run(run);
    expect(calls.map(call => (call as [string])[0])).toEqual(['read', 'write', 'create', 'output', 'wait', 'kill', 'release']);
    expect(calls[0]).toEqual(['read', { path: '/w/a.txt', line: 2, limit: 3 }]);
    expect(calls[1]).toEqual(['write', { path: '/w/b.txt', content: 'hello' }]);
    expect(calls[2]).toEqual(['create', { command: 'node', args: ['-e', '1'], env: [{ name: 'A', value: 'B' }], cwd: '/w', outputByteLimit: 100 }]);
    expect(text(run)).toContain('"content":"line1\\nline2"');
    expect(text(run)).toContain('write:null');
    expect(text(run)).toContain('"terminalId":"term-1"');
    expect(text(run)).toContain('"optionId":"once"');
    expect(text(run)).not.toContain('"optionId":"always"');
    expect(run.requestPermission).toHaveBeenCalledExactlyOnceWith({
      capability: 'tool.execute', reason: 'Edit file', botId: 'bot-1',
      agentTool: { toolCallId: 'tool-9', title: 'Edit file', kind: 'edit' },
    });
    const init = traceOf(trace).find(entry => entry.method === 'initialize');
    expect(init?.params?.clientCapabilities).toMatchObject({ fs: { readTextFile: true, writeTextFile: true }, terminal: true });
    expect(run.executeTool).not.toHaveBeenCalled();
  });

  it('rejects permission with reject_once', async () => {
    const dir = await workspace();
    const run = runContext(dir, memoryState(), {
      host: mockHost().host,
      requestPermission: vi.fn(async () => ({ requestId: 'p1', outcome: 'deny' as const, scope: 'once' as const })),
    });
    await adapterFor('exercise', join(dir, 'trace.ndjson')).run(run);
    expect(text(run)).toContain('"optionId":"reject"');
    expect(text(run)).not.toContain('"optionId":"always"');
  });

  it('maps host rejections to JSON-RPC data.code and does not leak the message', async () => {
    const dir = await workspace();
    const host = mockHost().host;
    host.readTextFile = async () => { throw Object.assign(new Error('SECRET_PATH /etc/shadow'), { code: 'PERMISSION_DENIED' }); };
    const run = runContext(dir, memoryState(), { host });
    await adapterFor('host-error', join(dir, 'trace.ndjson')).run(run);
    expect(text(run)).toContain('"code":"PERMISSION_DENIED"');
    expect(text(run)).not.toContain('SECRET_PATH');
  });

  it('rejects a mismatched session id before calling the host', async () => {
    const dir = await workspace();
    const { host, calls } = mockHost();
    const run = runContext(dir, memoryState(), { host });
    await adapterFor('bad-session', join(dir, 'trace.ndjson')).run(run);
    expect(calls).toEqual([]);
    expect(text(run)).toContain('"code":-32602');
  });

  it('omits filesystem capabilities when no host channel is present', async () => {
    const dir = await workspace();
    const trace = join(dir, 'trace.ndjson');
    const run = runContext(dir);
    await adapterFor('exercise', trace).run(run);
    const init = traceOf(trace).find(entry => entry.method === 'initialize');
    expect(init?.params?.clientCapabilities).toMatchObject({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    expect(text(run)).toContain('"code":-32601');
  });

  it('routes the extension tool through executeTool', async () => {
    const dir = await workspace();
    const run = runContext(dir, memoryState(), { host: mockHost().host });
    await adapterFor('tool', join(dir, 'trace.ndjson')).run(run);
    expect(run.executeTool).toHaveBeenCalledExactlyOnceWith({ id: 'tool-1', kind: 'skill', skillId: 'example', input: { hello: true } });
    expect(text(run)).toContain('"value":"host-result"');
  });

  it('continues a matching session, ignores replay, and prompts only the newest user message', async () => {
    const dir = await workspace();
    const trace = join(dir, 'trace.ndjson');
    const state = memoryState();
    const first = runContext(dir, state, { instructions: 'Be concise.' });
    const adapter = adapterFor('echo', trace);
    await adapter.run(first);
    expect(text(first)).toBe('Standing instructions:\nBe concise.\n\nHello');
    expect(state.current()).toEqual({ acpSessionId: 'trusted-session', cwd: dir, instructionsHash: hash('Be concise.') });
    const second = runContext(dir, state, {
      taskId: 'task-2', instructions: 'Be concise.',
      session: {
        id: 'session-1', agentId: 'trusted', title: 'Test', createdAt: '', updatedAt: '',
        messages: [
          { id: 'm1', role: 'user', content: 'Hello', createdAt: '' },
          { id: 'm2', role: 'assistant', content: 'Earlier', createdAt: '' },
          { id: 'm3', role: 'user', content: 'Newest only', createdAt: '' },
        ],
      },
    });
    await adapter.run(second);
    expect(text(second)).toBe('Newest only');
    expect(text(second)).not.toContain('REPLAY_SHOULD_NOT_LEAK');
    const methods = traceOf(trace).map(entry => entry.method);
    expect(methods).toContain('session/load');
    expect(methods.filter(method => method === 'session/new')).toHaveLength(1);
  });

  it('delivers instructions again only when their hash changes', async () => {
    const dir = await workspace();
    const state = memoryState();
    const adapter = adapterFor('echo', join(dir, 'trace.ndjson'));
    await adapter.run(runContext(dir, state, { instructions: 'Be concise.' }));
    const changed = runContext(dir, state, { taskId: 'task-2', instructions: 'Be thorough.' });
    await adapter.run(changed);
    expect(text(changed)).toBe('Standing instructions:\nBe thorough.\n\nHello');
    expect(state.current()).toMatchObject({ instructionsHash: hash('Be thorough.') });
  });

  it('uses systemPrompt when advertised and keeps it out of the user prompt', async () => {
    const dir = await workspace();
    const trace = join(dir, 'trace.ndjson');
    const state = memoryState();
    const run = runContext(dir, state, { instructions: 'Be concise.' });
    await adapterFor('system', trace).run(run);
    expect(text(run)).toBe('Hello');
    const created = traceOf(trace).find(entry => entry.method === 'session/new');
    expect(created?.params?.systemPrompt).toEqual({ mode: 'append', content: [{ type: 'text', text: 'Be concise.' }] });
    const changed = runContext(dir, state, { taskId: 'task-2', instructions: 'Be thorough.' });
    await adapterFor('system', join(dir, 'trace-2.ndjson')).run(changed);
    expect(text(changed)).toBe('Hello');
    const loaded = traceOf(join(dir, 'trace-2.ndjson')).find(entry => entry.method === 'session/load');
    expect(loaded?.params?.systemPrompt).toEqual({ mode: 'append', content: [{ type: 'text', text: 'Be thorough.' }] });
  });

  it('falls back to a new session and includes the summary when load fails', async () => {
    const dir = await workspace();
    const trace = join(dir, 'trace.ndjson');
    const state = memoryState({ acpSessionId: 'old-session', cwd: dir, instructionsHash: hash('Be concise.') });
    const run = runContext(dir, state, {
      instructions: 'Be concise.',
      session: {
        id: 'session-1', agentId: 'trusted', title: 'Test', createdAt: '', updatedAt: '', summary: 'Compacted discussion',
        messages: [
          { id: 'm1', role: 'user', content: 'Hello', createdAt: '' },
          { id: 'm2', role: 'assistant', content: 'Earlier', createdAt: '' },
          { id: 'm3', role: 'user', content: 'Follow-up', createdAt: '' },
        ],
      },
    });
    await adapterFor('load-fail', trace).run(run);
    const methods = traceOf(trace).map(entry => entry.method);
    expect(methods).toContain('session/load');
    expect(methods).toContain('session/new');
    expect(text(run)).toContain('Compacted discussion');
    expect(text(run)).toContain('user: Follow-up');
    expect(text(run)).toContain('Standing instructions:\nBe concise.');
    expect(state.current()).toMatchObject({ acpSessionId: 'trusted-session', cwd: dir });
  });

  it('does not load when the agent lacks loadSession or the workspace changed', async () => {
    const dir = await workspace();
    const other = await workspace();
    const trace = join(dir, 'trace.ndjson');
    const state = memoryState({ acpSessionId: 'old-session', cwd: other, instructionsHash: hash('') });
    await adapterFor('echo', trace).run(runContext(dir, state));
    expect(traceOf(trace).map(entry => entry.method)).not.toContain('session/load');
    const noload = join(dir, 'noload.ndjson');
    const kept = memoryState({ acpSessionId: 'old-session', cwd: dir, instructionsHash: hash('') });
    await adapterFor('no-load', noload).run(runContext(dir, kept, { taskId: 'task-2' }));
    expect(traceOf(noload).map(entry => entry.method)).not.toContain('session/load');
  });

  it('passes HTTP MCP servers and omits them with a status when unsupported', async () => {
    const dir = await workspace();
    const trace = join(dir, 'http.ndjson');
    const mcp = { name: 'bot-mcp', url: 'http://127.0.0.1:9/mcp', headers: [{ name: 'Authorization', value: 'Bearer secret' }] };
    const run = runContext(dir, memoryState(), { mcp });
    await adapterFor('echo', trace).run(run);
    const created = traceOf(trace).find(entry => entry.method === 'session/new');
    expect(created?.params?.mcpServers).toEqual([{ type: 'http', name: 'bot-mcp', url: mcp.url, headers: mcp.headers }]);
    expect(created?.params?.cwd).toBe(dir);
    expect(run.updates.some(update => update.type === 'status' && update.status.includes('omitting MCP'))).toBe(false);
    const omitted = join(dir, 'nohttp.ndjson');
    const denied = runContext(dir, memoryState(), { taskId: 'task-2', mcp });
    await adapterFor('no-http', omitted).run(denied);
    expect(traceOf(omitted).find(entry => entry.method === 'session/new')?.params?.mcpServers).toEqual([]);
    expect(denied.updates).toContainEqual({ type: 'status', status: 'Agent does not advertise HTTP MCP; omitting MCP servers.' });
  });

  it('selects an advertised model on the trusted path', async () => {
    const dir = await workspace();
    const trace = join(dir, 'trace.ndjson');
    const adapter = adapterFor('echo', trace);
    const run = runContext(dir);
    run.session.modelId = 'b';
    await adapter.run(run);
    expect(traceOf(trace)).toContainEqual(expect.objectContaining({ method: 'session/set_config_option', params: { sessionId: 'trusted-session', configId: 'model', value: 'b' } }));
    expect((await adapter.getInfo()).models).toEqual([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  });

  it('excludes approval and host waits from the run timeout', async () => {
    const dir = await workspace();
    const slowPermission = runContext(dir, memoryState(), {
      host: mockHost().host,
      requestPermission: () => new Promise(resolve => setTimeout(() => resolve({ requestId: 'p1', outcome: 'allow', scope: 'once' }), 900)),
    });
    await adapterFor('slow-permission', join(dir, 'perm.ndjson'), { timeoutMs: 350 }).run(slowPermission);
    expect(text(slowPermission)).toContain('"optionId":"once"');
    const slowHost = runContext(dir, memoryState(), { taskId: 'task-2', host: mockHost(900).host });
    await adapterFor('exercise', join(dir, 'host.ndjson'), { timeoutMs: 350 }).run(slowHost);
    expect(text(slowHost)).toContain('"terminalId":"term-1"');
  }, 15_000);

  it('still times out when the agent is idle and cancels a pending approval', async () => {
    const dir = await workspace();
    const trace = join(dir, 'hang.ndjson');
    await expect(adapterFor('hang-init', trace, { timeoutMs: 250 }).run(runContext(dir))).rejects.toMatchObject({ code: 'TIMEOUT' });
    const pid = traceOf(trace).find(entry => entry.method === 'startup')?.params?.pid;
    expect(typeof pid).toBe('number');
    await waitUntil(() => { try { process.kill(pid as number, 0); return false; } catch { return true; } });
    let asked = false;
    const pending = runContext(dir, memoryState(), {
      taskId: 'task-2', host: mockHost().host,
      requestPermission: () => { asked = true; return new Promise(() => {}); },
    });
    const adapter = adapterFor('slow-permission', join(dir, 'cancel.ndjson'));
    const result = adapter.run(pending).catch(error => error);
    await waitUntil(() => asked);
    await adapter.cancel(pending.taskId);
    expect(await result).toMatchObject({ code: 'CANCELLED' });
  });

  it('builds a host-launched adapter from ProviderConfigV2.launch and keeps a minimal environment', async () => {
    const dir = await workspace();
    const trace = join(dir, 'trace.ndjson');
    const containment: ContainmentLauncher = { launch: vi.fn(async () => { throw new Error('contained'); }) };
    const config: ProviderConfigV2 = {
      id: 'trusted', name: 'Trusted', kind: 'acp', enabled: true, launch: 'host',
      command: process.execPath, args: [fixture, 'env', trace], envPassthrough: ['YOUR_BOT_PASS'],
    };
    const adapters = createAdapters([config], { acp: { containment, timeoutMs: 5000 } });
    cleanup.push(async () => { await Promise.all(adapters.map(adapter => adapter.close())); });
    const adapter = adapters[0] as AcpAdapter;
    expect(adapter.profiles).toEqual(['trusted']);
    const previousPass = process.env.YOUR_BOT_PASS;
    const previousSecret = process.env.YOUR_BOT_SECRET_SHOULD_NOT_LEAK;
    process.env.YOUR_BOT_PASS = 'visible-pass';
    process.env.YOUR_BOT_SECRET_SHOULD_NOT_LEAK = 'supersecret';
    try {
      const run = runContext(dir);
      await adapter.run(run);
      expect(containment.launch).not.toHaveBeenCalled();
      const body = text(run);
      expect(body).toContain('pass:visible-pass');
      expect(body).toContain('secret:');
      expect(body).not.toContain('supersecret');
      expect(body).not.toContain('YOUR_BOT_SECRET_SHOULD_NOT_LEAK');
      expect(body).toContain('YOUR_BOT_PASS');
    } finally {
      if (previousPass === undefined) delete process.env.YOUR_BOT_PASS; else process.env.YOUR_BOT_PASS = previousPass;
      if (previousSecret === undefined) delete process.env.YOUR_BOT_SECRET_SHOULD_NOT_LEAK; else process.env.YOUR_BOT_SECRET_SHOULD_NOT_LEAK = previousSecret;
    }
  });
});
