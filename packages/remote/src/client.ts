/**
 * Remote client: certificate-pinned TLS WebSocket, pairing, device authentication and a
 * reconnecting, resuming v2 transport.
 */
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { isIP } from 'node:net';
import { createPrivateKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { WebSocket, type ClientOptions, type RawData } from 'ws';
import type {
  AppSnapshotV2, CapabilityV2, CommandResultV2, DesktopCommandV2, DesktopEventV2, PermissionRequestV2, Unsubscribe,
} from '@your-bot/contracts';
import { certificateFingerprint, normalizeFingerprint } from './certificate.js';
import { CLOSE, MAX_FRAME_BYTES, PERMANENT_CLOSE_CODES, PROTOCOL, authMessage, decodePairingCode, type ClientFrame, type ServerFrame } from './protocol.js';

/** v2 counterpart of the v1 `BackendTransport` (contract request: add to contracts). */
export interface BackendTransportV2 {
  dispatch(command: DesktopCommandV2): Promise<CommandResultV2>;
  subscribe(listener: (event: DesktopEventV2) => void): Unsubscribe;
  close?(): Promise<void>;
}

export class RemoteError extends Error {
  constructor(readonly code: string, message: string, readonly closeCode?: number) { super(message); this.name = 'RemoteError'; }
  /** True when retrying cannot succeed (bad credentials, revoked, wrong pin, protocol violation). */
  get permanent(): boolean {
    return this.code === 'FINGERPRINT_MISMATCH' || this.code === 'HOST_MISMATCH' || (this.closeCode !== undefined && PERMANENT_CLOSE_CODES.has(this.closeCode));
  }
}
const closeError = (code: number, reason: string): RemoteError => {
  const name = code === CLOSE.revoked ? 'REVOKED' : code === CLOSE.authFailed ? 'UNAUTHORIZED' : code === CLOSE.authTimeout ? 'AUTH_TIMEOUT'
    : code === CLOSE.tooManyConnections ? 'TOO_MANY_CONNECTIONS' : code === CLOSE.protocol ? 'PROTOCOL_ERROR' : 'DISCONNECTED';
  return new RemoteError(name, reason || `Connection closed (${code})`, code);
};

/** Opens TLS and verifies the pinned certificate fingerprint before any application byte is sent. */
export function connectPinned(url: string, fingerprint: string, timeoutMs = 10_000): Promise<TLSSocket> {
  const pinned = normalizeFingerprint(fingerprint);
  const target = new URL(url);
  if (target.protocol !== 'wss:') return Promise.reject(new RemoteError('INSECURE_URL', 'Only wss:// URLs are supported'));
  const host = target.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host, port: Number(target.port || 443), minVersion: 'TLSv1.3',
      ...(isIP(host) ? {} : { servername: host }),
      // Chain validation is replaced by fingerprint pinning, checked below before use.
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => { socket.destroy(); reject(new RemoteError('CONNECT_TIMEOUT', `Timed out connecting to ${target.host}`)); }, timeoutMs);
    socket.once('error', error => { clearTimeout(timer); reject(new RemoteError('CONNECT_FAILED', error.message)); });
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const certificate = socket.getPeerX509Certificate();
      const actual = certificate ? certificateFingerprint(certificate.raw) : '';
      if (actual !== pinned) { socket.destroy(); return reject(new RemoteError('FINGERPRINT_MISMATCH', 'Host certificate does not match the pinned fingerprint')); }
      resolve(socket);
    });
  });
}

/** A framed protocol link over one pinned WebSocket. */
export class Link {
  private queue: ServerFrame[] = [];
  private waiters: { resolve(frame: ServerFrame): void; reject(error: Error): void }[] = [];
  private handler?: (frame: ServerFrame) => void;
  private closeHandlers: ((error: RemoteError) => void)[] = [];
  closed?: RemoteError;
  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return this.close(CLOSE.protocol);
      let frame: ServerFrame;
      try { frame = JSON.parse(data.toString()) as ServerFrame; } catch { return this.close(CLOSE.protocol); }
      if (!frame || typeof frame !== 'object' || typeof frame.t !== 'string') return this.close(CLOSE.protocol);
      if (this.handler) this.handler(frame);
      else { const waiter = this.waiters.shift(); if (waiter) waiter.resolve(frame); else this.queue.push(frame); }
    });
    ws.on('error', () => { /* surfaced through close */ });
    ws.on('close', (code: number, reason: Buffer) => {
      this.closed ??= closeError(code, reason.toString());
      for (const waiter of this.waiters.splice(0)) waiter.reject(this.closed);
      for (const handler of this.closeHandlers.splice(0)) handler(this.closed);
    });
  }
  static async open(url: string, fingerprint: string, timeoutMs = 10_000): Promise<Link> {
    const socket = await connectPinned(url, fingerprint, timeoutMs);
    const options: ClientOptions = {
      perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES, handshakeTimeout: timeoutMs, followRedirects: false,
      createConnection: (() => socket) as unknown as ClientOptions['createConnection'],
    };
    const ws = new WebSocket(url, options);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', error => reject(new RemoteError('CONNECT_FAILED', error.message)));
      ws.once('close', (code: number, reason: Buffer) => reject(closeError(code, reason.toString())));
    });
    return new Link(ws);
  }
  next(timeoutMs = 10_000): Promise<ServerFrame> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.close(CLOSE.normal); reject(new RemoteError('TIMEOUT', 'Timed out waiting for the host')); }, timeoutMs);
      this.waiters.push({ resolve: f => { clearTimeout(timer); resolve(f); }, reject: e => { clearTimeout(timer); reject(e); } });
    });
  }
  /** Switches from pull (`next`) to push delivery, draining anything queued. */
  onFrame(handler: (frame: ServerFrame) => void): void {
    this.handler = handler;
    for (const frame of this.queue.splice(0)) handler(frame);
  }
  onClose(handler: (error: RemoteError) => void): void {
    if (this.closed) handler(this.closed); else this.closeHandlers.push(handler);
  }
  send(frame: ClientFrame): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame)); return true;
  }
  close(code: number = CLOSE.normal): void {
    try { this.ws.close(code); } catch { /* ignore */ }
    setTimeout(() => this.ws.terminate(), 1000).unref();
  }
}

const expectChallenge = async (link: Link, fingerprint: string, hostId: string | undefined, timeoutMs: number) => {
  const frame = await link.next(timeoutMs);
  if (frame.t !== 'challenge' || frame.protocol !== PROTOCOL || typeof frame.nonce !== 'string' || typeof frame.hostId !== 'string') {
    link.close(CLOSE.protocol); throw new RemoteError('PROTOCOL_ERROR', 'Unexpected host greeting');
  }
  if (frame.fp !== normalizeFingerprint(fingerprint)) { link.close(CLOSE.protocol); throw new RemoteError('FINGERPRINT_MISMATCH', 'Host announced a different fingerprint'); }
  if (hostId !== undefined && frame.hostId !== hostId) { link.close(CLOSE.protocol); throw new RemoteError('HOST_MISMATCH', 'Connected to a different host'); }
  return frame;
};

export interface DeviceCredentials {
  hostId: string;
  deviceId: string;
  fingerprint: string;
  urls: string[];
  privateKey: KeyObject;
}
export interface PairedHost {
  hostId: string; hostName: string; deviceId: string; deviceName: string; urls: string[]; fingerprint: string;
  capabilities: CapabilityV2[]; pairedAt: string;
  /** PKCS#8 PEM of the device's Ed25519 private key. */
  privateKeyPem: string;
}

/** Redeems a single-use pairing code. Tries the code's URLs in order until one is reachable. */
export async function pairWithCode(code: string, options: { name: string; timeoutMs?: number }): Promise<PairedHost> {
  const payload = decodePairingCode(code);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64url');
  let lastError: Error = new RemoteError('CONNECT_FAILED', 'No pairing URL was reachable');
  for (const url of payload.urls) {
    let link: Link;
    try { link = await Link.open(url, payload.fp, timeoutMs); }
    catch (error) {
      if (error instanceof RemoteError && error.code === 'FINGERPRINT_MISMATCH') throw error;
      lastError = error as Error; continue;
    }
    try {
      await expectChallenge(link, payload.fp, undefined, timeoutMs);
      link.send({ t: 'pair', secret: payload.secret, name: options.name, publicKey: spki });
      const frame = await link.next(timeoutMs).catch((error: RemoteError) => {
        throw error.code === 'UNAUTHORIZED' ? new RemoteError('PAIRING_REFUSED', 'The pairing code was refused (expired, already used, or throttled)', error.closeCode) : error;
      });
      if (frame.t !== 'paired') throw new RemoteError('PROTOCOL_ERROR', 'Unexpected pairing response');
      return {
        hostId: frame.hostId, hostName: frame.hostName, deviceId: frame.deviceId, deviceName: options.name, urls: payload.urls,
        fingerprint: payload.fp, capabilities: frame.capabilities, pairedAt: new Date().toISOString(),
        privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      };
    } finally { link.close(); }
  }
  throw lastError;
}

export interface ReadyInfo { hostId: string; hostName: string; deviceId: string; principalId: string; capabilities: CapabilityV2[]; }
/** Opens an authenticated link: pinned TLS, challenge, Ed25519 signature, `ready`. */
export async function connectDevice(credentials: DeviceCredentials, timeoutMs = 10_000): Promise<{ link: Link; ready: ReadyInfo }> {
  let lastError: Error = new RemoteError('CONNECT_FAILED', 'No host URL was reachable');
  for (const url of credentials.urls) {
    let link: Link;
    try { link = await Link.open(url, credentials.fingerprint, timeoutMs); }
    catch (error) {
      if (error instanceof RemoteError && error.permanent) throw error;
      lastError = error as Error; continue;
    }
    try {
      const challenge = await expectChallenge(link, credentials.fingerprint, credentials.hostId, timeoutMs);
      // Sign with the pinned fingerprint and expected host id, never server-claimed values.
      const message = authMessage(credentials.hostId, normalizeFingerprint(credentials.fingerprint), challenge.nonce);
      link.send({ t: 'auth', deviceId: credentials.deviceId, signature: sign(null, message, credentials.privateKey).toString('base64url') });
      const frame = await link.next(timeoutMs);
      if (frame.t !== 'ready' || frame.hostId !== credentials.hostId) { link.close(CLOSE.protocol); throw new RemoteError('PROTOCOL_ERROR', 'Unexpected authentication response'); }
      return { link, ready: { hostId: frame.hostId, hostName: frame.hostName, deviceId: frame.deviceId, principalId: frame.principalId, capabilities: frame.capabilities } };
    } catch (error) {
      link.close();
      if (error instanceof RemoteError && error.permanent) throw error;
      lastError = error as Error;
    }
  }
  throw lastError;
}

export type TransportStatus = 'idle' | 'connecting' | 'syncing' | 'ready' | 'disconnected' | 'unauthorized' | 'revoked' | 'failed' | 'closed';
export interface RemoteTransportOptions {
  credentials: DeviceCredentials;
  /** Reconnect after unexpected disconnects (default true). Permanent failures never reconnect. */
  autoReconnect?: boolean;
  backoff?: { initialMs?: number; maxMs?: number };
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  /** Resume cursor from a previous session (events after it are replayed). */
  afterSequence?: number;
}

/**
 * v2 backend transport to one paired host. Subscribes on connect, then resumes with
 * `state.sync {afterSequence}`; listeners see each event sequence exactly once.
 */
export class RemoteTransport implements BackendTransportV2 {
  status: TransportStatus = 'idle';
  snapshot?: AppSnapshotV2;
  ready?: ReadyInfo;
  lastError?: RemoteError;
  private cursor?: number;
  private seen = new Set<number>();
  private link?: Link;
  private listeners = new Set<(event: DesktopEventV2) => void>();
  private statusListeners = new Set<(status: TransportStatus) => void>();
  private pending = new Map<string, { resolve(result: CommandResultV2): void; timer: NodeJS.Timeout }>();
  private running?: Promise<void>;
  private wake?: () => void;
  private closed = false;
  private readyWaiters: { resolve(): void; reject(error: Error): void }[] = [];
  constructor(private readonly options: RemoteTransportOptions) { this.cursor = options.afterSequence; }

  get hostId(): string { return this.options.credentials.hostId; }
  /** Highest event sequence this client has fully observed (persist to resume later). */
  get lastSequence(): number | undefined { return this.cursor; }

  /** Starts the connection loop and resolves once authenticated and synchronized. Rejects on the first failed attempt (the loop keeps retrying unless the failure is permanent). */
  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new RemoteError('CLOSED', 'Transport is closed'));
    if (this.status === 'ready') return Promise.resolve();
    const waiter = new Promise<void>((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
    this.running ??= this.loop();
    return waiter;
  }
  onStatus(listener: (status: TransportStatus) => void): Unsubscribe { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener); }
  subscribe(listener: (event: DesktopEventV2) => void): Unsubscribe { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  async dispatch(command: DesktopCommandV2): Promise<CommandResultV2> {
    const commandId = typeof command?.id === 'string' ? command.id : 'invalid';
    if (command?.version !== 2) return { ok: false, commandId, error: { code: 'UNSUPPORTED_VERSION', message: 'RemoteTransport sends contract v2 commands only' } };
    if (this.status !== 'ready') return { ok: false, commandId, error: { code: 'DISCONNECTED', message: `Host is ${this.status}`, retryable: true } };
    return this.request(command);
  }

  private request(command: DesktopCommandV2): Promise<CommandResultV2> {
    const link = this.link;
    if (!link || this.pending.has(command.id)) return Promise.resolve({ ok: false, commandId: command.id, error: { code: link ? 'DUPLICATE_COMMAND' : 'DISCONNECTED', message: 'Command cannot be sent', retryable: !link } });
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(command.id); resolve({ ok: false, commandId: command.id, error: { code: 'TIMEOUT', message: 'The host did not answer in time', retryable: true } }); }, this.options.commandTimeoutMs ?? 60_000);
      this.pending.set(command.id, { resolve, timer });
      if (!link.send({ t: 'command', command })) { clearTimeout(timer); this.pending.delete(command.id); resolve({ ok: false, commandId: command.id, error: { code: 'DISCONNECTED', message: 'Not connected', retryable: true } }); }
    });
  }

  private setStatus(status: TransportStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) { try { listener(status); } catch { /* isolate */ } }
  }

  private deliver(event: DesktopEventV2): void {
    if (typeof event?.sequence !== 'number') return;
    if (this.cursor !== undefined && event.sequence <= this.cursor) return;
    if (this.seen.has(event.sequence)) return;
    this.seen.add(event.sequence);
    if (this.status === 'ready') {
      this.cursor = Math.max(this.cursor ?? 0, event.sequence);
      if (this.seen.size > 1024) for (const s of this.seen) if (s <= this.cursor) this.seen.delete(s);
    }
    this.applyToSnapshot(event);
    for (const listener of this.listeners) { try { listener(event); } catch { /* isolate */ } }
  }
  private applyToSnapshot(event: DesktopEventV2): void {
    if (event.type === 'state.snapshot') { this.snapshot = event.snapshot; return; }
    if (!this.snapshot) return;
    if (event.type === 'permission.requested') {
      const request = event.request as PermissionRequestV2;
      this.snapshot = { ...this.snapshot, pendingPermissions: [...this.snapshot.pendingPermissions.filter(r => r.id !== request.id), request] };
    } else if (event.type === 'permission.resolved') {
      this.snapshot = { ...this.snapshot, pendingPermissions: this.snapshot.pendingPermissions.filter(r => r.id !== event.requestId) };
    }
  }

  private async session(): Promise<Link> {
    this.setStatus('connecting');
    const { link, ready } = await connectDevice(this.options.credentials, this.options.connectTimeoutMs);
    this.link = link; this.ready = ready;
    link.onFrame(frame => {
      if (frame.t === 'event') this.deliver(frame.event);
      else if (frame.t === 'result') {
        const entry = this.pending.get(frame.id);
        if (entry) { clearTimeout(entry.timer); this.pending.delete(frame.id); entry.resolve(frame.result); }
      }
    });
    link.onClose(() => {
      if (this.link === link) this.link = undefined;
      for (const [id, entry] of this.pending) { clearTimeout(entry.timer); entry.resolve({ ok: false, commandId: id, error: { code: 'DISCONNECTED', message: 'Connection lost', retryable: true } }); }
      this.pending.clear();
    });
    // The server subscribed before `ready`; now replay anything missed since the cursor.
    this.setStatus('syncing');
    const sync = (afterSequence?: number) => this.request({ version: 2, id: randomUUID(), type: 'state.sync', ...(afterSequence !== undefined ? { afterSequence } : {}) });
    let result = await sync(this.cursor);
    if (!result.ok && result.error.code === 'INVALID_CURSOR') { this.cursor = undefined; this.seen.clear(); result = await sync(); }
    if (!result.ok) { link.close(); throw new RemoteError(result.error.code, result.error.message); }
    if (result.snapshot) this.snapshot = result.snapshot;
    const highest = Math.max(this.cursor ?? 0, result.snapshot?.lastSequence ?? 0, ...this.seen);
    this.cursor = highest;
    for (const s of this.seen) if (s <= highest) this.seen.delete(s);
    this.setStatus('ready');
    return link;
  }

  private async loop(): Promise<void> {
    const initial = this.options.backoff?.initialMs ?? 500, max = this.options.backoff?.maxMs ?? 30_000;
    let attempt = 0;
    while (!this.closed) {
      try {
        const link = await this.session();
        attempt = 0;
        for (const waiter of this.readyWaiters.splice(0)) waiter.resolve();
        const error = await new Promise<RemoteError>(resolve => link.onClose(resolve));
        if (this.closed) break;
        this.lastError = error;
        if (error.permanent) { this.setStatus(error.code === 'REVOKED' ? 'revoked' : error.code === 'UNAUTHORIZED' ? 'unauthorized' : 'failed'); break; }
        this.setStatus('disconnected');
      } catch (caught) {
        const error = caught instanceof RemoteError ? caught : new RemoteError('CONNECT_FAILED', (caught as Error).message);
        this.lastError = error;
        for (const waiter of this.readyWaiters.splice(0)) waiter.reject(error);
        if (this.closed) break;
        if (error.permanent) { this.setStatus(error.code === 'REVOKED' ? 'revoked' : error.code === 'UNAUTHORIZED' ? 'unauthorized' : 'failed'); break; }
        this.setStatus('disconnected');
      }
      if (this.options.autoReconnect === false) break;
      const delay = Math.min(max, initial * 2 ** attempt) * (0.5 + Math.random() * 0.5);
      attempt += 1;
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, delay); this.wake = () => { clearTimeout(timer); resolve(); }; });
      this.wake = undefined;
    }
    this.running = undefined;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.wake?.();
    this.link?.close();
    for (const waiter of this.readyWaiters.splice(0)) waiter.reject(new RemoteError('CLOSED', 'Transport closed'));
    this.setStatus('closed');
  }
}

/** Builds credentials from a PEM private key. */
export function credentialsFrom(host: { hostId: string; deviceId: string; fingerprint: string; urls: string[] }, privateKeyPem: string): DeviceCredentials {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Device key must be Ed25519');
  return { hostId: host.hostId, deviceId: host.deviceId, fingerprint: normalizeFingerprint(host.fingerprint), urls: [...host.urls], privateKey };
}
