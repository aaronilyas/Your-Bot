import { randomUUID } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import type { CommandResultV2, DesktopCommandV2, DesktopEventV2 } from '@your-bot/contracts';
import { controlEndpoint, prepareSocketPath } from './endpoint.js';
import { tokenEquals } from './token.js';

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_UNAUTHENTICATED = 8;
const AUTH_TIMEOUT_MS = 5_000;

export interface ControlServerOptions {
  dataDir: string;
  /** Secret from `<data>/control.token`. Compared in constant time; never logged. */
  token: string;
  /** Dispatch as the local owner. The frame cannot choose the principal. */
  dispatch(command: DesktopCommandV2): Promise<CommandResultV2>;
  subscribe(listener: (event: DesktopEventV2) => void): () => void;
}

export interface ControlServer {
  readonly endpoint: string;
  close(): Promise<void>;
}

function writeLine(socket: Socket, value: unknown): void {
  if (socket.destroyed || !socket.writable) return;
  socket.write(`${JSON.stringify(value)}\n`);
}

/** Fill version 2 and a command id. A frame that is not a v2 command returns undefined. */
export function commandFromFrame(value: unknown): DesktopCommandV2 | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== 'string' || !record.type || record.type.length > 128) return undefined;
  if (record.version !== undefined && record.version !== 2) return undefined;
  const id = typeof record.id === 'string' && record.id ? record.id : randomUUID();
  return { ...record, version: 2, id } as DesktopCommandV2;
}

function authFrame(value: unknown, token: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 1 && keys[0] === 'token' && tokenEquals(record.token, token);
}

/**
 * Owner control channel. POSIX: `<data>/control.sock` mode 0600. Windows: a named pipe whose
 * name is a hash of the real data directory. The first NDJSON frame must be `{"token":"..."}`.
 * One attempt; a missing or wrong token is refused and the socket is closed before any command
 * is dispatched. Later frames are v2 commands, or `{op:"watch"}` to stream events.
 */
export async function startControlServer(options: ControlServerOptions): Promise<ControlServer> {
  if (!options.token) throw new Error('Control token is required');
  const endpoint = await controlEndpoint(options.dataDir);
  if (process.platform !== 'win32' && Buffer.byteLength(endpoint) >= 104) throw new Error(`Control socket path is too long (${endpoint})`);
  await prepareSocketPath(endpoint);
  const sockets = new Set<Socket>();
  let pendingAuth = 0;
  let closed = false;
  const server: Server = createServer(socket => {
    if (closed || pendingAuth >= MAX_UNAUTHENTICATED) { socket.destroy(); return; }
    pendingAuth += 1;
    let unauthCounted = true;
    const releaseUnauth = () => { if (unauthCounted) { unauthCounted = false; pendingAuth -= 1; } };
    sockets.add(socket);
    let authed = false;
    let rejected = false;
    let buffer = '';
    let queue: Promise<void> = Promise.resolve();
    let unsubscribe: (() => void) | undefined;
    socket.setTimeout(AUTH_TIMEOUT_MS);
    const failAuth = () => {
      if (rejected || authed) return;
      rejected = true;
      const line = `${JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED' } })}\n`;
      if (socket.writable) socket.write(line, () => socket.destroy());
      else socket.destroy();
    };
    const onLine = (line: string) => {
      if (rejected || socket.destroyed) return;
      let parsed: unknown;
      try { parsed = JSON.parse(line); }
      catch {
        if (!authed) failAuth();
        else writeLine(socket, { ok: false, commandId: '', error: { code: 'INVALID_INPUT', message: 'Control frame is not JSON' } });
        return;
      }
      if (!authed) {
        if (!authFrame(parsed, options.token)) { failAuth(); return; }
        authed = true;
        releaseUnauth();
        socket.setTimeout(0);
        writeLine(socket, { ok: true });
        return;
      }
      const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
      if (record && record.op === 'watch' && Object.keys(record).length === 1) {
        unsubscribe?.();
        unsubscribe = options.subscribe(event => writeLine(socket, { event }));
        writeLine(socket, { ok: true, op: 'watch' });
        return;
      }
      const command = commandFromFrame(parsed);
      queue = queue.then(async () => {
        if (socket.destroyed) return;
        if (!command) {
          writeLine(socket, { ok: false, commandId: '', error: { code: 'INVALID_INPUT', message: 'Expected a v2 command' } });
          return;
        }
        try { writeLine(socket, await options.dispatch(command)); }
        catch (error) {
          writeLine(socket, { ok: false, commandId: command.id, error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'dispatch failed' } });
        }
      }).catch(() => undefined);
    };
    socket.on('data', (chunk: Buffer) => {
      if (rejected) return;
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES && !buffer.includes('\n')) { socket.destroy(); return; }
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) { socket.destroy(); return; }
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) { socket.destroy(); return; }
        onLine(line);
        if (rejected || socket.destroyed) return;
      }
    });
    const finished = () => {
      if (!authed) releaseUnauth();
      unsubscribe?.();
      sockets.delete(socket);
    };
    socket.on('timeout', () => { if (!authed) failAuth(); });
    socket.on('error', () => undefined);
    socket.on('close', finished);
  });

  const previous = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { server.off('listening', done); reject(error); };
      const done = () => { server.off('error', fail); resolve(); };
      server.once('error', fail);
      server.listen(endpoint, done);
    });
  } finally {
    process.umask(previous);
  }
  if (process.platform !== 'win32') await chmod(endpoint, 0o600);

  let closing: Promise<void> | undefined;
  return {
    endpoint,
    close: () => closing ??= (async () => {
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (process.platform !== 'win32') await prepareSocketPath(endpoint).catch(() => undefined);
    })(),
  };
}
