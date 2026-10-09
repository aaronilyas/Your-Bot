import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AdapterError, record } from './errors.js';

type RpcId = string | number;
interface Pending { resolve(value: unknown): void; reject(error: AdapterError): void; }

/** ACP v1 newline-delimited JSON-RPC, with independent response/request routing. */
export class StdioRpc {
  private sequence = 0;
  private readonly pending = new Map<RpcId, Pending>();
  private readonly incoming = new Set<RpcId>();
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private buffer = '';
  private bytes = 0;
  private failure?: AdapterError;
  private disposed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly maxMessageBytes: number,
    private readonly maxStreamBytes: number,
    private readonly onNotification: (method: string, params: unknown) => void,
    private readonly onRequest: (method: string, params: unknown) => Promise<unknown>,
    private readonly onFailure: (error: AdapterError) => void,
  ) {
    child.stdout.on('data', this.onData);
    child.stdout.on('end', this.onEnd);
    child.stdout.on('error', this.onError);
    child.stdin.on('error', this.onError);
    child.on('error', this.onError);
    child.on('exit', this.onExit);
    // Drain stderr so a harness cannot deadlock. Never retain, emit or log it.
    child.stderr.on('data', this.onStderr);
    child.stderr.on('error', this.onError);
  }

  private readonly onStderr = (chunk: Buffer) => {
    this.bytes += chunk.byteLength;
    if (this.bytes > this.maxStreamBytes) this.fail(new AdapterError('RESPONSE_LIMIT', 'Harness output exceeded the size limit.'));
  };
  private readonly onError = () => this.fail(new AdapterError('HARNESS_IO', 'Contained harness transport failed.', true));
  private readonly onExit = () => this.fail(new AdapterError('HARNESS_EXIT', 'Contained harness exited unexpectedly.', true));
  private readonly onEnd = () => {
    if (this.buffer.trim()) this.fail(new AdapterError('INVALID_RESPONSE', 'Harness ended inside a JSON-RPC message.'));
    else this.fail(new AdapterError('HARNESS_EXIT', 'Contained harness closed its output.', true));
  };
  private readonly onData = (chunk: Buffer) => {
    if (this.failure || this.disposed) return;
    this.bytes += chunk.byteLength;
    if (this.bytes > this.maxStreamBytes) { this.fail(new AdapterError('RESPONSE_LIMIT', 'Harness output exceeded the size limit.')); return; }
    try {
      this.buffer += this.decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > this.maxMessageBytes) throw new AdapterError('RESPONSE_LIMIT', 'Harness message exceeded the size limit.');
        if (line.trim()) this.receive(JSON.parse(line) as unknown);
        if (this.failure || this.disposed) return;
      }
      if (Buffer.byteLength(this.buffer) > this.maxMessageBytes) throw new AdapterError('RESPONSE_LIMIT', 'Harness message exceeded the size limit.');
    } catch (error) { this.fail(error instanceof AdapterError ? error : new AdapterError('INVALID_RESPONSE', 'Harness returned invalid JSON-RPC.')); }
  };

  private receive(raw: unknown): void {
    const message = record(raw);
    if (message.jsonrpc !== '2.0') throw new AdapterError('INVALID_RESPONSE', 'Harness returned invalid JSON-RPC.');
    const id = message.id;
    if (id !== undefined && (typeof id !== 'string' && (typeof id !== 'number' || !Number.isSafeInteger(id)))) throw new AdapterError('INVALID_RESPONSE', 'Harness returned an invalid RPC ID.');
    if (typeof message.method === 'string') {
      if (id === undefined) { this.onNotification(message.method, message.params); return; }
      if (this.incoming.has(id as RpcId) || this.incoming.size >= 32) throw new AdapterError('RPC_LIMIT', 'Harness exceeded the pending request limit.');
      this.incoming.add(id as RpcId);
      void this.onRequest(message.method, message.params).then(
        result => this.reply(id as RpcId, { result }),
        error => this.reply(id as RpcId, { error: {
          code: error instanceof MethodNotFound ? -32601 : error instanceof InvalidParams ? -32602 : -32603,
          message: error instanceof MethodNotFound ? 'Method not supported' : error instanceof InvalidParams ? 'Invalid parameters' : 'Client request failed',
        } }),
      ).finally(() => this.incoming.delete(id as RpcId));
      return;
    }
    if (id === undefined || (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))) throw new AdapterError('INVALID_RESPONSE', 'Harness returned an invalid RPC response.');
    const pending = this.pending.get(id as RpcId);
    if (!pending) throw new AdapterError('INVALID_RESPONSE', 'Harness returned an unknown RPC response.');
    this.pending.delete(id as RpcId);
    if (message.error !== undefined) pending.reject(new AdapterError('ACP_RPC_ERROR', 'Harness rejected an ACP request.'));
    else pending.resolve(message.result);
  }

  private reply(id: RpcId, response: object): void {
    if (this.failure || this.disposed) return;
    try { this.write({ jsonrpc: '2.0', id, ...response }); } catch { /* write has failed the connection */ }
  }

  private write(value: object): void {
    if (this.failure) throw this.failure;
    if (this.disposed) throw new AdapterError('CLOSED', 'Harness connection is closed.');
    const serialized = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(serialized) > this.maxMessageBytes) throw new AdapterError('REQUEST_LIMIT', 'Harness request exceeded the size limit.');
    if (!this.child.stdin.writable || this.child.stdin.writableLength > this.maxMessageBytes * 2) {
      const error = new AdapterError('HARNESS_IO', 'Harness input is unavailable.', true);
      this.fail(error);
      throw error;
    }
    try { this.child.stdin.write(serialized); }
    catch { this.onError(); throw this.failure; }
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.pending.size >= 32) return Promise.reject(new AdapterError('RPC_LIMIT', 'Client exceeded the pending request limit.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.write({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  notify(method: string, params: unknown): void { this.write({ jsonrpc: '2.0', method, params }); }

  private fail(error: AdapterError): void {
    if (this.failure || this.disposed) return;
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.onFailure(error);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pending.values()) pending.reject(new AdapterError('CLOSED', 'Harness connection is closed.'));
    this.pending.clear();
    this.child.stdout.off('data', this.onData);
    this.child.stdout.off('end', this.onEnd);
    this.child.stdout.off('error', this.onError);
    this.child.stdin.off('error', this.onError);
    this.child.off('error', this.onError);
    this.child.off('exit', this.onExit);
    this.child.stderr.off('data', this.onStderr);
    this.child.stderr.off('error', this.onError);
  }
}

export class MethodNotFound extends Error {}
export class InvalidParams extends Error {}
