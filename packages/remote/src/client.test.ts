import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { DesktopEventV2, SecretCipher } from '@your-bot/contracts';
import { createRemoteHost, type RemoteHost } from './server.js';
import { RemoteTransport, pairWithCode } from './client.js';
import { HostDirectory } from './directory.js';
import { MultiHostClient } from './multi.js';
import { FakeGateway, tempDir, waitFor } from './test/fake-gateway.js';

const OWNER = 'local-owner';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

async function startHost(name: string, gateway = new FakeGateway(name, name), dataDir?: string, port = 0): Promise<{ remote: RemoteHost; gateway: FakeGateway; dataDir: string }> {
  if (!dataDir) { const dir = tempDir(); cleanups.push(dir.cleanup); dataDir = dir.path; }
  const remote = await createRemoteHost({ gateway, ownerId: OWNER, dataDir, listen: { host: '127.0.0.1', port }, hostName: name });
  cleanups.push(() => remote.close());
  return { remote, gateway, dataDir };
}
const directory = (cipher?: SecretCipher) => { const dir = tempDir(); cleanups.push(dir.cleanup); return new HostDirectory(dir.path, cipher ? { cipher } : {}); };
const pairInto = async (remote: RemoteHost, hosts: HostDirectory, name = 'laptop') =>
  hosts.add(await pairWithCode((await remote.deviceManager.startPairing({})).code, { name }));

class TestCipher implements SecretCipher {
  readonly id = 'test-aes';
  private key = randomBytes(32);
  encrypt(plaintext: string) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', this.key, iv); const ct = Buffer.concat([c.update(plaintext), c.final()]); return [iv, c.getAuthTag(), ct].map(b => b.toString('base64url')).join('.'); }
  decrypt(ciphertext: string) { const [iv, tag, ct] = ciphertext.split('.').map(p => Buffer.from(p, 'base64url')); const d = createDecipheriv('aes-256-gcm', this.key, iv!); d.setAuthTag(tag!); return Buffer.concat([d.update(ct!), d.final()]).toString(); }
}

describe('host directory', () => {
  it('stores hosts in an owner-only file; keys are encrypted when a cipher is injected', async () => {
    const { remote } = await startHost('alpha');
    const cipher = new TestCipher();
    const encrypted = directory(cipher);
    const saved = await pairInto(remote, encrypted);
    expect(statSync(encrypted.directory).mode & 0o777).toBe(0o700);
    expect(statSync(encrypted.file).mode & 0o777).toBe(0o600);
    const text = readFileSync(encrypted.file, 'utf8');
    expect(text).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(encrypted.list())).not.toContain('key');
    expect(encrypted.credentials(saved.hostId).privateKey.asymmetricKeyType).toBe('ed25519');
    expect(() => new HostDirectory(encrypted.directory).credentials(saved.hostId)).toThrow(/cipher/);
    // A host whose key cannot be decrypted is reported per host, not thrown.
    const noCipher = new MultiHostClient(new HostDirectory(encrypted.directory), { autoReconnect: false });
    expect(await noCipher.start()).toEqual([{ hostId: saved.hostId, ok: false, error: expect.stringMatching(/cipher/) }]);
    await noCipher.close();

    const plain = directory();
    const plainSaved = await pairInto(remote, plain);
    expect(readFileSync(plain.file, 'utf8')).toContain('PRIVATE KEY');
    expect(plain.credentials(plainSaved.hostId).deviceId).toBe(plainSaved.deviceId);
  });
});

describe('MultiHostClient', () => {
  it('lists and connects to two hosts and merges their pending approvals', async () => {
    const a = await startHost('alpha');
    const b = await startHost('beta');
    const hosts = directory();
    await pairInto(a.remote, hosts); await pairInto(b.remote, hosts);
    a.gateway.addPending(OWNER, { id: 'req-a', capability: 'file.write', reason: 'Write notes', paths: [{ path: '/tmp/a', access: 'write' }] });
    b.gateway.addPending(OWNER, { id: 'req-b', capability: 'process.spawn', reason: 'Run tests', command: { command: 'npm', args: ['test'], cwd: '/w' } });
    const client = new MultiHostClient(hosts, { autoReconnect: false });
    cleanups.push(() => client.close());
    expect(client.hosts().map(h => [h.hostName, h.status])).toEqual([['alpha', 'idle'], ['beta', 'idle']]);
    const outcomes = await client.start();
    expect(outcomes.every(o => o.ok)).toBe(true);
    expect(client.hosts().map(h => [h.hostId, h.status])).toEqual([[a.remote.hostId, 'ready'], [b.remote.hostId, 'ready']]);
    const approvals = client.pendingApprovals().map(p => [p.hostId, p.hostName, p.request.id]);
    expect(approvals).toEqual([[a.remote.hostId, 'alpha', 'req-a'], [b.remote.hostId, 'beta', 'req-b']]);

    const seen: [string, string][] = [];
    client.subscribe((hostId, event) => seen.push([hostId, event.type]));
    expect(await client.decide(b.remote.hostId, { requestId: 'req-b', outcome: 'deny', scope: 'once' })).toMatchObject({ ok: true });
    await waitFor(() => seen.some(([h, t]) => h === b.remote.hostId && t === 'permission.resolved'));
    expect(client.pendingApprovals().map(p => p.request.id)).toEqual(['req-a']);
    expect(b.gateway.decisions[0]!.principal).toMatchObject({ kind: 'remote', ownerId: OWNER });
    expect(a.gateway.decisions).toEqual([]);
  });
});

describe('resume', () => {
  it('replays events missed during a disconnect exactly once, in order', async () => {
    const gateway = new FakeGateway('h', 'resumable');
    const first = await startHost('resumable', gateway);
    const hosts = directory();
    const saved = await pairInto(first.remote, hosts);
    const transport = new RemoteTransport({ credentials: hosts.credentials(saved.hostId), backoff: { initialMs: 20, maxMs: 100 } });
    cleanups.push(() => transport.close());
    const received: DesktopEventV2[] = [];
    transport.subscribe(event => received.push(event));
    await transport.connect();
    const delta = (text: string) => gateway.emit(OWNER, { type: 'message.delta', taskId: 't', sessionId: 's', text });
    delta('before-1'); delta('before-2');
    await waitFor(() => received.filter(e => e.type === 'message.delta').length === 2);

    // Host goes away (network drop); events keep happening on the gateway.
    const port = first.remote.address.port;
    await first.remote.close();
    await waitFor(() => transport.status === 'disconnected' || transport.status === 'connecting');
    delta('missed-1'); delta('missed-2'); delta('missed-3');

    // Host comes back on the same address with the same identity; client reconnects and resumes.
    await startHost('resumable', gateway, first.dataDir, port);
    await waitFor(() => transport.status === 'ready', 10_000);
    delta('after-1');
    await waitFor(() => received.some(e => e.type === 'message.delta' && e.text === 'after-1'));

    const texts = received.filter(e => e.type === 'message.delta').map(e => (e as { text: string }).text);
    expect(texts).toEqual(['before-1', 'before-2', 'missed-1', 'missed-2', 'missed-3', 'after-1']);
    const sequences = received.map(e => e.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect([...sequences].sort((x, y) => x - y)).toEqual(sequences);
    // Resume used the cursor, not a full resync.
    const syncs = gateway.dispatched.filter(d => d.command.type === 'state.sync').map(d => (d.command as { afterSequence?: number }).afterSequence);
    expect(syncs[0]).toBeUndefined();
    expect(syncs[1]).toBe(received.find(e => e.type === 'message.delta' && e.text === 'before-2')!.sequence);
  });

  it('falls back to a full sync when the cursor is ahead of the host', async () => {
    const { remote, gateway } = await startHost('fresh');
    const hosts = directory();
    const saved = await pairInto(remote, hosts);
    const transport = new RemoteTransport({ credentials: hosts.credentials(saved.hostId), afterSequence: 999, autoReconnect: false });
    cleanups.push(() => transport.close());
    await transport.connect();
    expect(transport.status).toBe('ready');
    expect(gateway.dispatched.map(d => (d.command as { afterSequence?: number }).afterSequence)).toEqual([999, undefined]);
  });
});
