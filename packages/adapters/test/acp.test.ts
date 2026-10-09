import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunContext } from '@your-bot/contracts';
import { AcpAdapter, createAdapters, type ContainmentLauncher, type ContainedHarness } from '../src/index.js';
import { context, waitUntil } from './helpers.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const config = { id: 'acp', name: 'Harness', kind: 'acp' as const, enabled: true, command: '/readonly/agent', args: ['--acp'] };

/** Deliberately UNSANDBOXED test-only mock launcher. These are protocol tests, not sandbox proofs. */
function mockLauncher(mode: string, preparePermission?: ContainedHarness['preparePermission']) {
  const children: ChildProcessWithoutNullStreams[] = [];
  const writes: Array<unknown[][]> = [];
  let terminations = 0;
  const launch = vi.fn<ContainmentLauncher['launch']>(async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'your-bot-acp-test-'));
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/harness.mjs', import.meta.url)), mode], {
      env: {}, cwd: scratch, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    children.push(child);
    const spy = vi.spyOn(child.stdin, 'write');
    writes.push(spy.mock.calls);
    await once(child, 'spawn');
    let terminated = false;
    return {
      process: child, cwd: '/scratch', preparePermission,
      async terminate() {
        if (terminated) return;
        terminated = true;
        terminations++;
        // Let cancellation notifications and permission responses reach the protocol fixture.
        await new Promise(resolve => setTimeout(resolve, 25));
        if (child.exitCode === null && child.signalCode === null) {
          const exit = once(child, 'exit');
          child.kill('SIGTERM');
          await exit;
        }
        await rm(scratch, { recursive: true, force: true });
      },
    };
  });
  return { launcher: { launch }, launch, children, writes, get terminations() { return terminations; } };
}

function setup(mode: string, options: ConstructorParameters<typeof AcpAdapter>[1] = {}, preparePermission?: ContainedHarness['preparePermission']) {
  const mock = mockLauncher(mode, preparePermission);
  const adapter = new AcpAdapter(config, { ...options, launcher: mock.launcher });
  cleanup.push(() => adapter.close());
  return { adapter, mock };
}

function outbound(mock: ReturnType<typeof mockLauncher>): Record<string, unknown>[] {
  return mock.writes.flat().map(call => JSON.parse(String(call[0])) as Record<string, unknown>);
}

function text(run: ReturnType<typeof context>): string {
  return run.updates.map(update => update.type === 'text' ? update.text : '').join('');
}

describe('ACP v1 stdio adapters', () => {
  it('fails closed without a trusted launcher and exposes no direct spawn path', async () => {
    const adapter = new AcpAdapter(config);
    cleanup.push(() => adapter.close());
    expect(await adapter.getInfo()).toMatchObject({ available: false, limitation: 'ACP requires an enforced OS containment launcher.' });
    await expect(adapter.run(context())).rejects.toMatchObject({ code: 'CONTAINMENT_UNAVAILABLE' });
  });

  it('initializes v1, creates a private session and streams fragmented UTF-8', async () => {
    const { adapter, mock } = setup('stream');
    const run = context();
    await adapter.run(run);
    expect(text(run)).toBe('Hello 🌍');
    expect(run.updates).toContainEqual({ type: 'status', status: 'Harness tool completed' });
    expect(mock.launch).toHaveBeenCalledExactlyOnceWith({ command: '/readonly/agent', args: ['--acp'], signal: expect.any(AbortSignal) });
    const wire = outbound(mock);
    expect(wire[0]).toMatchObject({ method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } });
    expect(wire[1]).toMatchObject({ method: 'session/new', params: { cwd: '/scratch', mcpServers: [] } });
    expect(wire[2]).toMatchObject({ method: 'session/prompt', params: { sessionId: 'acp-session', prompt: [{ type: 'text', text: 'Hello' }] } });
    expect(mock.terminations).toBe(1);
    expect(mock.children[0].signalCode).toBe('SIGTERM');
    expect(text(run)).not.toContain('SENSITIVE');
  });

  it('uses a fresh process and transcript for every run', async () => {
    const { adapter, mock } = setup('stream');
    await adapter.run(context());
    const next = context({ taskId: 'task-2' });
    next.session.messages.push({ id: 'm2', role: 'assistant', content: 'Earlier answer', createdAt: '' }, { id: 'm3', role: 'user', content: 'Follow-up', createdAt: '' });
    await adapter.run(next);
    expect(mock.children).toHaveLength(2);
    expect(mock.terminations).toBe(2);
    expect(String((outbound(mock).filter(message => message.method === 'session/prompt')[1].params as { prompt: { text: string }[] }).prompt[0].text)).toContain('assistant: Earlier answer');
  });

  it('selects advertised models and refuses unknown model choices', async () => {
    const { adapter, mock } = setup('stream');
    const run = context();
    run.session.modelId = 'b';
    await adapter.run(run);
    expect(outbound(mock)).toContainEqual(expect.objectContaining({ method: 'session/set_config_option', params: { sessionId: 'acp-session', configId: 'model', value: 'b' } }));
    expect((await adapter.getInfo()).models).toEqual([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
    const unknown = context({ taskId: 'unknown' });
    unknown.session.modelId = 'missing';
    await expect(adapter.run(unknown)).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
    expect(mock.terminations).toBe(2);
  });

  it('selects models from grouped ACP config options', async () => {
    const { adapter, mock } = setup('model-grouped');
    const run = context();
    run.session.modelId = 'b';
    await adapter.run(run);
    expect(outbound(mock)).toContainEqual(expect.objectContaining({ method: 'session/set_config_option', params: { sessionId: 'acp-session', configId: 'model', value: 'b' } }));
  });

  it('refuses filesystem and terminal RPC even when the harness ignores capabilities', async () => {
    const { adapter } = setup('rpc-deny');
    const run = context();
    await adapter.run(run);
    expect(text(run)).toContain('fs:{"code":-32601,"message":"Method not supported"}');
    expect(text(run)).toContain('terminal:{"code":-32601,"message":"Method not supported"}');
    expect(run.executeTool).not.toHaveBeenCalled();
  });

  it('denies native permissions with no enforceable OS plan', async () => {
    const { adapter } = setup('permission');
    const run = context();
    await adapter.run(run);
    expect(text(run)).toContain('"optionId":"reject"');
    expect(run.requestPermission).not.toHaveBeenCalled();
  });

  it('routes native permission through core and selects only allow_once after enforcement', async () => {
    const allowOnce = vi.fn(async () => true);
    const prepare = vi.fn<NonNullable<ContainedHarness['preparePermission']>>(async () => ({
      request: { capability: 'file.read', reason: 'Read exactly approved sandbox file', paths: [{ path: '/allowed/data', access: 'read' }] },
      allowOnce,
    }));
    const { adapter } = setup('permission', {}, prepare);
    const run = context({ requestPermission: vi.fn<AgentRunContext['requestPermission']>(async () => ({ requestId: 'core-id', outcome: 'allow', scope: 'task' })) });
    await adapter.run(run);
    expect(run.requestPermission).toHaveBeenCalledExactlyOnceWith({ capability: 'file.read', reason: 'Read exactly approved sandbox file', paths: [{ path: '/allowed/data', access: 'read' }] });
    expect(allowOnce).toHaveBeenCalledOnce();
    expect(text(run)).toContain('"optionId":"once"');
    expect(text(run)).not.toContain('"optionId":"always"');
  });

  it('does not allow a native operation if the OS plan cannot apply the approval', async () => {
    const { adapter } = setup('permission', {}, async () => ({ request: { capability: 'tool.execute', reason: 'Scoped operation' }, allowOnce: async () => false }));
    const run = context({ requestPermission: vi.fn<AgentRunContext['requestPermission']>(async () => ({ requestId: 'p', outcome: 'allow', scope: 'once' })) });
    await adapter.run(run);
    expect(text(run)).toContain('"optionId":"reject"');
  });

  it('executes the explicit Your Bot extension exclusively through context.executeTool', async () => {
    const { adapter } = setup('tool');
    const run = context();
    await adapter.run(run);
    expect(run.executeTool).toHaveBeenCalledExactlyOnceWith({ id: 'tool-1', kind: 'skill', skillId: 'example', input: { hello: true } });
    expect(text(run)).toContain('"value":"host-result"');
    expect(run.updates.filter(update => update.type === 'tool')).toEqual([]);
  });

  it('sends session/cancel, suppresses late updates and tears down the contained process', async () => {
    const { adapter, mock } = setup('hang');
    const run = context();
    const result = adapter.run(run).catch(error => error);
    await waitUntil(() => text(run) === 'started');
    await adapter.cancel(run.taskId);
    expect(await result).toMatchObject({ code: 'CANCELLED' });
    expect(outbound(mock)).toContainEqual({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'acp-session' } });
    expect(text(run)).toBe('started');
    expect(mock.terminations).toBe(1);
    expect(mock.children[0].signalCode).toBe('SIGTERM');
  });

  it('returns cancelled permission outcomes when core approval is pending', async () => {
    const { adapter, mock } = setup('permission', {}, async () => ({ request: { capability: 'file.read', reason: 'Scoped file' }, allowOnce: async () => true }));
    let asked = false;
    const run = context({ requestPermission: () => { asked = true; return new Promise(() => {}); } });
    const result = adapter.run(run).catch(error => error);
    await waitUntil(() => asked);
    await adapter.cancel(run.taskId);
    expect(await result).toMatchObject({ code: 'CANCELLED' });
    expect(outbound(mock)).toContainEqual({ jsonrpc: '2.0', id: 100, result: { outcome: { outcome: 'cancelled' } } });
  });

  it('propagates external abort and closes active tasks', async () => {
    const { adapter, mock } = setup('hang');
    const controller = new AbortController();
    const first = context({ signal: controller.signal });
    const result = adapter.run(first).catch(error => error);
    await waitUntil(() => text(first) === 'started');
    controller.abort();
    expect(await result).toMatchObject({ code: 'CANCELLED' });
    const second = context({ taskId: 'second' });
    const result2 = adapter.run(second).catch(error => error);
    await waitUntil(() => text(second) === 'started');
    await adapter.close();
    expect(await result2).toMatchObject({ code: 'CANCELLED' });
    expect(mock.terminations).toBe(2);
    await expect(adapter.run(context({ taskId: 'third' }))).rejects.toMatchObject({ code: 'CLOSED' });
  });

  it('rejects an already-aborted task before launch', async () => {
    const { adapter, mock } = setup('stream');
    await expect(adapter.run(context({ signal: AbortSignal.abort() }))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(mock.launch).not.toHaveBeenCalled();
  });

  it.each([
    ['v2', 'ACP_VERSION'], ['malformed', 'INVALID_RESPONSE'], ['exit', 'HARNESS_EXIT'],
    ['wrong-session', 'INVALID_RESPONSE'], ['oversize', 'RESPONSE_LIMIT'],
  ])('normalizes %s failure and cleans up', async (mode, code) => {
    const { adapter, mock } = setup(mode, { maxMessageBytes: 2000 });
    await expect(adapter.run(context())).rejects.toMatchObject({ code });
    expect(mock.terminations).toBe(1);
  });

  it('times out initialize and terminates the harness', async () => {
    const { adapter, mock } = setup('timeout-init', { timeoutMs: 150 });
    await expect(adapter.run(context())).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(mock.terminations).toBe(1);
  });

  it('retires a launcher handle that arrives after a timeout', async () => {
    const mock = mockLauncher('stream');
    const launcher: ContainmentLauncher = { async launch(request) {
      await new Promise(resolve => setTimeout(resolve, 100));
      return mock.launch(request);
    } };
    const adapter = new AcpAdapter(config, { launcher, timeoutMs: 30 });
    cleanup.push(() => adapter.close());
    await expect(adapter.run(context())).rejects.toMatchObject({ code: 'TIMEOUT' });
    await waitUntil(() => mock.terminations === 1 && mock.children[0].signalCode !== null);
  });

  it('bounds permission requests before consulting another host plan', async () => {
    const prepare = vi.fn<NonNullable<ContainedHarness['preparePermission']>>(async () => undefined);
    const { adapter } = setup('permission-many', { maxToolCalls: 1 }, prepare);
    const run = context();
    await adapter.run(run);
    expect(prepare).toHaveBeenCalledOnce();
    expect(text(run)).toContain('"code":-32603');
  });

  it('surfaces containment teardown failure rather than claiming successful cleanup', async () => {
    const mock = mockLauncher('stream');
    const launcher: ContainmentLauncher = { async launch(request) {
      const handle = await mock.launch(request);
      return { ...handle, async terminate() { await handle.terminate(); throw new Error('SENSITIVE details'); } };
    } };
    const adapter = new AcpAdapter(config, { launcher });
    cleanup.push(() => adapter.close());
    await expect(adapter.run(context())).rejects.toMatchObject({ code: 'CONTAINMENT_FAILURE', message: 'Containment launcher could not confirm complete harness termination.' });
  });

  it('uses per-provider launchers for independent harness configurations', async () => {
    const first = mockLauncher('stream');
    const second = mockLauncher('stream');
    const adapters = createAdapters([config, { ...config, id: 'other', command: '/different/runtime/agent' }], {
      acpByProvider: { acp: { launcher: first.launcher }, other: { launcher: second.launcher } },
    });
    cleanup.push(async () => { await Promise.all(adapters.map(adapter => adapter.close())); });
    await Promise.all(adapters.map((adapter, i) => adapter.run(context({ taskId: `task-${i}` }))));
    expect(first.launch.mock.calls[0][0].command).toBe('/readonly/agent');
    expect(second.launch.mock.calls[0][0].command).toBe('/different/runtime/agent');
    expect(first.terminations).toBe(1);
    expect(second.terminations).toBe(1);
  });
});
