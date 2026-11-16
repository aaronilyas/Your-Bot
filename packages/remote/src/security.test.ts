import { afterEach, describe, expect, it } from 'vitest';
import { get as httpGet } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import type { DesktopCommandV2, PrincipalV2 } from '@your-bot/contracts';
import { createRemoteHost, type RemoteHost, type RemoteHostOptions } from './server.js';
import { Link, RemoteError, RemoteTransport, connectDevice, credentialsFrom, pairWithCode, type PairedHost } from './client.js';
import { CLOSE, DEFAULT_DEVICE_CAPABILITIES, decodePairingCode, encodePairingCode } from './protocol.js';
import { FakeGateway, tempDir, waitFor } from './test/fake-gateway.js';
/** POSIX permission bits; Windows has none (ACLs instead), so compare as equal there. */
const posixMode = (mode: number): number => (process.platform === 'win32' ? 0 : mode & 0o777);

const OWNER = 'local-owner';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

async function host(overrides: Partial<RemoteHostOptions> = {}) {
  const dir = tempDir(); cleanups.push(dir.cleanup);
  const gateway = (overrides.gateway as FakeGateway | undefined) ?? new FakeGateway();
  const remote = await createRemoteHost({ gateway, ownerId: OWNER, dataDir: dir.path, listen: { host: '127.0.0.1', port: 0 }, hostName: 'Test host', ...overrides });
  cleanups.push(() => remote.close());
  return { remote, gateway, dir: dir.path };
}
async function paired(remote: RemoteHost, name = 'phone'): Promise<PairedHost> {
  const offer = await remote.deviceManager.startPairing({});
  return pairWithCode(offer.code, { name, timeoutMs: 3000 });
}
const creds = (p: PairedHost) => credentialsFrom(p, p.privateKeyPem);
const url = (remote: RemoteHost) => remote.address.urls[0]!;
const cmd = (type: string, extra: Record<string, unknown> = {}) => ({ version: 2, id: `c-${Math.random().toString(36).slice(2)}`, type, ...extra }) as unknown as DesktopCommandV2;
const closed = (link: Link) => new Promise<RemoteError>(resolve => link.onClose(resolve));

describe('remote host TLS listener', () => {
  it('persists an owner-only certificate, key and device store, and keeps its identity across restarts', async () => {
    const { remote, dir, gateway } = await host();
    expect(posixMode(statSync(dir).mode)).toBe(posixMode(0o700));
    expect(posixMode(statSync(join(dir, 'tls')).mode)).toBe(posixMode(0o700));
    for (const file of ['tls/key.pem', 'tls/cert.pem', 'devices.sqlite']) expect(posixMode(statSync(join(dir, file)).mode)).toBe(posixMode(0o600));
    const cert = new X509Certificate(readFileSync(join(dir, 'tls/cert.pem')));
    expect(cert.verify(cert.publicKey)).toBe(true);
    const { fingerprint, hostId } = remote;
    await remote.close();
    const again = await createRemoteHost({ gateway, ownerId: OWNER, dataDir: dir, listen: { host: '127.0.0.1', port: 0 }, hostName: 'Test host' });
    cleanups.push(() => again.close());
    expect(again.fingerprint).toBe(fingerprint);
    expect(again.hostId).toBe(hostId);
  });

  it('has no plaintext listener: ws:// and http:// to the port fail', async () => {
    const { remote, gateway } = await host();
    const port = remote.address.port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const wsOutcome = await new Promise<string>(resolve => {
      ws.on('open', () => resolve('open'));
      ws.on('error', () => resolve('error'));
      ws.on('unexpected-response', () => resolve('response'));
    });
    expect(wsOutcome).toBe('error');
    ws.terminate();
    const httpOutcome = await new Promise<string>(resolve => {
      const request = httpGet({ host: '127.0.0.1', port, path: '/', timeout: 3000 }, response => resolve(`status ${response.statusCode}`));
      request.on('error', () => resolve('error'));
      request.on('timeout', () => { request.destroy(); resolve('error'); });
    });
    expect(httpOutcome).toBe('error');
    // Even over TLS, a plain HTTPS request gets only "426 Upgrade Required" and no content.
    const https = await new Promise<{ status?: number; body: string }>(resolve => {
      const request = httpsRequest({ host: '127.0.0.1', port, path: '/', rejectUnauthorized: false }, response => {
        let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body }));
      });
      request.on('error', () => resolve({ body: 'error' })); request.end();
    });
    expect(https).toEqual({ status: 426, body: '' });
    expect(gateway.dispatched).toHaveLength(0);
  });

  it('refuses a client whose pinned fingerprint does not match', async () => {
    const { remote, gateway } = await host();
    await expect(Link.open(url(remote), 'ab'.repeat(32), 3000)).rejects.toMatchObject({ code: 'FINGERPRINT_MISMATCH' });
    // A code carrying a wrong fingerprint never reaches the host, so the offer stays unused.
    const offer = await remote.deviceManager.startPairing({});
    const tampered = encodePairingCode({ ...decodePairingCode(offer.code), fp: 'cd'.repeat(32) });
    await expect(pairWithCode(tampered, { name: 'mitm', timeoutMs: 3000 })).rejects.toMatchObject({ code: 'FINGERPRINT_MISMATCH' });
    await expect(pairWithCode(offer.code, { name: 'real', timeoutMs: 3000 })).resolves.toMatchObject({ hostId: remote.hostId });
    expect(gateway.dispatched).toHaveLength(0);
  });
});

describe('unauthenticated sockets', () => {
  it('receive only the challenge, get no events, cannot dispatch, and time out', async () => {
    const { remote, gateway } = await host({ limits: { authTimeoutMs: 400 } });
    const link = await Link.open(url(remote), remote.fingerprint);
    const frames: unknown[] = [];
    link.onFrame(frame => frames.push(frame));
    gateway.emit(OWNER, { type: 'agents.updated', agents: [] });
    expect(gateway.activeSubscriptions()).toBe(0);
    const error = await closed(link);
    expect(error.closeCode).toBe(CLOSE.authTimeout);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ t: 'challenge', hostId: remote.hostId, fp: remote.fingerprint });
    expect(gateway.dispatched).toHaveLength(0);
  });

  it('closes a socket that sends a command before authenticating', async () => {
    const { remote, gateway } = await host();
    const link = await Link.open(url(remote), remote.fingerprint);
    await link.next();
    link.send({ t: 'command', command: cmd('state.sync') });
    expect((await closed(link)).closeCode).toBe(CLOSE.protocol);
    expect(gateway.dispatched).toHaveLength(0);
    expect(gateway.activeSubscriptions()).toBe(0);
  });

  it('rejects a bad signature and an unknown device', async () => {
    const { remote, gateway } = await host();
    const device = await paired(remote);
    const other = await paired(remote, 'other');
    // Device A's id signed with device B's key.
    await expect(connectDevice({ ...creds(device), privateKey: creds(other).privateKey }, 3000)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(connectDevice({ ...creds(device), deviceId: 'no-such-device' }, 3000)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(gateway.subscriptions).toHaveLength(0);
  });

  it('rejects browser origins and wrong paths before the challenge', async () => {
    const { remote } = await host();
    const attempt = (path: string, headers: Record<string, string> = {}) => new Promise<number | string>(resolve => {
      const ws = new WebSocket(`wss://127.0.0.1:${remote.address.port}${path}`, { rejectUnauthorized: false, headers });
      ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
      ws.on('open', () => { resolve('open'); ws.terminate(); });
      ws.on('error', () => resolve('error'));
    });
    expect(await attempt('/ws', { Origin: 'https://evil.example' })).toBe(403);
    expect(await attempt('/other')).toBe(404);
  });
});

describe('pairing', () => {
  it('issues a ybp1 code and registers the device with default capabilities', async () => {
    const { remote } = await host();
    const offer = await remote.deviceManager.startPairing({});
    expect(offer.code.startsWith('ybp1.')).toBe(true);
    const payload = decodePairingCode(offer.code);
    expect(payload).toMatchObject({ v: 1, fp: remote.fingerprint, urls: remote.address.urls });
    expect(Buffer.from(payload.secret, 'base64url')).toHaveLength(16);
    const device = await pairWithCode(offer.code, { name: 'phone' });
    expect(device.capabilities).toEqual(DEFAULT_DEVICE_CAPABILITIES);
    expect(device.capabilities).not.toContain('settings');
    expect(device.capabilities).not.toContain('network');
    expect(device.capabilities).not.toContain('library.install');
    const list = await remote.deviceManager.list();
    expect(list).toEqual([expect.objectContaining({ id: device.deviceId, name: 'phone', capabilities: DEFAULT_DEVICE_CAPABILITIES })]);
    expect(JSON.stringify(list)).not.toContain('publicKey');
  });

  it('rejects malformed codes and non-wss URLs', () => {
    const fp = 'ab'.repeat(32), secret = Buffer.alloc(16, 1).toString('base64url');
    expect(() => decodePairingCode('ybp2.abc')).toThrow();
    expect(() => decodePairingCode(encodePairingCode({ v: 1, urls: ['ws://127.0.0.1:1/ws'], fp, secret }))).toThrow(/wss/);
    expect(() => decodePairingCode(encodePairingCode({ v: 1, urls: ['wss://u:p@127.0.0.1:1/ws'], fp, secret }))).toThrow(/credentials/);
    expect(() => decodePairingCode(encodePairingCode({ v: 1, urls: ['wss://127.0.0.1:1/ws'], fp: 'zz', secret }))).toThrow();
    expect(() => decodePairingCode(encodePairingCode({ v: 1, urls: ['wss://127.0.0.1:1/ws'], fp, secret: 'short' }))).toThrow();
  });

  it('refuses a replayed code', async () => {
    const { remote } = await host();
    const offer = await remote.deviceManager.startPairing({});
    await pairWithCode(offer.code, { name: 'first' });
    await expect(pairWithCode(offer.code, { name: 'replay' })).rejects.toMatchObject({ code: 'PAIRING_REFUSED' });
    expect(await remote.deviceManager.list()).toHaveLength(1);
  });

  it('refuses an expired code', async () => {
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const { remote } = await host({ now: () => new Date(clock) });
    const offer = await remote.deviceManager.startPairing({});
    expect(Date.parse(offer.expiresAt) - clock).toBe(10 * 60_000);
    clock += 10 * 60_000 + 1;
    await expect(pairWithCode(offer.code, { name: 'late' })).rejects.toMatchObject({ code: 'PAIRING_REFUSED' });
    expect(await remote.deviceManager.list()).toHaveLength(0);
  });

  it('throttles guessing: after repeated failures even a valid code is refused until the window passes', async () => {
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const { remote } = await host({ now: () => new Date(clock), limits: { pairingFailures: 3, pairingWindowMs: 60_000 } });
    const offer = await remote.deviceManager.startPairing({});
    const payload = decodePairingCode(offer.code);
    for (let i = 0; i < 3; i++) {
      const guess = encodePairingCode({ ...payload, secret: Buffer.alloc(16, i).toString('base64url') });
      await expect(pairWithCode(guess, { name: 'guess' })).rejects.toMatchObject({ code: 'PAIRING_REFUSED' });
    }
    await expect(pairWithCode(offer.code, { name: 'valid' })).rejects.toMatchObject({ code: 'PAIRING_REFUSED' });
    clock += 61_000;
    // The refused valid attempt was throttled before lookup, so the offer was not consumed.
    await expect(pairWithCode(offer.code, { name: 'valid' })).resolves.toMatchObject({ deviceName: 'valid' });
  });
});

describe('authenticated command forwarding', () => {
  it('derives the principal server-side and ignores forged identity fields', async () => {
    const { remote, gateway } = await host();
    const device = await paired(remote);
    const { link, ready } = await connectDevice(creds(device));
    expect(ready.principalId).toBe(`device:${device.deviceId}`);
    const results = new Map<string, { ok: boolean; error?: { code: string } }>();
    link.onFrame(frame => { if (frame.t === 'result') results.set(frame.id, frame.result as never); });
    const forged = { t: 'command', principal: { id: OWNER, kind: 'local', capabilities: ['settings'] }, ownerId: 'someone-else', deviceId: 'other', principalId: OWNER, command: cmd('state.sync') };
    link.send(forged as never);
    const inner = cmd('state.sync', { principal: { id: OWNER, kind: 'local' } });
    link.send({ t: 'command', command: inner });
    const settings = cmd('settings.update', { settings: { providers: [] } });
    link.send({ t: 'command', command: settings });
    await waitFor(() => results.size === 3);
    expect(results.get(inner.id)).toMatchObject({ ok: false, error: { code: 'INVALID_COMMAND' } });
    expect(results.get(settings.id)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(gateway.dispatched).toHaveLength(1);
    const expected: PrincipalV2 = { id: `device:${device.deviceId}`, kind: 'remote', ownerId: OWNER, deviceId: device.deviceId, capabilities: [...DEFAULT_DEVICE_CAPABILITIES] };
    expect(gateway.dispatched[0]!.principal).toEqual(expected);
    expect(gateway.subscriptions[0]).toMatchObject({ principal: expected, options: { contractVersion: 2 } });
    link.close();
  });

  it('rejects v1 command frames and unknown v2 shapes without reaching the gateway', async () => {
    const { remote, gateway } = await host();
    const transport = new RemoteTransport({ credentials: creds(await paired(remote)), autoReconnect: false });
    cleanups.push(() => transport.close());
    await transport.connect();
    const before = gateway.dispatched.length;
    const { link } = await connectDevice(transport['options'].credentials);
    const results: { ok: boolean; error?: { code: string } }[] = [];
    link.onFrame(frame => { if (frame.t === 'result') results.push(frame.result as never); });
    link.send({ t: 'command', command: { version: 1, id: 'v1', type: 'state.sync' } as never });
    link.send({ t: 'command', command: { version: 2, id: 'bad', type: 'shell.exec', cmd: 'rm -rf /' } as never });
    link.send({ t: 'command', command: { version: 2, id: 'dev', type: 'device.revoke', deviceId: 'x' } as never });
    await waitFor(() => results.length === 3);
    expect(results.map(r => r.error?.code)).toEqual(['UNSUPPORTED_VERSION', 'INVALID_COMMAND', 'FORBIDDEN']);
    expect(gateway.dispatched).toHaveLength(before);
    expect(await transport.dispatch({ version: 1, id: 'x', type: 'state.sync' } as never)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_VERSION' } });
    link.close();
  });

  it('redacts credentials and the device registry from snapshots', async () => {
    const { remote } = await host();
    const transport = new RemoteTransport({ credentials: creds(await paired(remote)), autoReconnect: false });
    cleanups.push(() => transport.close());
    await transport.connect();
    expect(transport.snapshot?.devices).toEqual([]);
    expect(JSON.stringify(transport.snapshot)).not.toContain('sk-secret');
  });

  it('enforces the 1 MiB frame cap', async () => {
    const { remote, gateway } = await host();
    const { link } = await connectDevice(creds(await paired(remote)));
    link.send({ t: 'command', command: cmd('message.send', { sessionId: 's', content: 'x'.repeat(1024 * 1024 + 16) }) });
    expect((await closed(link)).closeCode).toBe(CLOSE.tooBig);
    expect(gateway.dispatched).toHaveLength(0);
  });

  it('rate limits commands per connection and caps connections per device', async () => {
    const { remote } = await host({ limits: { commandBurst: 3, commandsPerSecond: 0.001, maxConnectionsPerDevice: 2 } });
    const device = await paired(remote);
    const { link } = await connectDevice(creds(device));
    const results: { ok: boolean; error?: { code: string } }[] = [];
    link.onFrame(frame => { if (frame.t === 'result') results.push(frame.result as never); });
    for (let i = 0; i < 5; i++) link.send({ t: 'command', command: cmd('models.refresh') });
    await waitFor(() => results.length === 5);
    expect(results.filter(r => !r.ok).map(r => r.error?.code)).toEqual(['RATE_LIMITED', 'RATE_LIMITED']);
    const second = await connectDevice(creds(device));
    await expect(connectDevice(creds(device))).rejects.toMatchObject({ code: 'TOO_MANY_CONNECTIONS' });
    link.close(); second.link.close();
  });

  it('unsubscribes on disconnect without cancelling tasks', async () => {
    const { remote, gateway } = await host();
    const transport = new RemoteTransport({ credentials: creds(await paired(remote)), autoReconnect: false });
    await transport.connect();
    expect(gateway.activeSubscriptions()).toBe(1);
    await transport.close();
    await waitFor(() => gateway.activeSubscriptions() === 0);
    expect(gateway.cancelled).toEqual([]);
  });
});

describe('revocation', () => {
  it('closes live sockets immediately, stops events, and blocks reconnect', async () => {
    const { remote, gateway } = await host();
    const device = await paired(remote);
    const transport = new RemoteTransport({ credentials: creds(device), backoff: { initialMs: 20, maxMs: 50 } });
    cleanups.push(() => transport.close());
    await transport.connect();
    const events: number[] = [];
    transport.subscribe(event => events.push(event.sequence));
    await remote.deviceManager.revoke(device.deviceId);
    expect(gateway.activeSubscriptions()).toBe(0);
    gateway.emit(OWNER, { type: 'agents.updated', agents: [] });
    await waitFor(() => transport.status === 'revoked');
    expect(events).toEqual([]);
    await expect(connectDevice(creds(device), 3000)).rejects.toMatchObject({ code: 'REVOKED' });
    const list = await remote.deviceManager.list();
    expect(list[0]).toMatchObject({ id: device.deviceId });
    expect(list[0]!.revokedAt).toBeTruthy();
    expect(list[0]!.lastSeenAt).toBeTruthy();
    await expect(remote.deviceManager.revoke('missing')).rejects.toThrow();
  });
});
