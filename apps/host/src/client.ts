import { connect, type Socket } from 'node:net';

export class ControlClientError extends Error {
  constructor(message: string) { super(message); this.name = 'ControlClientError'; }
}

export interface ControlConnection {
  call(command: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Stream events until the socket closes or `signal` aborts. */
  watch(onEvent: (event: unknown) => void, signal?: AbortSignal): Promise<void>;
  close(): void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Connect, send the owner token as the first frame, and resolve once the host accepts it. */
export function connectControl(endpoint: string, token: string, timeoutMs = 5_000): Promise<ControlConnection> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(endpoint);
    let settled = false;
    let buffer = '';
    let authed = false;
    const waiters: { resolve(value: Record<string, unknown>): void; reject(error: Error): void }[] = [];
    const events = new Set<(event: unknown) => void>();
    const timer = setTimeout(() => fail(new ControlClientError('Control connection timed out')), timeoutMs);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      for (const waiter of waiters.splice(0)) waiter.reject(error);
      reject(error);
    };
    const handle = (line: string) => {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { return; }
      const record = asRecord(parsed) ?? {};
      if (!authed) {
        authed = true;
        clearTimeout(timer);
        if (record.ok !== true) {
          const code = asRecord(record.error)?.code;
          fail(new ControlClientError(typeof code === 'string' ? code : 'UNAUTHORIZED'));
          return;
        }
        settled = true;
        resolve(api);
        return;
      }
      if ('event' in record) {
        for (const listener of events) listener(record.event);
        return;
      }
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(record);
    };
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line.trim()) handle(line);
      }
    });
    socket.on('error', error => { if (!settled) fail(error); });
    socket.on('close', () => {
      const error = new ControlClientError('Control connection closed');
      for (const waiter of waiters.splice(0)) waiter.reject(error);
      if (!settled) fail(error);
    });
    socket.on('connect', () => { socket.write(`${JSON.stringify({ token })}\n`); });
    const api: ControlConnection = {
      call(command) {
        return new Promise((resolveCall, rejectCall) => {
          if (socket.destroyed) { rejectCall(new ControlClientError('Control connection closed')); return; }
          waiters.push({ resolve: resolveCall, reject: rejectCall });
          socket.write(`${JSON.stringify(command)}\n`);
        });
      },
      watch(onEvent, signal) {
        events.add(onEvent);
        const ack = new Promise<void>((resolveAck, rejectAck) => {
          waiters.push({
            resolve: record => { if (record.ok === true) resolveAck(); else rejectAck(new ControlClientError('watch was refused')); },
            reject: rejectAck,
          });
        });
        socket.write(`${JSON.stringify({ op: 'watch' })}\n`);
        return new Promise((resolveWatch, rejectWatch) => {
          let done = false;
          const finish = () => { if (done) return; done = true; events.delete(onEvent); resolveWatch(); };
          const abort = () => { socket.end(); };
          ack.then(() => {
            if (signal?.aborted) abort();
            else signal?.addEventListener('abort', abort, { once: true });
          }, rejectWatch);
          socket.on('close', finish);
        });
      },
      close() { socket.destroy(); },
    };
  });
}
