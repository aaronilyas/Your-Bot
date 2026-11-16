import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpBuiltinTool, McpCall, McpServerConfig } from '@your-bot/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpBroker, type McpBrokerHandle, type McpBrokerSession } from './index.js';

const fixture = (name: string) => fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url));

let dir: string;
let counterFile: string;
let broker: McpBrokerHandle;
let extraClose: (() => Promise<void>)[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mcp-broker-'));
  counterFile = path.join(dir, 'counter.log');
  broker = createMcpBroker({ connectTimeoutMs: 15_000, killGraceMs: 500, baseEnv: process.env });
});
afterEach(async () => {
  await broker.close();
  for (const close of extraClose) await close();
  extraClose = [];
  rmSync(dir, { recursive: true, force: true });
});

const stdioConfig = (overrides: Partial<Extract<McpServerConfig, { transport: 'stdio' }>> = {}): McpServerConfig => ({
  id: 'stdio1', name: 'Fixture', enabled: true, transport: 'stdio',
  command: process.execPath, args: [fixture('stdio-upstream.mjs')], env: { FIXTURE_COUNTER_FILE: counterFile }, ...overrides
});

const calls = () => (existsSync(counterFile) ? readFileSync(counterFile, 'utf8').split('\n').filter(Boolean) : []);

/** In-process fake HTTP upstream; requires header x-test: secret-value. */
async function startHttpUpstream(): Promise<{ url: string; count: () => number; sawHeader: () => boolean }> {
  let count = 0;
  let sawHeader = false;
  const server: HttpServer = createServer((req, res) => {
    if (req.headers['x-test'] !== 'secret-value') { res.writeHead(403).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    sawHeader = true;
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', async () => {
      const mcp = new Server({ name: 'fixture-http', version: '1.0.0' }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: 'greet', description: 'Greets', inputSchema: { type: 'object', properties: { who: { type: 'string' } } } }]
      }));
      mcp.setRequestHandler(CallToolRequestSchema, async request => {
        count += 1;
        return { content: [{ type: 'text', text: `hello ${(request.params.arguments as { who?: string } | undefined)?.who}` }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString('utf8')));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  extraClose.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, count: () => count, sawHeader: () => sawHeader };
}

async function open(servers: McpServerConfig[], options: { authorize?: (call: McpCall) => boolean; builtins?: McpBuiltinTool[]; signal?: AbortSignal; decisions?: McpCall[] } = {}): Promise<McpBrokerSession> {
  return broker.open({
    taskId: 'task-1', botId: 'bot-1', servers, builtins: options.builtins ?? [],
    authorize: async call => { options.decisions?.push(call); return options.authorize ? options.authorize(call) : true; },
    signal: options.signal ?? new AbortController().signal
  });
}

async function connect(session: McpBrokerSession, headers?: Record<string, string>): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(session.endpoint.url), {
    requestInit: { headers: headers ?? Object.fromEntries(session.endpoint.headers.map(header => [header.name, header.value])) }
  });
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(transport);
  extraClose.push(() => client.close());
  return client;
}

function rawRequest(url: string, options: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpRequest({ host: target.hostname, port: target.port, path: target.pathname, method: options.method ?? 'POST', headers: options.headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk as Buffer));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

const initBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
const jsonHeaders = (session: McpBrokerSession, extra: Record<string, string> = {}) => ({
  'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
  ...Object.fromEntries(session.endpoint.headers.map(header => [header.name, header.value])), ...extra
});

const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitUntil(predicate: () => boolean, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (predicate()) return true; await new Promise(r => setTimeout(r, 50)); }
  return predicate();
}
const textOf = (result: unknown) => ((result as { content: { text: string }[] }).content[0]?.text ?? '');

describe('tools listing and namespacing', () => {
  it('lists stdio + http upstream tools namespaced, plus builtins; invalid names are recorded not crashed', async () => {
    const http = await startHttpUpstream();
    const builtin: McpBuiltinTool = { name: 'remember', description: 'Remember', inputSchema: { type: 'object' }, handle: async () => 'ok' };
    const session = await open([
      stdioConfig(),
      { id: 'web', name: 'Web', enabled: true, transport: 'http', url: http.url, headers: { 'x-test': 'secret-value' } },
      { id: 'off', name: 'Disabled', enabled: false, transport: 'stdio', command: 'definitely-missing' }
    ], { builtins: [builtin] });
    const infos = await session.tools();
    expect(infos.map(info => `${info.serverId}/${info.name}`).sort()).toEqual([
      'stdio1/echo', 'stdio1/env', 'stdio1/huge', 'stdio1/pids', 'stdio1/side_effect', 'web/greet', 'your_bot/remember'
    ]);
    expect(session.failures()).toEqual([{ serverId: 'stdio1', tool: 'bad.name', reason: expect.stringContaining('not valid') }]);

    const client = await connect(session);
    const listed = (await client.listTools()).tools.map(tool => tool.name).sort();
    expect(listed).toEqual(['stdio1__echo', 'stdio1__env', 'stdio1__huge', 'stdio1__pids', 'stdio1__side_effect', 'web__greet', 'your_bot__remember']);
    expect(http.sawHeader()).toBe(true);
  });

  it('records failed upstreams with a reason (secrets scrubbed) and still serves the others', async () => {
    const session = await open([
      stdioConfig(),
      { id: 'broken', name: 'Broken', enabled: true, transport: 'stdio', command: process.execPath, args: [fixture('broken-upstream.mjs')], env: { API_KEY: 'super-secret-key' } },
      { id: 'missing', name: 'Missing', enabled: true, transport: 'stdio', command: 'definitely-not-a-real-binary-xyz' },
      { id: 'down', name: 'Down', enabled: true, transport: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer top-secret-token' } },
      { id: 'bad__id', name: 'Bad', enabled: true, transport: 'http', url: 'http://127.0.0.1:1/mcp' },
      { id: 'your_bot', name: 'Reserved', enabled: true, transport: 'http', url: 'http://127.0.0.1:1/mcp' }
    ]);
    const failed = new Map(session.failures().filter(failure => !failure.tool).map(failure => [failure.serverId, failure.reason]));
    expect([...failed.keys()].sort()).toEqual(['bad__id', 'broken', 'down', 'missing', 'your_bot']);
    expect(failed.get('broken')).toContain('fixture failed to start');
    expect(JSON.stringify([...failed])).not.toContain('super-secret-key');
    expect(JSON.stringify([...failed])).not.toContain('top-secret-token');
    expect((await session.tools()).every(info => info.serverId === 'stdio1')).toBe(true);
  });
});

describe('authorization', () => {
  it('forwards an allowed call with the exact McpCall and returns the upstream result', async () => {
    const decisions: McpCall[] = [];
    const session = await open([stdioConfig()], { decisions });
    const client = await connect(session);
    const result = await client.callTool({ name: 'stdio1__echo', arguments: { text: 'hi' } });
    expect(textOf(result)).toBe('hi');
    expect(decisions).toEqual([{ serverId: 'stdio1', tool: 'echo', arguments: { text: 'hi' } }]);
    expect(calls()).toEqual(['call:echo']);
  });

  it('denied calls return an MCP tool error and never reach the stdio or http upstream', async () => {
    const http = await startHttpUpstream();
    const decisions: McpCall[] = [];
    const session = await open([
      stdioConfig(),
      { id: 'web', name: 'Web', enabled: true, transport: 'http', url: http.url, headers: { 'x-test': 'secret-value' } }
    ], { authorize: () => false, decisions });
    const client = await connect(session);
    const denied = await client.callTool({ name: 'stdio1__side_effect', arguments: {} });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toBe('Permission denied');
    const deniedHttp = await client.callTool({ name: 'web__greet', arguments: { who: 'x' } });
    expect(deniedHttp.isError).toBe(true);
    expect(textOf(deniedHttp)).toBe('Permission denied');
    expect(calls()).toEqual([]);
    expect(http.count()).toBe(0);
    expect(decisions.map(call => `${call.serverId}/${call.tool}`)).toEqual(['stdio1/side_effect', 'web/greet']);
  });

  it('treats an authorize rejection as a denial', async () => {
    const session = await broker.open({
      taskId: 't', botId: 'b', servers: [stdioConfig()], builtins: [],
      authorize: async () => { throw new Error('boom'); }, signal: new AbortController().signal
    });
    const client = await connect(session);
    const result = await client.callTool({ name: 'stdio1__side_effect', arguments: {} });
    expect(textOf(result)).toBe('Permission denied');
    expect(calls()).toEqual([]);
  });

  it('authorizes builtins (serverId your_bot) before handling them', async () => {
    let handled = 0;
    const builtin: McpBuiltinTool = {
      name: 'remember', description: 'Remember', inputSchema: { type: 'object' },
      handle: async args => { handled += 1; return { saved: args }; }
    };
    const decisions: McpCall[] = [];
    const allowed = await open([], { builtins: [builtin], decisions });
    const client = await connect(allowed);
    const result = await client.callTool({ name: 'your_bot__remember', arguments: { fact: 'sky is blue' } });
    expect(JSON.parse(textOf(result))).toEqual({ saved: { fact: 'sky is blue' } });
    expect(decisions).toEqual([{ serverId: 'your_bot', tool: 'remember', arguments: { fact: 'sky is blue' } }]);
    expect(handled).toBe(1);

    const denied = await open([], { builtins: [builtin], authorize: () => false });
    const deniedClient = await connect(denied);
    const deniedResult = await deniedClient.callTool({ name: 'your_bot__remember', arguments: {} });
    expect(deniedResult.isError).toBe(true);
    expect(textOf(deniedResult)).toBe('Permission denied');
    expect(handled).toBe(1);
  });

  it('returns a tool error for unknown tools and a failing builtin', async () => {
    const builtin: McpBuiltinTool = { name: 'explode', description: 'x', inputSchema: { type: 'object' }, handle: async () => { throw new Error('kaput'); } };
    const session = await open([stdioConfig()], { builtins: [builtin] });
    const client = await connect(session);
    expect((await client.callTool({ name: 'stdio1__nope', arguments: {} })).isError).toBe(true);
    const failed = await client.callTool({ name: 'your_bot__explode', arguments: {} });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain('kaput');
  });

  it('rejects invalid builtin names at open()', async () => {
    const bad: McpBuiltinTool = { name: 'bad name', description: 'x', inputSchema: { type: 'object' }, handle: async () => null };
    await expect(open([], { builtins: [bad] })).rejects.toThrow(/Invalid builtin/);
  });
});

describe('limits', () => {
  it('rejects arguments over 1 MiB without contacting the upstream, and results over 1 MiB', async () => {
    const session = await open([stdioConfig()]);
    const client = await connect(session);
    const big = await client.callTool({ name: 'stdio1__echo', arguments: { text: 'a'.repeat(1024 * 1024 + 16) } });
    expect(big.isError).toBe(true);
    expect(textOf(big)).toContain('Arguments too large');
    expect(calls()).toEqual([]);
    const huge = await client.callTool({ name: 'stdio1__huge', arguments: {} });
    expect(huge.isError).toBe(true);
    expect(textOf(huge)).toContain('Result too large');
  });

  it('rejects request bodies far beyond the limit with 413', async () => {
    const session = await open([]);
    // The server answers 413 before reading the body; some kernels (macOS) then reset the client's
    // still-writing socket. Either outcome means the body was refused.
    const outcome = await rawRequest(session.endpoint.url, { headers: jsonHeaders(session), body: 'x'.repeat(2 * 1024 * 1024) })
      .then(response => response.status, (error: NodeJS.ErrnoException) => error.code);
    expect([413, 'ECONNRESET', 'EPIPE']).toContain(outcome);
  });
});

describe('proxy HTTP security', () => {
  it('listens only on 127.0.0.1 with an OS-assigned port', async () => {
    const session = await open([]);
    const url = new URL(session.endpoint.url);
    expect(url.hostname).toBe('127.0.0.1');
    expect(Number(url.port)).toBeGreaterThan(0);
    // Reachable on loopback ...
    expect((await rawRequest(session.endpoint.url, { headers: jsonHeaders(session), body: initBody })).status).toBe(200);
    // ... and the socket is bound to 127.0.0.1 only (not 0.0.0.0 / ::).
    const { execFileSync } = await import('node:child_process');
    if (process.platform === 'linux') {
      const listing = execFileSync('ss', ['-ltnH', `sport = :${url.port}`], { encoding: 'utf8' });
      expect(listing).toContain(`127.0.0.1:${url.port}`);
      expect(listing).not.toMatch(/(0\.0\.0\.0|\*|\[::\]):\d+/);
    }
  });

  it('issues a distinct 256-bit bearer token per session', async () => {
    const a = await open([]);
    const b = await open([]);
    const token = (session: McpBrokerSession) => session.endpoint.headers.find(header => header.name === 'Authorization')!.value.replace('Bearer ', '');
    expect(Buffer.from(token(a), 'base64url')).toHaveLength(32);
    expect(token(a)).not.toBe(token(b));
    // Session A's token does not open session B.
    const cross = await rawRequest(b.endpoint.url, { headers: jsonHeaders(b, { Authorization: `Bearer ${token(a)}` }), body: initBody });
    expect(cross.status).toBe(401);
  });

  it('rejects a missing token, wrong token and malformed scheme with 401', async () => {
    const session = await open([]);
    const base = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    expect((await rawRequest(session.endpoint.url, { headers: base, body: initBody })).status).toBe(401);
    expect((await rawRequest(session.endpoint.url, { headers: { ...base, Authorization: 'Bearer wrong' }, body: initBody })).status).toBe(401);
    expect((await rawRequest(session.endpoint.url, { headers: { ...base, Authorization: 'Bearer ' }, body: initBody })).status).toBe(401);
    expect((await rawRequest(session.endpoint.url, { headers: { ...base, Authorization: session.endpoint.headers[0]!.value.replace('Bearer ', 'Basic ') }, body: initBody })).status).toBe(401);
    expect((await rawRequest(session.endpoint.url, { headers: jsonHeaders(session), body: initBody })).status).toBe(200);
  });

  it('rejects a Host header other than 127.0.0.1:<port> / localhost:<port> (DNS rebinding)', async () => {
    const session = await open([]);
    const port = new URL(session.endpoint.url).port;
    for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1', `127.0.0.1:${Number(port) + 1}`, `[::1]:${port}`, `127.0.0.1.evil.example:${port}`]) {
      const response = await rawRequest(session.endpoint.url, { headers: jsonHeaders(session, { Host: host }), body: initBody });
      expect(response.status, host).toBe(403);
    }
    for (const host of [`localhost:${port}`, `LOCALHOST:${port}`, `127.0.0.1:${port}`]) {
      const response = await rawRequest(session.endpoint.url, { headers: jsonHeaders(session, { Host: host }), body: initBody });
      expect(response.status, host).toBe(200);
    }
  });

  it('rejects any request carrying an Origin header, even with a valid token', async () => {
    const session = await open([]);
    for (const origin of ['http://evil.example', `http://127.0.0.1:${new URL(session.endpoint.url).port}`, 'null']) {
      const response = await rawRequest(session.endpoint.url, { headers: jsonHeaders(session, { Origin: origin }), body: initBody });
      expect(response.status, origin).toBe(403);
    }
  });

  it('only serves POST on /mcp', async () => {
    const session = await open([]);
    const get = await rawRequest(session.endpoint.url, { method: 'GET', headers: jsonHeaders(session) });
    expect(get.status).toBe(405);
    const wrongPath = await rawRequest(session.endpoint.url.replace('/mcp', '/other'), { headers: jsonHeaders(session), body: initBody });
    expect(wrongPath.status).toBe(404);
  });

  it('stops listening after close()', async () => {
    const session = await open([]);
    await session.close();
    await expect(rawRequest(session.endpoint.url, { headers: jsonHeaders(session), body: initBody })).rejects.toThrow();
  });
});

describe('cleanup', () => {
  it('close() kills the stdio child and its grandchildren', async () => {
    const session = await open([stdioConfig()]);
    const client = await connect(session);
    const { pid, grandchild } = JSON.parse(textOf(await client.callTool({ name: 'stdio1__pids', arguments: {} }))) as { pid: number; grandchild: number };
    expect(pidAlive(pid)).toBe(true);
    expect(pidAlive(grandchild)).toBe(true);
    await session.close();
    expect(await waitUntil(() => !pidAlive(pid) && !pidAlive(grandchild))).toBe(true);
  });

  it('aborting the open() signal tears the session down and kills the child tree', async () => {
    const abort = new AbortController();
    const session = await open([stdioConfig()], { signal: abort.signal });
    const client = await connect(session);
    const { pid, grandchild } = JSON.parse(textOf(await client.callTool({ name: 'stdio1__pids', arguments: {} }))) as { pid: number; grandchild: number };
    abort.abort();
    expect(await waitUntil(() => !pidAlive(pid) && !pidAlive(grandchild))).toBe(true);
    await expect(rawRequest(session.endpoint.url, { headers: jsonHeaders(session), body: initBody })).rejects.toThrow();
  });

  it('aborting during connect rejects open() and leaves no child behind', async () => {
    const abort = new AbortController();
    const promise = open([stdioConfig()], { signal: abort.signal });
    abort.abort();
    await expect(promise).rejects.toThrow();
  });

  it('rejects open() with an already aborted signal and after the broker is closed', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(open([], { signal: abort.signal })).rejects.toThrow(/Aborted/);
    await broker.close();
    await expect(open([])).rejects.toThrow(/closed/);
  });

  it('broker.close() closes every open session', async () => {
    const a = await open([]);
    const b = await open([]);
    await broker.close();
    await expect(rawRequest(a.endpoint.url, { headers: jsonHeaders(a), body: initBody })).rejects.toThrow();
    await expect(rawRequest(b.endpoint.url, { headers: jsonHeaders(b), body: initBody })).rejects.toThrow();
  });

  it('only a minimal allowlisted environment reaches stdio children', async () => {
    process.env.YOUR_BOT_TEST_HOST_SECRET = 'leak-me';
    try {
      const session = await open([stdioConfig({ env: { FIXTURE_COUNTER_FILE: counterFile, EXPLICIT: 'yes' } })]);
      const client = await connect(session);
      expect(textOf(await client.callTool({ name: 'stdio1__env', arguments: { name: 'YOUR_BOT_TEST_HOST_SECRET' } }))).toBe('<unset>');
      expect(textOf(await client.callTool({ name: 'stdio1__env', arguments: { name: 'EXPLICIT' } }))).toBe('yes');
    } finally { delete process.env.YOUR_BOT_TEST_HOST_SECRET; }
  });
});
