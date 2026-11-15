import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type {
  JsonValue, McpBroker, McpBuiltinTool, McpCall, McpProxyEndpoint, McpProxySession, McpServerConfig, McpToolInfo
} from '@your-bot/contracts';
import { expandPreset } from './presets.js';
import { StdioProcessTransport } from './process.js';

export const BUILTIN_SERVER_ID = 'your_bot';
export const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_TOOLS_PER_SERVER = 512;
const MAX_DESCRIPTION_CHARS = 4096;
const MAX_REQUEST_BODY_BYTES = MAX_PAYLOAD_BYTES + 64 * 1024;
const SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_NAMESPACED_LENGTH = 64;
const PROXY_PATH = '/mcp';

export interface McpBrokerOptions {
  /** Upstream connect + initial tools/list timeout. Default 30 s. */
  connectTimeoutMs?: number;
  /** Per forwarded tools/call timeout. Default 120 s. */
  callTimeoutMs?: number;
  /** Grace between SIGTERM and SIGKILL for stdio trees. Default 2 s. */
  killGraceMs?: number;
  /** Environment stdio children inherit from (allowlisted). Default `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
}

export interface McpUpstreamFailure { serverId: string; tool?: string; reason: string }

/** The contract's session plus diagnostics (extra members are optional for consumers). */
export interface McpBrokerSession extends McpProxySession {
  /** Upstreams (or individual tools) that are absent from `tools()`, with the reason. Secrets scrubbed. */
  failures(): McpUpstreamFailure[];
}

export interface McpBrokerHandle extends McpBroker {
  open(input: Parameters<McpBroker['open']>[0]): Promise<McpBrokerSession>;
}

interface Upstream {
  config: McpServerConfig;
  client: Client;
  transport: Transport;
  tools: { name: string; description?: string; inputSchema: JsonValue }[];
  down?: string;
}

interface Route { serverId: string; tool: string; builtin?: McpBuiltinTool }

export function createMcpBroker(options: McpBrokerOptions = {}): McpBrokerHandle {
  const sessions = new Set<McpBrokerSession>();
  let closed = false;
  return {
    async open(input) {
      if (closed) throw new Error('MCP broker is closed');
      if (input.signal.aborted) throw new Error('Aborted');
      const holder: { session?: McpBrokerSession } = {};
      const session = await openSession(input, options, () => { if (holder.session) sessions.delete(holder.session); });
      holder.session = session;
      sessions.add(session);
      // Closed (e.g. aborted) while open() was finishing: do not retain it.
      if (input.signal.aborted) sessions.delete(session);
      return session;
    },
    async close() {
      closed = true;
      await Promise.all([...sessions].map(session => session.close()));
    }
  };
}

type OpenInput = Parameters<McpBroker['open']>[0];

async function openSession(input: OpenInput, options: McpBrokerOptions, onClosed: () => void): Promise<McpBrokerSession> {
  const connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
  const callTimeoutMs = options.callTimeoutMs ?? 120_000;
  validateBuiltins(input.builtins);

  const secrets = collectSecrets(input.servers);
  const scrub = (text: string): string => secrets.reduce((acc, secret) => acc.split(secret).join('***'), text).slice(0, 1024);
  const failures: McpUpstreamFailure[] = [];
  const upstreams = new Map<string, Upstream>();
  const sessionAbort = new AbortController();
  const stop = () => sessionAbort.abort();
  input.signal.addEventListener('abort', stop, { once: true });

  let httpServer: HttpServer | undefined;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      sessionAbort.abort();
      input.signal.removeEventListener('abort', stop);
      if (httpServer) {
        const server = httpServer;
        await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      }
      await Promise.allSettled([...upstreams.values()].map(upstream => upstream.client.close()));
      onClosed();
    })();
    return closePromise;
  };
  sessionAbort.signal.addEventListener('abort', () => { void close(); }, { once: true });

  try {
    // 1. Connect upstreams in parallel; failures are recorded, never thrown.
    const seen = new Set<string>();
    const pending: Promise<void>[] = [];
    for (const raw of input.servers) {
      if (!raw.enabled) continue;
      const idProblem = serverIdProblem(raw.id, seen);
      if (idProblem) { failures.push({ serverId: String(raw.id), reason: idProblem }); continue; }
      seen.add(raw.id);
      pending.push(connectUpstream(raw, options, connectTimeoutMs, sessionAbort.signal).then(
        upstream => { upstreams.set(raw.id, upstream); },
        (error: unknown) => { failures.push({ serverId: raw.id, reason: scrub(errorMessage(error)) }); }
      ));
    }
    await Promise.all(pending);
    if (sessionAbort.signal.aborted) throw new Error('Aborted');
    // Deterministic order regardless of connect timing.
    const order = new Map(input.servers.map((server, index) => [server.id, index]));
    const ordered = [...upstreams.values()].sort((a, b) => (order.get(a.config.id) ?? 0) - (order.get(b.config.id) ?? 0));
    upstreams.clear();
    for (const upstream of ordered) {
      upstream.client.onclose = () => { upstream.down ??= 'Upstream connection closed'; };
      upstreams.set(upstream.config.id, upstream);
    }

    // 2. Build the routing table (names validated, collisions rejected).
    const routes = new Map<string, Route>();
    const listing: { name: string; description?: string; inputSchema: JsonValue; route: Route }[] = [];
    for (const upstream of upstreams.values()) {
      for (const tool of upstream.tools) {
        const name = `${upstream.config.id}__${tool.name}`;
        if (!TOOL_NAME_PATTERN.test(tool.name) || name.length > MAX_NAMESPACED_LENGTH) {
          failures.push({ serverId: upstream.config.id, tool: tool.name, reason: 'Tool name is not valid for proxying (allowed: [A-Za-z0-9_-], namespaced name ≤ 64 chars)' });
          continue;
        }
        if (routes.has(name)) { failures.push({ serverId: upstream.config.id, tool: tool.name, reason: 'Duplicate tool name' }); continue; }
        const route: Route = { serverId: upstream.config.id, tool: tool.name };
        routes.set(name, route);
        listing.push({ name, description: tool.description, inputSchema: tool.inputSchema, route });
      }
    }
    for (const builtin of input.builtins) {
      const route: Route = { serverId: BUILTIN_SERVER_ID, tool: builtin.name, builtin };
      const name = `${BUILTIN_SERVER_ID}__${builtin.name}`;
      routes.set(name, route);
      listing.push({ name, description: builtin.description, inputSchema: builtin.inputSchema, route });
    }

    // 3. Proxy.
    const token = randomBytes(32).toString('base64url');
    const tokenDigest = createHash('sha256').update(token).digest();
    const authorizeBearer = (header: string | undefined): boolean => {
      const presented = typeof header === 'string' && /^Bearer /.test(header) ? header.slice(7) : '';
      const digest = createHash('sha256').update(presented).digest();
      return timingSafeEqual(digest, tokenDigest) && presented.length > 0;
    };

    const handleCall = async (fullName: string, rawArguments: unknown, signal: AbortSignal): Promise<CallToolResult> => {
      const route = routes.get(fullName);
      if (!route) return toolError(`Unknown tool: ${fullName.slice(0, 128)}`);
      let args: JsonValue;
      let serializedLength: number;
      try {
        args = (rawArguments ?? {}) as JsonValue;
        serializedLength = Buffer.byteLength(JSON.stringify(args));
      } catch { return toolError('Invalid arguments'); }
      if (serializedLength > MAX_PAYLOAD_BYTES) return toolError('Arguments too large (limit 1 MiB)');
      let allowed = false;
      try { allowed = (await input.authorize({ serverId: route.serverId, tool: route.tool, arguments: args } satisfies McpCall, signal)) === true; } catch { allowed = false; }
      if (!allowed) return toolError('Permission denied');
      if (signal.aborted) return toolError('Aborted');
      try {
        if (route.builtin) {
          const value = await route.builtin.handle(args, signal);
          const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
          return boundResult({ content: [{ type: 'text', text }] });
        }
        const upstream = upstreams.get(route.serverId);
        if (!upstream || upstream.down) return toolError('Upstream unavailable');
        const result = await upstream.client.callTool(
          { name: route.tool, arguments: args as Record<string, unknown> },
          undefined,
          { signal, timeout: callTimeoutMs, maxTotalTimeout: callTimeoutMs }
        );
        return boundResult(normalizeUpstreamResult(result));
      } catch (error) {
        return toolError(`Tool call failed: ${scrub(errorMessage(error))}`);
      }
    };

    httpServer = createServer((req, res) => {
      void handleRequest(req, res).catch(() => { if (!res.headersSent) respond(res, 500, 'Internal error'); else res.destroy(); });
    });
    httpServer.requestTimeout = 60_000;
    httpServer.headersTimeout = 10_000;
    httpServer.maxHeadersCount = 64;

    const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const port = (httpServer!.address() as AddressInfo).port;
      const host = (req.headers.host ?? '').toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return respond(res, 403, 'Forbidden host');
      if (req.headers.origin !== undefined) return respond(res, 403, 'Forbidden origin');
      if (!authorizeBearer(req.headers.authorization)) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        return respond(res, 401, 'Unauthorized');
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== PROXY_PATH) return respond(res, 404, 'Not found');
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return respond(res, 405, 'Method not allowed'); }
      const declared = Number(req.headers['content-length'] ?? 0);
      if (declared > MAX_REQUEST_BODY_BYTES) return respond(res, 413, 'Request too large');
      const body = await readBody(req, MAX_REQUEST_BODY_BYTES);
      if (body === undefined) return respond(res, 413, 'Request too large');
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { return respond(res, 400, 'Invalid JSON'); }

      const requestAbort = new AbortController();
      res.on('close', () => requestAbort.abort());
      const signal = AbortSignal.any([requestAbort.signal, sessionAbort.signal]);
      const mcp = new Server({ name: 'your-bot-mcp-proxy', version: '0.1.0' }, { capabilities: { tools: { listChanged: false } } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: listing.map(entry => ({
          name: entry.name,
          description: entry.description?.slice(0, MAX_DESCRIPTION_CHARS),
          inputSchema: (isObjectSchema(entry.inputSchema) ? entry.inputSchema : { type: 'object' }) as { type: 'object' }
        }))
      }));
      mcp.setRequestHandler(CallToolRequestSchema, (request, extra) =>
        handleCall(request.params.name, request.params.arguments, AbortSignal.any([signal, extra.signal])));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
    };

    await new Promise<void>((resolve, reject) => {
      httpServer!.once('error', reject);
      httpServer!.listen({ host: '127.0.0.1', port: 0 }, () => resolve());
    });
    if (sessionAbort.signal.aborted) throw new Error('Aborted');
    const port = (httpServer.address() as AddressInfo).port;
    const endpoint: McpProxyEndpoint = {
      name: 'your-bot',
      url: `http://127.0.0.1:${port}${PROXY_PATH}`,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }]
    };
    const toolInfos: McpToolInfo[] = listing.map(({ route, description, inputSchema }) => ({
      serverId: route.serverId, name: route.tool, ...(description ? { description } : {}), inputSchema
    }));
    return {
      endpoint,
      async tools() { return toolInfos.map(info => ({ ...info })); },
      failures() { return failures.map(failure => ({ ...failure })); },
      close
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function connectUpstream(config: McpServerConfig, options: McpBrokerOptions, timeoutMs: number, signal: AbortSignal): Promise<Upstream> {
  // Hosts are expected to call expandPreset(); expand here only a preset that was left unexpanded,
  // so an already expanded config (possibly with host-added args) is used as given.
  const expanded = config.preset && (config.transport !== 'stdio' || !config.command) ? expandPreset(config) : config;
  let transport: Transport;
  if (expanded.transport === 'stdio') {
    if (!expanded.command) throw new Error('Missing command');
    transport = new StdioProcessTransport({
      command: expanded.command, args: expanded.args, env: expanded.env, cwd: expanded.cwd,
      baseEnv: options.baseEnv, killGraceMs: options.killGraceMs
    });
  } else {
    let url: URL;
    try { url = new URL(expanded.url); } catch { throw new Error('Invalid url'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Unsupported url scheme');
    transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: expanded.headers ?? {} } });
  }
  const client = new Client({ name: 'your-bot', version: '0.1.0' }, { capabilities: {} });
  const attempt = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const abortPromise = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error(signal.aborted ? 'Aborted' : `Timed out after ${timeoutMs} ms`));
    if (attempt.aborted) fail(); else attempt.addEventListener('abort', fail, { once: true });
  });
  abortPromise.catch(() => undefined);
  try {
    const work = (async () => {
      await client.connect(transport, { signal: attempt, timeout: timeoutMs });
      const tools: Upstream['tools'] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { signal: attempt, timeout: timeoutMs });
        for (const tool of page.tools) {
          tools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as unknown as JsonValue });
        }
        if (tools.length > MAX_TOOLS_PER_SERVER) throw new Error(`Too many tools (limit ${MAX_TOOLS_PER_SERVER})`);
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    })();
    work.catch(() => undefined);
    const tools = await Promise.race([work, abortPromise]);
    return { config: expanded, client, transport, tools };
  } catch (error) {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    if (transport instanceof StdioProcessTransport && transport.stderr) {
      throw new Error(`${errorMessage(error)} (stderr: ${transport.stderr.trim().slice(-512)})`);
    }
    throw error;
  }
}

function serverIdProblem(id: unknown, seen: Set<string>): string | undefined {
  if (typeof id !== 'string' || !SERVER_ID_PATTERN.test(id) || id.includes('__')) return 'Invalid server id (allowed: [A-Za-z0-9_-], ≤32 chars, no "__")';
  if (id === BUILTIN_SERVER_ID) return `Server id "${BUILTIN_SERVER_ID}" is reserved`;
  if (seen.has(id)) return 'Duplicate server id';
  return undefined;
}

function validateBuiltins(builtins: McpBuiltinTool[]): void {
  const names = new Set<string>();
  for (const builtin of builtins) {
    if (!TOOL_NAME_PATTERN.test(builtin.name) || `${BUILTIN_SERVER_ID}__${builtin.name}`.length > MAX_NAMESPACED_LENGTH) {
      throw new Error(`Invalid builtin tool name: ${builtin.name}`);
    }
    if (names.has(builtin.name)) throw new Error(`Duplicate builtin tool name: ${builtin.name}`);
    names.add(builtin.name);
  }
}

function collectSecrets(servers: McpServerConfig[]): string[] {
  const values: string[] = [];
  for (const server of servers) {
    const map = server.transport === 'stdio' ? server.env : server.headers;
    for (const value of Object.values(map ?? {})) if (typeof value === 'string' && value.length >= 4) values.push(value);
  }
  return values.sort((a, b) => b.length - a.length);
}

function normalizeUpstreamResult(result: Awaited<ReturnType<Client['callTool']>>): CallToolResult {
  const raw = result as Record<string, unknown>;
  if (Array.isArray(raw.content)) {
    return {
      content: raw.content as CallToolResult['content'],
      ...(raw.isError === true ? { isError: true } : {}),
      ...(raw.structuredContent && typeof raw.structuredContent === 'object' ? { structuredContent: raw.structuredContent as Record<string, unknown> } : {})
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify(raw.toolResult ?? null) }] };
}

function boundResult(result: CallToolResult): CallToolResult {
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(result)); } catch { return toolError('Result is not serializable'); }
  return size > MAX_PAYLOAD_BYTES ? toolError('Result too large (limit 1 MiB)') : result;
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function isObjectSchema(value: unknown): value is { type: 'object' } {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'object';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function respond(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  const body = JSON.stringify({ error: message });
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', Connection: 'close' });
  res.end(body);
}

function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) { over = true; chunks.length = 0; return; }
      if (!over) chunks.push(chunk);
    });
    req.once('end', () => resolve(over ? undefined : Buffer.concat(chunks).toString('utf8')));
    req.once('error', reject);
  });
}
