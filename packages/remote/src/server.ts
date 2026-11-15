/**
 * Remote host: TLS-only WebSocket transport in front of an injected DesktopGatewayV2.
 * Identity is derived here from a paired Ed25519 device key; frames never select a principal.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type {
  AnyCommandResult, CapabilityV2, CommandResultV2, DesktopEventV2, DesktopGatewayV2, DeviceInfo, DeviceManager, PairingOffer, PrincipalV2, Principal,
} from '@your-bot/contracts';
import { loadOrCreateTlsIdentity, privateDirectory } from './certificate.js';
import { ALL_CAPABILITIES_V2, CLOSE, DEFAULT_DEVICE_CAPABILITIES, MAX_FRAME_BYTES, PROTOCOL, WS_PATH, encodePairingCode, parseDevicePublicKey, verifyAuth, type ServerFrame } from './protocol.js';
import { DeviceStore, hashSecret, type DeviceRecord } from './store.js';
import { parseFrame, parseRemoteCommand, redactEvent, redactResult } from './validation.js';

export interface RemoteHostLimits {
  /** Unauthenticated sockets are closed after this long (default 10 s). */
  authTimeoutMs: number;
  /** Live authenticated sockets per device (default 4). */
  maxConnectionsPerDevice: number;
  /** Concurrent sockets that have not authenticated yet (default 32). */
  maxUnauthenticated: number;
  /** Total TCP connections accepted by the TLS server (default 256). */
  maxConnections: number;
  /** Token bucket per connection: burst size and refill per second (defaults 30 / 10). */
  commandBurst: number;
  commandsPerSecond: number;
  /** Concurrent in-flight commands per connection (default 32). */
  maxPendingCommands: number;
  /** Failed pairing attempts allowed per window before all pairing is refused for the window (default 5 / 60 s). */
  pairingFailures: number;
  pairingWindowMs: number;
  /** Pairing offer lifetime (default 10 min). */
  pairingTtlMs: number;
  /** Outbound buffer above which a slow consumer is disconnected (default 8 MiB). */
  maxBufferedBytes: number;
  /** WebSocket ping interval; sockets missing one pong are terminated (default 30 s). */
  heartbeatMs: number;
}
export const DEFAULT_LIMITS: RemoteHostLimits = {
  authTimeoutMs: 10_000, maxConnectionsPerDevice: 4, maxUnauthenticated: 32, maxConnections: 256,
  commandBurst: 30, commandsPerSecond: 10, maxPendingCommands: 32, pairingFailures: 5, pairingWindowMs: 60_000,
  pairingTtlMs: 10 * 60_000, maxBufferedBytes: 8 * 1024 * 1024, heartbeatMs: 30_000,
};

export interface RemoteHostOptions {
  gateway: DesktopGatewayV2;
  /** Local owner principal id; paired devices act on this owner's data. */
  ownerId: string;
  /** Owner-only directory holding tls/ and devices.sqlite. */
  dataDir: string;
  listen: { host: string; port: number };
  hostName: string;
  now?: () => Date;
  /** URLs placed in pairing codes. Default: derived from the listen address. */
  advertiseUrls?: string[];
  limits?: Partial<RemoteHostLimits>;
}
export interface RemoteHost {
  readonly deviceManager: DeviceManager;
  readonly address: { host: string; port: number; urls: string[] };
  /** Lowercase hex SHA-256 of the certificate DER. */
  readonly fingerprint: string;
  readonly hostId: string;
  close(): Promise<void>;
}

interface Connection {
  ws: WebSocket;
  nonce: string;
  state: 'challenge' | 'ready' | 'closing';
  alive: boolean;
  timer?: NodeJS.Timeout;
  device?: DeviceRecord;
  principal?: PrincipalV2;
  unsubscribe?: () => void;
  tokens: number;
  refilledAt: number;
  pending: number;
}

const cleanName = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 128);
  return name || undefined;
};
const formatHost = (host: string) => host.includes(':') ? `[${host}]` : host;

export async function createRemoteHost(options: RemoteHostOptions): Promise<RemoteHost> {
  const { gateway, hostName } = options;
  if (typeof options.ownerId !== 'string' || !options.ownerId || options.ownerId.startsWith('device:')) throw new Error('ownerId must be the local owner principal id');
  const ownerId = options.ownerId;
  const now = options.now ?? (() => new Date());
  const limits: RemoteHostLimits = { ...DEFAULT_LIMITS, ...options.limits };
  privateDirectory(options.dataDir);
  const tls = loadOrCreateTlsIdentity(join(options.dataDir, 'tls'), `Your Bot ${hostName}`.slice(0, 64));
  const store = new DeviceStore(join(options.dataDir, 'devices.sqlite'));
  const hostId = store.hostId;
  const fingerprint = tls.fingerprint;
  const connections = new Set<Connection>();
  let pairingFailures: number[] = [];
  let closed = false;

  const server: Server = createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.3', handshakeTimeout: limits.authTimeoutMs }, (_request, response) => {
    // Plain HTTPS requests get nothing but an upgrade requirement.
    response.writeHead(426, { Connection: 'close', 'Content-Length': '0' }); response.end();
  });
  server.maxConnections = limits.maxConnections;
  server.headersTimeout = limits.authTimeoutMs; server.requestTimeout = limits.authTimeoutMs;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false, clientTracking: false });
  const reject = (socket: Duplex, status: string) => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); socket.destroy(); };
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (closed) return reject(socket, '503 Service Unavailable');
    const path = (request.url ?? '').split('?')[0];
    if (path !== WS_PATH) return reject(socket, '404 Not Found');
    // No browser clients: a cross-origin page must not even reach the challenge.
    if (request.headers.origin !== undefined) return reject(socket, '403 Forbidden');
    const unauthenticated = [...connections].filter(c => c.state === 'challenge').length;
    if (unauthenticated >= limits.maxUnauthenticated) return reject(socket, '503 Service Unavailable');
    wss.handleUpgrade(request, socket, head, ws => accept(ws));
  });
  server.on('clientError', (_error, socket) => socket.destroy());

  const send = (connection: Connection, frame: ServerFrame): void => {
    if (connection.ws.readyState !== WebSocket.OPEN) return;
    if (connection.ws.bufferedAmount > limits.maxBufferedBytes) { drop(connection, CLOSE.slowConsumer, 'slow consumer'); return; }
    connection.ws.send(JSON.stringify(frame));
  };
  const drop = (connection: Connection, code: number, reason = ''): void => {
    if (connection.state !== 'closing') {
      connection.state = 'closing';
      clearTimeout(connection.timer);
      connection.unsubscribe?.(); connection.unsubscribe = undefined;
    }
    try { connection.ws.close(code, reason); } catch { /* already closing */ }
    // Do not wait for a peer's closing handshake.
    setTimeout(() => connection.ws.terminate(), 1000).unref();
  };

  const accept = (ws: WebSocket): void => {
    const connection: Connection = {
      ws, nonce: randomBytes(32).toString('base64url'), state: 'challenge', alive: true,
      tokens: limits.commandBurst, refilledAt: Date.now(), pending: 0,
    };
    connections.add(connection);
    connection.timer = setTimeout(() => drop(connection, CLOSE.authTimeout), limits.authTimeoutMs);
    ws.on('pong', () => { connection.alive = true; });
    ws.on('error', () => drop(connection, CLOSE.protocol));
    ws.on('close', () => {
      if (connection.state !== 'closing') { connection.state = 'closing'; clearTimeout(connection.timer); connection.unsubscribe?.(); }
      connections.delete(connection);
      if (connection.device && !closed) store.touch(connection.device.id, now().toISOString());
    });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (connection.state === 'closing') return;
      if (isBinary) return drop(connection, CLOSE.protocol);
      let frame: Record<string, unknown>;
      try { frame = parseFrame(data.toString()); } catch { return drop(connection, CLOSE.protocol); }
      if (connection.state === 'challenge') {
        clearTimeout(connection.timer);
        if (frame.t === 'pair') return pair(connection, frame);
        if (frame.t === 'auth') return authenticate(connection, frame);
        return drop(connection, CLOSE.protocol);
      }
      if (frame.t === 'command') return command(connection, frame.command);
      return drop(connection, CLOSE.protocol);
    });
    send(connection, { t: 'challenge', protocol: PROTOCOL, hostId, fp: fingerprint, nonce: connection.nonce });
  };

  const pair = (connection: Connection, frame: Record<string, unknown>): void => {
    const at = now();
    pairingFailures = pairingFailures.filter(t => at.getTime() - t < limits.pairingWindowMs);
    const fail = () => { pairingFailures.push(at.getTime()); drop(connection, CLOSE.authFailed, 'pairing refused'); };
    if (pairingFailures.length >= limits.pairingFailures) return drop(connection, CLOSE.authFailed, 'pairing refused');
    if (typeof frame.secret !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(frame.secret) || typeof frame.publicKey !== 'string') return fail();
    try { parseDevicePublicKey(frame.publicKey); } catch { return fail(); }
    const offer = store.consumePairing(hashSecret(frame.secret), at);
    if (!offer) return fail();
    let device: DeviceRecord;
    try {
      device = store.addDevice({ name: offer.name ?? cleanName(frame.name) ?? 'Device', publicKey: frame.publicKey, capabilities: offer.capabilities, pairedAt: at.toISOString() });
    } catch { return fail(); }
    send(connection, { t: 'paired', deviceId: device.id, hostId, hostName, capabilities: device.capabilities });
    drop(connection, CLOSE.normal, 'paired');
  };

  const authenticate = (connection: Connection, frame: Record<string, unknown>): void => {
    if (typeof frame.deviceId !== 'string' || typeof frame.signature !== 'string' || frame.deviceId.length > 64 || frame.signature.length > 128) return drop(connection, CLOSE.authFailed);
    const device = store.getDevice(frame.deviceId);
    if (!device) return drop(connection, CLOSE.authFailed);
    let valid = false;
    try { valid = verifyAuth(parseDevicePublicKey(device.publicKey), hostId, fingerprint, connection.nonce, frame.signature); } catch { valid = false; }
    if (!valid) return drop(connection, CLOSE.authFailed);
    if (device.revokedAt) return drop(connection, CLOSE.revoked, 'revoked');
    const live = [...connections].filter(c => c.state === 'ready' && c.device?.id === device.id).length;
    if (live >= limits.maxConnectionsPerDevice) return drop(connection, CLOSE.tooManyConnections, 'too many connections');
    // Identity is derived only here, from the verified device record.
    const principal: PrincipalV2 = Object.freeze({
      id: `device:${device.id}`, kind: 'remote' as const, ownerId, deviceId: device.id,
      capabilities: Object.freeze([...device.capabilities]) as CapabilityV2[],
    });
    connection.device = device; connection.principal = principal;
    try {
      connection.unsubscribe = gateway.subscribe((event: DesktopEventV2) => {
        if (connection.state !== 'ready') return;
        if (event.principalId !== ownerId && event.principalId !== principal.id) return;
        const safe = redactEvent(event);
        if (safe) send(connection, { t: 'event', event: safe });
      }, principal as unknown as Principal, { contractVersion: 2 });
    } catch { return drop(connection, CLOSE.authFailed); }
    connection.state = 'ready';
    store.touch(device.id, now().toISOString());
    send(connection, { t: 'ready', deviceId: device.id, hostId, hostName, principalId: principal.id, capabilities: [...principal.capabilities] });
  };

  const command = (connection: Connection, value: unknown): void => {
    const principal = connection.principal!;
    const reply = (result: CommandResultV2) => send(connection, { t: 'result', id: result.commandId, result });
    const nowMs = Date.now();
    connection.tokens = Math.min(limits.commandBurst, connection.tokens + (nowMs - connection.refilledAt) / 1000 * limits.commandsPerSecond);
    connection.refilledAt = nowMs;
    const check = parseRemoteCommand(value);
    const commandId = check.ok ? check.command.id : check.commandId;
    if (connection.tokens < 1) return reply({ ok: false, commandId, error: { code: 'RATE_LIMITED', message: 'Too many commands', retryable: true } });
    connection.tokens -= 1;
    if (!check.ok) return reply({ ok: false, commandId, error: { code: check.code, message: check.message } });
    if (connection.pending >= limits.maxPendingCommands) return reply({ ok: false, commandId, error: { code: 'BUSY', message: 'Too many pending commands', retryable: true } });
    connection.pending += 1;
    Promise.resolve()
      .then(() => gateway.dispatch(check.command, principal as unknown as Principal))
      .then((result: AnyCommandResult) => redactResult({ ...(result as CommandResultV2), commandId }),
        () => ({ ok: false as const, commandId, error: { code: 'BACKEND_ERROR', message: 'The host could not complete this command', retryable: true } }))
      .then(result => { if (connection.state === 'ready') reply(result); })
      .finally(() => { connection.pending -= 1; });
  };

  const heartbeat = setInterval(() => {
    for (const connection of connections) {
      if (!connection.alive) { connection.ws.terminate(); continue; }
      connection.alive = false;
      try { connection.ws.ping(); } catch { /* closing */ }
    }
  }, limits.heartbeatMs);
  heartbeat.unref();

  await new Promise<void>((resolve, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(options.listen.port, options.listen.host, () => { server.off('error', rejectListen); resolve(); });
  });
  const bound = server.address();
  if (!bound || typeof bound === 'string') throw new Error('Unexpected listen address');
  const port = bound.port;
  const urls = options.advertiseUrls?.length ? [...options.advertiseUrls] : (() => {
    const host = options.listen.host;
    if (host !== '0.0.0.0' && host !== '::' && host !== '') return [`wss://${formatHost(host)}:${port}${WS_PATH}`];
    const addresses = Object.values(networkInterfaces()).flat().filter(a => a && !a.internal && a.family === 'IPv4').map(a => a!.address);
    return (addresses.length ? addresses : ['127.0.0.1']).map(a => `wss://${a}:${port}${WS_PATH}`);
  })();

  const deviceManager: DeviceManager = {
    async startPairing(input) {
      if (closed) throw new Error('Remote host is closed');
      const requested = input?.capabilities;
      if (requested !== undefined && (!Array.isArray(requested) || requested.some(c => !ALL_CAPABILITIES_V2.includes(c)))) throw new Error('Unknown capability');
      const capabilities = [...new Set(requested ?? DEFAULT_DEVICE_CAPABILITIES)];
      const at = now();
      store.pruneExpiredPairings(at);
      const secret = randomBytes(16).toString('base64url');
      const expiresAt = new Date(at.getTime() + limits.pairingTtlMs).toISOString();
      const name = cleanName(input?.name);
      store.addPairing(hashSecret(secret), { ...(name ? { name } : {}), capabilities, expiresAt });
      const offer: PairingOffer = { code: encodePairingCode({ v: 1, urls, fp: fingerprint, secret }), expiresAt, hostFingerprint: fingerprint, urls: [...urls] };
      return offer;
    },
    async list(): Promise<DeviceInfo[]> {
      return store.listDevices().map(({ publicKey: _key, ...info }) => info);
    },
    async revoke(deviceId: string): Promise<void> {
      if (!store.revoke(deviceId, now().toISOString())) throw Object.assign(new Error('Unknown device'), { code: 'NOT_FOUND' });
      for (const connection of connections) if (connection.device?.id === deviceId) drop(connection, CLOSE.revoked, 'revoked');
    },
  };

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    closed = true;
    clearInterval(heartbeat);
    for (const connection of connections) { drop(connection, CLOSE.shutdown, 'shutdown'); connection.ws.terminate(); }
    connections.clear();
    wss.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    store.close();
  })();

  return { deviceManager, address: { host: options.listen.host, port, urls }, fingerprint, hostId, close };
}
