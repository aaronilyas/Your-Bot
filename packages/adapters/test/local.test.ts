import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleAdapter, createAdapters } from '../src/index.js';
import { context, event, httpServer, provider, readBody, waitUntil } from './helpers.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(handler: Parameters<typeof httpServer>[0], options: ConstructorParameters<typeof OpenAICompatibleAdapter>[1] = {}) {
  const server = await httpServer(handler);
  cleanup.push(server.close);
  const adapter = new OpenAICompatibleAdapter(provider(server.endpoint), options);
  cleanup.push(() => adapter.close());
  return { adapter, server };
}

describe('OpenAI-compatible local HTTP adapters', () => {
  it('accepts a bare server origin as the /v1 base', async () => {
    let path = '';
    const server = await httpServer((req, res) => { path = req.url!; res.end('{"data":[{"id":"model"}]}'); });
    cleanup.push(server.close);
    const adapter = new OpenAICompatibleAdapter(provider(server.endpoint.replace('/v1', '')));
    cleanup.push(() => adapter.close());
    expect((await adapter.getInfo()).available).toBe(true);
    expect(path).toBe('/v1/models');
  });

  it('rejects endpoints that embed secrets or invalid schemes', () => {
    for (const endpoint of ['file:///etc/passwd', 'http://user:secret@localhost/v1', 'http://localhost/v1?key=secret', 'not-a-url']) {
      expect(() => new OpenAICompatibleAdapter(provider(endpoint))).toThrow(/without credentials/);
    }
  });
  it.each(['lmstudio', 'llamacpp', 'openai-compatible'] as const)('discovers models for %s via /v1/models', async kind => {
    const paths: string[] = [];
    const server = await httpServer((req, res) => {
      paths.push(req.url!);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'a' }, { id: 'b', name: 'Bee' }] }));
    });
    cleanup.push(server.close);
    const adapter = new OpenAICompatibleAdapter(provider(server.endpoint, { kind }));
    cleanup.push(() => adapter.close());
    expect(await adapter.getInfo()).toMatchObject({ available: true, models: [{ id: 'a', name: 'a' }, { id: 'b', name: 'Bee' }] });
    expect(paths).toEqual(['/v1/models']);
  });

  it('streams fragmented UTF-8 SSE and sends the configured model and transcript', async () => {
    let body: Record<string, unknown> = {};
    const { adapter } = await setup(async (req, res) => {
      body = await readBody(req);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      const bytes = Buffer.from(':keepalive\r\n' + event({ content: 'Hi 🌍' }) + event({}, 'stop') + 'data: [DONE]\r\n\r\n');
      for (const byte of bytes) res.write(Buffer.from([byte]));
      res.end();
    });
    const run = context();
    await adapter.run(run);
    expect(run.updates).toEqual([{ type: 'text', text: 'Hi 🌍' }]);
    expect(body).toMatchObject({ model: 'test-model', stream: true, messages: [{ role: 'user', content: 'Hello' }], tools: [{ function: { name: 'execute_tool' } }] });
  });

  it('discovers a fallback model and honors the session model override', async () => {
    const models: unknown[] = [];
    let discoveries = 0;
    const server = await httpServer(async (req, res) => {
      if (req.url === '/v1/models') { discoveries++; res.end(JSON.stringify({ data: [{ id: 'discovered' }] })); return; }
      models.push((await readBody(req)).model);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'JSON fallback' }, finish_reason: 'stop' }] }));
    });
    cleanup.push(server.close);
    const adapter = new OpenAICompatibleAdapter(provider(server.endpoint, { modelId: undefined }));
    cleanup.push(() => adapter.close());
    const first = context();
    await adapter.run(first);
    const second = context({ taskId: 't2' });
    second.session.modelId = 'selected';
    await adapter.run(second);
    expect(models).toEqual(['discovered', 'selected']);
    expect(discoveries).toBe(1);
    expect(first.updates).toEqual([{ type: 'text', text: 'JSON fallback' }]);
  });

  it('assembles tool argument fragments and returns only host-authorized results to the next round', async () => {
    const bodies: Record<string, unknown>[] = [];
    const { adapter } = await setup(async (req, res) => {
      bodies.push(await readBody(req));
      res.setHeader('Content-Type', 'text/event-stream');
      if (bodies.length === 1) {
        res.end(event({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'execute_', arguments: '{"kind":"python",' } }] })
          + event({ tool_calls: [{ index: 0, function: { name: 'tool', arguments: '"code":"print(1)","input":null}' } }] }, 'tool_calls') + 'data: [DONE]\n\n');
      } else res.end(event({ content: 'Tool denied safely.' }, 'stop') + 'data: [DONE]\n\n');
    });
    const run = context({ executeTool: vi.fn(async () => ({ ok: false, error: { code: 'DENIED', message: 'Approval denied.' } })) });
    await adapter.run(run);
    expect(run.executeTool).toHaveBeenCalledExactlyOnceWith({ id: 'call-1', kind: 'python', code: 'print(1)', input: null });
    expect(bodies[1].messages).toMatchObject([
      { role: 'user' }, { role: 'assistant', tool_calls: [{ id: 'call-1' }] },
      { role: 'tool', tool_call_id: 'call-1', content: JSON.stringify({ ok: false, error: { code: 'DENIED', message: 'Approval denied.' } }) },
    ]);
    expect(run.updates.filter(update => update.type === 'tool')).toEqual([]);
  });

  it('validates a whole tool batch before any tool executes', async () => {
    const { adapter } = await setup((_, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(event({ tool_calls: [
        { index: 0, id: 'a', function: { name: 'execute_tool', arguments: '{"kind":"skill","skillId":"ok","input":null}' } },
        { index: 1, id: 'b', function: { name: 'run_shell', arguments: '{}' } },
      ] }, 'tool_calls'));
    });
    const run = context();
    await expect(adapter.run(run)).rejects.toMatchObject({ code: 'INVALID_TOOL_CALL' });
    expect(run.executeTool).not.toHaveBeenCalled();
  });

  it('bounds tool rounds without executing extra requests', async () => {
    let requests = 0;
    const { adapter } = await setup((_, res) => {
      requests++;
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(event({ tool_calls: [{ index: 0, id: `call-${requests}`, function: { name: 'execute_tool', arguments: '{"kind":"skill","skillId":"s","input":null}' } }] }, 'tool_calls'));
    }, { maxToolRounds: 1 });
    const run = context();
    await expect(adapter.run(run)).rejects.toMatchObject({ code: 'TOOL_LIMIT' });
    expect(run.executeTool).toHaveBeenCalledTimes(1);
    expect(requests).toBe(2);
  });

  it('rejects reused tool IDs in later rounds', async () => {
    const { adapter } = await setup((_, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(event({ tool_calls: [{ index: 0, id: 'reused', function: { name: 'execute_tool', arguments: '{"kind":"skill","skillId":"s","input":null}' } }] }, 'tool_calls'));
    });
    const run = context();
    await expect(adapter.run(run)).rejects.toMatchObject({ code: 'INVALID_TOOL_CALL' });
    expect(run.executeTool).toHaveBeenCalledTimes(1);
  });

  it('cancels a stalled HTTP stream and ignores late text', async () => {
    let entered = false;
    let disconnected = false;
    const { adapter } = await setup((_, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(event({ content: 'start' }));
      res.on('close', () => { disconnected = true; });
      entered = true;
    });
    const run = context();
    const result = adapter.run(run).catch(error => error);
    await waitUntil(() => entered && run.updates.length > 0);
    await adapter.cancel(run.taskId);
    expect(await result).toMatchObject({ code: 'CANCELLED' });
    await waitUntil(() => disconnected);
    expect(run.updates).toEqual([{ type: 'text', text: 'start' }]);
  });

  it('handles an already-aborted signal without sending a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const adapter = new OpenAICompatibleAdapter(provider('http://127.0.0.1:1/v1'), { fetch: fetcher });
    cleanup.push(() => adapter.close());
    await expect(adapter.run(context({ signal: AbortSignal.abort() }))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('times out a stalled response and stops waiting for an uncooperative host tool', async () => {
    const { adapter } = await setup((_, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(event({ tool_calls: [{ index: 0, id: 'a', function: { name: 'execute_tool', arguments: '{"kind":"skill","skillId":"s","input":null}' } }] }, 'tool_calls'));
    }, { timeoutMs: 100 });
    await expect(adapter.run(context({ executeTool: () => new Promise(() => {}) }))).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('closes active runs and rejects subsequent use', async () => {
    let entered = false;
    const { adapter } = await setup((_, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.flushHeaders(); entered = true; });
    const result = adapter.run(context()).catch(error => error);
    await waitUntil(() => entered);
    await adapter.close();
    expect(await result).toMatchObject({ code: 'CANCELLED' });
    await expect(adapter.run(context({ taskId: 'new' }))).rejects.toMatchObject({ code: 'CLOSED' });
  });

  it('refuses concurrent reuse of a task ID and keeps other tasks independent', async () => {
    let requests = 0;
    const { adapter } = await setup((_, res) => { requests++; res.setHeader('Content-Type', 'text/event-stream'); res.flushHeaders(); });
    const first = adapter.run(context()).catch(error => error);
    await waitUntil(() => requests === 1);
    await expect(adapter.run(context())).rejects.toMatchObject({ code: 'TASK_ACTIVE' });
    const second = adapter.run(context({ taskId: 'other' })).catch(error => error);
    await waitUntil(() => requests === 2);
    await adapter.cancel('task-1');
    expect(await first).toMatchObject({ code: 'CANCELLED' });
    await adapter.cancel('other');
    expect(await second).toMatchObject({ code: 'CANCELLED' });
  });

  it.each([
    ['truncated', event({ content: 'partial' }), 'TRUNCATED_STREAM'],
    ['malformed', 'data: not-json\n\n', 'INVALID_RESPONSE'],
    ['provider-error', 'data: {"error":{"message":"SECRET"}}\n\n', 'PROVIDER_ERROR'],
    ['length', event({}, 'length'), 'INCOMPLETE_COMPLETION'],
  ])('normalizes %s failures', async (_, stream, code) => {
    const { adapter } = await setup((_, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.end(stream); });
    await expect(adapter.run(context())).rejects.toMatchObject({ code });
  });

  it('never exposes HTTP error bodies or credentials and refuses credential redirects', async () => {
    const { adapter, server } = await setup((_, res) => { res.statusCode = 401; res.end('SECRET-CREDENTIAL'); });
    const keyed = new OpenAICompatibleAdapter(provider(server.endpoint, { apiKey: 'SECRET-CREDENTIAL' }));
    cleanup.push(() => keyed.close());
    const error = await keyed.run(context()).catch(error => error as Error);
    expect(error).toMatchObject({ code: 'HTTP_401', message: 'Model provider returned HTTP 401.' });
    expect(String(error)).not.toContain('SECRET-CREDENTIAL');
    expect((await adapter.getInfo()).available).toBe(false);
    const redirect = await httpServer((_, res) => { res.writeHead(302, { Location: server.endpoint + '/models' }); res.end(); });
    cleanup.push(redirect.close);
    const redirected = new OpenAICompatibleAdapter(provider(redirect.endpoint, { apiKey: 'SECRET-CREDENTIAL' }));
    cleanup.push(() => redirected.close());
    await expect(redirected.run(context())).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('applies size limits to SSE and discovery JSON', async () => {
    const { adapter } = await setup((req, res) => {
      if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'x'.repeat(300) }] })); return; }
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(event({ content: 'x'.repeat(300) }, 'stop'));
    }, { maxResponseBytes: 100 });
    await expect(adapter.run(context())).rejects.toMatchObject({ code: 'RESPONSE_LIMIT' });
    expect(await adapter.getInfo()).toMatchObject({ available: false, limitation: 'Provider response exceeded the size limit.' });
  });

  it('does not contact disabled providers and builds independent multi-provider adapters', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const adapters = createAdapters([
      provider('http://localhost:1/v1', { id: 'a', enabled: false }),
      provider('http://localhost:2/v1', { id: 'b', kind: 'llamacpp', enabled: false }),
      { id: 'c', name: 'Harness 1', kind: 'acp', enabled: true, command: '/agent' },
      { id: 'd', name: 'Harness 2', kind: 'acp', enabled: false, command: '/other' },
    ], { local: { fetch: fetcher } });
    cleanup.push(async () => { await Promise.all(adapters.map(adapter => adapter.close())); });
    expect(adapters.map(adapter => adapter.id)).toEqual(['a', 'b', 'c', 'd']);
    expect((await adapters[0].getInfo()).available).toBe(false);
    await expect(adapters[0].run(context())).rejects.toMatchObject({ code: 'DISABLED' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => createAdapters([provider('http://a/v1'), provider('http://b/v1')])).toThrow(/unique/);
  });
});
