import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppSettingsV2, DesktopEventV2 } from '@your-bot/contracts';
import { createRuntime } from '@your-bot/runtime';
import { HostDirectory, MultiHostClient, pairWithCode } from '@your-bot/remote';
import { command, ok, onCleanup, tempDir, trustedFixture, waitFor } from './v2-helpers.js';

describe('remote host', () => {
  it('pairs on 127.0.0.1 and lets the paired device allow the owner task', async () => {
    const dataDir = await tempDir('your-bot-v2-remote-');
    const workspace = await tempDir('your-bot-v2-remote-ws-');
    const hostsDir = await tempDir('your-bot-v2-remote-hosts-');
    const runtime = await createRuntime({ dataDir, listen: { host: '127.0.0.1', port: 0 }, hostName: 'bench' });
    onCleanup(() => runtime.close());
    expect(runtime.remote?.address.host).toBe('127.0.0.1');
    expect(runtime.remote?.address.port).toBeGreaterThan(0);
    const settings: AppSettingsV2 = {
      providers: [{
        id: 'fixture', name: 'Fixture', kind: 'acp', enabled: true, launch: 'host',
        command: process.execPath, args: [trustedFixture, 'act'],
      }],
    };
    ok(await runtime.gateway.dispatch(command({ type: 'settings.update', settings }), runtime.principal));
    const created = await runtime.gateway.dispatch(command({
      type: 'bot.create',
      bot: {
        name: 'Worker', instructions: '', agentId: 'fixture', profile: 'trusted', workspace,
        mcpServers: [], skills: [], memoryEnabled: false,
      },
    }), runtime.principal);
    ok(created);
    const session = await runtime.gateway.dispatch(command({ type: 'bot.session.create', botId: created.bot!.id }), runtime.principal);
    ok(session);
    const offer = await runtime.gateway.dispatch(command({ type: 'device.pair.start', name: 'phone' }), runtime.principal);
    ok(offer);
    const directory = new HostDirectory(hostsDir);
    const paired = await pairWithCode(offer.pairing!.code, { name: 'phone', timeoutMs: 5_000 });
    expect(paired.hostId).toBe(runtime.remote!.hostId);
    directory.add(paired);
    const client = new MultiHostClient(directory, { autoReconnect: false, connectTimeoutMs: 5_000, commandTimeoutMs: 10_000 });
    onCleanup(() => client.close());
    const events: DesktopEventV2[] = [];
    runtime.gateway.subscribe(event => events.push(event), runtime.principal, { contractVersion: 2 });
    client.subscribe((hostId, event) => {
      if (event.type !== 'permission.requested') return;
      void client.decide(hostId, { requestId: event.request.id, outcome: 'allow', scope: 'once' });
    });
    expect((await client.start()).every(outcome => outcome.ok)).toBe(true);
    const sent = await runtime.gateway.dispatch(command({ type: 'message.send', sessionId: session.sessionId!, content: 'Go' }), runtime.principal);
    ok(sent);
    await waitFor(() => events.some(event => event.type === 'task.completed' && event.taskId === sent.taskId), 'remote approval', 25_000);
    const failed = events.find(event => (event.type === 'task.failed' || event.type === 'task.cancelled') && 'taskId' in event && event.taskId === sent.taskId);
    expect(failed, JSON.stringify(failed ?? events.filter(event => event.type === 'permission.requested' || event.type === 'task.failed'))).toBeUndefined();
    const audits = events.filter(event => event.type === 'grant.audited');
    expect(audits.length).toBeGreaterThanOrEqual(2);
    for (const event of audits) {
      if (event.type !== 'grant.audited') continue;
      expect(event.entry.via).toBe('interactive');
      expect(event.entry.decidedBy?.startsWith('device:')).toBe(true);
    }
    expect(await readFile(join(workspace, 'edited.txt'), 'utf8')).toBe('edited-by-agent\n');
    expect(await readFile(join(workspace, 'ran.txt'), 'utf8')).toBe('ok\n');
  });
});
