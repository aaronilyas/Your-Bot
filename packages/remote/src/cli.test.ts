import { afterEach, describe, expect, it } from 'vitest';
import { createRemoteHost } from './server.js';
import { runCli } from './cli.js';
import { FakeGateway, tempDir, waitFor } from './test/fake-gateway.js';

const OWNER = 'local-owner';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

function io(config: string, signal?: AbortSignal) {
  const out: string[] = [], err: string[] = [];
  return { out, err, io: { env: { YOUR_BOT_REMOTE_HOME: config }, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l), connectTimeoutMs: 3000, ...(signal ? { signal } : {}) } };
}

async function setup() {
  const data = tempDir(), config = tempDir();
  cleanups.push(data.cleanup, config.cleanup);
  const gateway = new FakeGateway('h', 'Workstation');
  const remote = await createRemoteHost({ gateway, ownerId: OWNER, dataDir: data.path, listen: { host: '127.0.0.1', port: 0 }, hostName: 'Workstation' });
  cleanups.push(() => remote.close());
  return { gateway, remote, config: config.path };
}

describe('your-bot-remote CLI', () => {
  it('pair → hosts → approvals → approve round trip', async () => {
    const { gateway, remote, config } = await setup();
    const offer = await remote.deviceManager.startPairing({});
    const pair = io(config);
    expect(await runCli(['pair', offer.code, '--name', 'phone'], pair.io)).toBe(0);
    expect(pair.out[0]).toContain(`Paired with Workstation (${remote.hostId})`);
    expect(pair.err.join('\n')).toMatch(/unencrypted/);

    const hosts = io(config);
    expect(await runCli(['hosts', '--json'], hosts.io)).toBe(0);
    expect(JSON.parse(hosts.out[0]!)).toEqual([expect.objectContaining({ hostId: remote.hostId, hostName: 'Workstation', deviceName: 'phone' })]);

    gateway.addPending(OWNER, { id: 'req-1', capability: 'file.write', reason: 'Edit README', paths: [{ path: '/w/README.md', access: 'write' }] });
    gateway.addPending(OWNER, { id: 'req-2', capability: 'process.spawn', reason: 'Run build', command: { command: 'npm', args: ['run', 'build'], cwd: '/w' } });
    const approvals = io(config);
    expect(await runCli(['approvals', '--json'], approvals.io)).toBe(0);
    expect(JSON.parse(approvals.out[0]!).map((a: { hostId: string; request: { id: string } }) => [a.hostId, a.request.id])).toEqual([[remote.hostId, 'req-1'], [remote.hostId, 'req-2']]);
    const text = io(config);
    expect(await runCli(['approvals', '--host', remote.hostId], text.io)).toBe(0);
    expect(text.out.join('\n')).toContain('write:/w/README.md');
    expect(text.out.join('\n')).toContain('$ npm run build');

    const approve = io(config);
    expect(await runCli(['approve', 'req-1', '--scope', 'task'], approve.io)).toBe(0);
    expect(approve.out[0]).toBe(`Allowed req-1 on ${remote.hostId}`);
    const deny = io(config);
    expect(await runCli(['approve', 'req-2', '--deny', '--host', remote.hostId], deny.io)).toBe(0);
    expect(gateway.decisions.map(d => d.decision)).toEqual([
      { requestId: 'req-1', outcome: 'allow', scope: 'task' },
      { requestId: 'req-2', outcome: 'deny', scope: 'once' },
    ]);
    for (const d of gateway.decisions) expect(d.principal).toMatchObject({ id: expect.stringMatching(/^device:/), kind: 'remote', ownerId: OWNER });

    const again = io(config);
    expect(await runCli(['approve', 'req-1'], again.io)).toBe(1);
    expect(again.err.join('\n')).toContain('No pending request req-1');
    expect(await runCli(['approve', 'req-x', '--scope', 'forever'], io(config).io)).toBe(2);
    // A used code cannot pair again.
    const replay = io(config);
    expect(await runCli(['pair', offer.code], replay.io)).toBe(1);
    expect(replay.err.join('\n')).toMatch(/refused/);
  });

  it('watch streams new approvals and notifications until aborted', async () => {
    const { gateway, remote, config } = await setup();
    expect(await runCli(['pair', (await remote.deviceManager.startPairing({})).code], io(config).io)).toBe(0);
    gateway.addPending(OWNER, { id: 'old', capability: 'file.read', reason: 'Existing' });
    const controller = new AbortController();
    const watch = io(config, controller.signal);
    const running = runCli(['watch'], watch.io);
    await waitFor(() => watch.out.some(l => l.includes(' old ')));
    gateway.addPending(OWNER, { id: 'new', capability: 'mcp.call', reason: 'Open browser', mcp: { serverId: 'browser', tool: 'navigate' } });
    gateway.emit(OWNER, { type: 'notification', notification: { id: 'n1', kind: 'routine.failed', title: 'Nightly report', body: 'failed', createdAt: new Date().toISOString() } });
    await waitFor(() => watch.out.some(l => l.startsWith('notification')));
    controller.abort();
    expect(await running).toBe(0);
    expect(watch.out.filter(l => l.startsWith('approval')).map(l => l.split('  ')[1])).toEqual(['old', 'new']);
    expect(watch.out.find(l => l.startsWith('notification'))).toContain('Nightly report: failed');
  });

  it('reports usage errors and an empty directory', async () => {
    const config = tempDir(); cleanups.push(config.cleanup);
    const empty = io(config.path);
    expect(await runCli(['hosts'], empty.io)).toBe(0);
    expect(empty.out).toEqual(['No paired hosts.']);
    expect(await runCli([], io(config.path).io)).toBe(2);
    expect(await runCli(['frobnicate'], io(config.path).io)).toBe(2);
    expect(await runCli(['pair', 'not-a-code'], io(config.path).io)).toBe(1);
  });
});
