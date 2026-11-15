import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentRunContextV2, DesktopCommand, Principal, DesktopEvent, DesktopEventV2, JsonValue } from '@your-bot/contracts';
import { createGateway, createGatewayV2 } from './index.js';
import { agent, botInput, botSession, cleanupAll, cmd, createBot, decide, directory, executor, FakeDevices, finished, ok, owner, requested, send, setup } from './v2.fixtures.js';

afterEach(cleanupAll);

describe('v2 command validation', () => {
  it('rejects malformed v2 commands with INVALID_INPUT', async () => {
    const { gateway } = await setup();
    const bot = botInput();
    const cases: unknown[] = [
      { version: 3, id: 'x', type: 'state.sync' },
      { version: 2, id: 'x', type: 'unknown.command' },
      { version: 2, id: 'x', type: 'state.sync', extra: 1 },
      { version: 2, id: 'x', type: 'bot.create' },
      { version: 2, id: 'x', type: 'bot.create', bot: { ...bot, unexpected: true } },
      { version: 2, id: 'x', type: 'bot.create', bot: { ...bot, profile: 'root' } },
      { version: 2, id: 'x', type: 'bot.create', bot: { ...bot, workspace: 'relative/path' } },
      { version: 2, id: 'x', type: 'bot.create', bot: { ...bot, skills: ['Bad Skill'] } },
      { version: 2, id: 'x', type: 'bot.create', bot: { ...bot, compaction: { maxMessages: 10, keepRecent: 10 } } },
      { version: 2, id: 'x', type: 'bot.create', bot: { ...bot, mcpServers: [{ id: 'a__b', name: 'A', enabled: true, transport: 'stdio', command: 'x' }] } },
      { version: 2, id: 'x', type: 'bot.create', bot: { ...bot, mcpServers: [{ id: 'a', name: 'A', enabled: true, transport: 'stdio', command: 'x', url: 'https://x' }] } },
      { version: 2, id: 'x', type: 'bot.create', bot: { ...bot, mcpServers: [{ id: 'a', name: 'A', enabled: true, transport: 'http', url: 'https://user:pw@x/' }] } },
      { version: 2, id: 'x', type: 'bot.create', bot: { ...bot, mcpServers: [{ id: 'a', name: 'A', enabled: true, transport: 'http', url: 'file:///etc/passwd' }] } },
      { version: 2, id: 'x', type: 'bot.create', bot: { ...bot, mcpServers: [{ id: 'a', name: 'A', enabled: true, transport: 'stdio', command: 'x', env: { 'BAD-NAME': 'v' } }] } },
      { version: 2, id: 'x', type: 'bot.create', bot: { ...bot, mcpServers: [{ id: 'a', name: 'A', enabled: true, transport: 'stdio', command: 'x' }, { id: 'a', name: 'B', enabled: true, transport: 'stdio', command: 'y' }] } },
      { version: 2, id: 'x', type: 'bot.update', botId: 'b', patch: { id: 'spoofed' } },
      { version: 2, id: 'x', type: 'bot.update', botId: '../b', patch: {} },
      { version: 2, id: 'x', type: 'permission.decide', decision: { requestId: 'r', outcome: 'allow', scope: 'forever' } },
      { version: 2, id: 'x', type: 'permission.decide', decision: { requestId: 'r', outcome: 'allow', scope: 'standing' } },
      { version: 2, id: 'x', type: 'permission.decide', decision: { requestId: 'r', outcome: 'deny', scope: 'standing', standing: { folder: '/tmp' } } },
      { version: 2, id: 'x', type: 'permission.decide', decision: { requestId: 'r', outcome: 'allow', scope: 'once', standing: { folder: '/tmp' } } },
      { version: 2, id: 'x', type: 'permission.decide', decision: { requestId: 'r', outcome: 'allow', scope: 'standing', standing: { folder: '/tmp', paths: [] } } },
      { version: 2, id: 'x', type: 'grant.create', grant: { botId: 'b', capability: 'root', scope: {} } },
      { version: 2, id: 'x', type: 'grant.create', grant: { botId: 'b', capability: 'file.read', scope: { folder: 'relative' } } },
      { version: 2, id: 'x', type: 'grant.create', grant: { botId: 'b', capability: 'process.spawn', scope: { commandPrefix: [] } } },
      { version: 2, id: 'x', type: 'grant.create', grant: { botId: 'b', capability: 'file.read', scope: { folder: '/tmp' }, expiresAt: 'tomorrow' } },
      { version: 2, id: 'x', type: 'audit.list', limit: 0 },
      { version: 2, id: 'x', type: 'audit.list', limit: 501 },
      { version: 2, id: 'x', type: 'settings.update', settings: { providers: [{ id: 'p', name: 'P', kind: 'acp', enabled: true, launch: 'everywhere' }] } },
      { version: 2, id: 'x', type: 'settings.update', settings: { providers: [{ id: 'p', name: 'P', kind: 'acp', enabled: true, envPassthrough: ['NOT VALID'] }] } },
      { version: 2, id: 'x', type: 'routine.create', routine: { botId: 'b', name: 'R', prompt: 'p', schedule: { kind: 'cron', expression: '* * *' }, missedRunPolicy: 'skip', enabled: true, sessionMode: 'new' } },
      { version: 2, id: 'x', type: 'device.pair.start', capabilities: ['root'] },
      { version: 2, id: 'x', type: 'device.list', deviceId: 'extra' },
      { version: 2, id: 'x', type: 'tool.run', sessionId: 's', invocation: { id: 't', kind: 'python', input: null } },
      { version: 2, id: 'x', type: 'message.send', sessionId: 's' },
    ];
    for (const value of cases) expect(await gateway.dispatch(value as DesktopCommand, owner), JSON.stringify(value)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('keeps the v1 factory strictly v1 while the v2 factory accepts both versions', async () => {
    const v1 = await createGateway({ databasePath: ':memory:', localPrincipalId: owner.id, adapters: [agent('fake', undefined)], executor: executor() });
    try {
      expect(await v1.dispatch(cmd({ type: 'state.sync' }) as unknown as DesktopCommand, owner as unknown as Principal)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(() => (v1.subscribe as (...args: unknown[]) => unknown)(() => {}, owner, { contractVersion: 2 })).toThrow('Unsupported contract version');
    } finally { await v1.close(); }
    const { gateway } = await setup();
    ok(await gateway.dispatch({ version: 1, id: 'v1-sync', type: 'state.sync' }, owner));
    ok(await gateway.dispatch(cmd({ type: 'state.sync' }), owner));
  });

  it('returns NOT_SUPPORTED for commands owned by later packages and for devices without a DeviceManager', async () => {
    const { gateway } = await setup(); const bot = await createBot(gateway, botInput({ agentId: 'fake' }));
    for (const payload of [
      { type: 'memory.list' as const, botId: bot.id }, { type: 'skills.refresh' as const }, { type: 'notification.ack' as const, notificationId: 'n' },
      { type: 'routine.runNow' as const, routineId: 'r' }, { type: 'device.list' as const },
    ]) expect(await gateway.dispatch(cmd(payload), owner)).toMatchObject({ ok: false, error: { code: 'NOT_SUPPORTED' } });
  });
});

describe('versioned events', () => {
  it('never delivers v2 events or v2 fields to v1 subscribers, and tags events with their defining version', async () => {
    const run = vi.fn(async (context: AgentRunContextV2) => {
      await context.requestPermission({ capability: 'tool.execute', reason: 'edit', agentTool: { toolCallId: 'c', title: 'Edit', kind: 'edit' } });
    });
    const ws = await directory();
    const f = await setup({ adapters: [agent('host-agent', ['trusted'], run)] });
    const bot = await createBot(f.gateway, botInput({ profile: 'trusted', workspace: ws }));
    const sessionId = await botSession(f.gateway, bot.id);
    const taskId = await send(f.gateway, sessionId);
    ok(await decide(f.gateway, (await requested(f.events)).id));
    await finished(f.events, taskId);
    ok(await f.gateway.dispatch(cmd({ type: 'state.sync', afterSequence: 0 }), owner));
    const v1 = f.v1Events as unknown as DesktopEvent[];
    const v1Types = new Set(['state.snapshot', 'session.updated', 'session.deleted', 'task.started', 'message.delta', 'task.status', 'task.completed', 'task.cancelled', 'task.failed', 'permission.requested', 'permission.resolved', 'tool.output', 'agents.updated']);
    expect(v1.length).toBeGreaterThan(0);
    expect(v1.every(event => v1Types.has(event.type) && event.version === 1)).toBe(true);
    expect(JSON.stringify(v1)).not.toContain('botId');
    expect(JSON.stringify(v1)).not.toContain('agentTool');
    expect(v1.find(event => event.type === 'state.snapshot')).not.toHaveProperty('snapshot.bots');
    // v2 subscribers see bot/grant/audit events (version 2) and v2-shaped payloads.
    expect(f.events.find(event => event.type === 'bot.updated')?.version).toBe(2);
    expect(f.events.find(event => event.type === 'grant.audited')?.version).toBe(2);
    expect(f.events.find(event => event.type === 'session.updated')).toMatchObject({ version: 1, session: { botId: bot.id } });
    expect(f.events.find(event => event.type === 'permission.requested')).toMatchObject({ request: { botId: bot.id, agentTool: { kind: 'edit' } } });
    expect(f.events.find(event => event.type === 'state.snapshot')).toMatchObject({ snapshot: { bots: [{ id: bot.id }], routines: [], routineRuns: [], notifications: [], skills: [], devices: [] } });
  });
});

describe('bots and sessions', () => {
  it('binds v1 session.create to a per-agent default strict bot and follows agent switches', async () => {
    const f = await setup({ adapters: [agent('fake', undefined), agent('other', undefined)] });
    const first = await f.gateway.dispatch({ version: 1, id: 's1', type: 'session.create', agentId: 'fake' }, owner); ok(first);
    expect(first.session).not.toHaveProperty('botId');
    const second = await f.gateway.dispatch(cmd({ type: 'session.create', agentId: 'fake' }), owner); ok(second);
    const sync = await f.gateway.dispatch(cmd({ type: 'state.sync' }), owner); ok(sync);
    const defaults = sync.snapshot!.bots;
    expect(defaults).toHaveLength(1); expect(defaults[0]).toMatchObject({ agentId: 'fake', profile: 'strict', name: 'Agent fake', mcpServers: [] });
    expect(sync.snapshot!.sessions.map(session => session.botId)).toEqual([defaults[0].id, defaults[0].id]);
    const switched = await f.gateway.dispatch(cmd({ type: 'session.selectAgent', sessionId: second.sessionId!, agentId: 'other' }), owner); ok(switched);
    expect(switched.session!.botId).not.toBe(defaults[0].id);
    // A custom bot keeps its sessions when the agent changes.
    const custom = await createBot(f.gateway, botInput({ agentId: 'fake' }));
    const customSession = await botSession(f.gateway, custom.id);
    const kept = await f.gateway.dispatch(cmd({ type: 'session.selectAgent', sessionId: customSession, agentId: 'other' }), owner); ok(kept);
    expect(kept.session!.botId).toBe(custom.id);
  });

  it('migrates existing v1 sessions to default bots on startup', async () => {
    const path = join(await directory(), 'data', 'gateway.sqlite');
    const first = await createGateway({ databasePath: path, localPrincipalId: owner.id, adapters: [agent('fake', undefined)], executor: executor() });
    await first.close();
    const db = new DatabaseSync(path);
    const legacy = { id: 'legacy', title: 'Old', agentId: 'fake', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z', messages: [] };
    db.prepare('INSERT INTO sessions(id,owner,value) VALUES (?,?,?)').run('legacy', owner.id, JSON.stringify(legacy)); db.close();
    const gateway = await createGatewayV2({ databasePath: path, localPrincipalId: owner.id, adapters: [agent('fake', undefined)], executor: executor() });
    try {
      const sync = await gateway.dispatch(cmd({ type: 'state.sync' }), owner); ok(sync);
      const bot = sync.snapshot!.bots.find(entry => entry.agentId === 'fake')!;
      expect(sync.snapshot!.sessions).toMatchObject([{ id: 'legacy', botId: bot.id }]);
      const created = await gateway.dispatch(cmd({ type: 'session.create', agentId: 'fake' }), owner); ok(created);
      expect(created.session!.botId).toBe(bot.id);
    } finally { await gateway.close(); }
  });

  it('creates, updates and deletes bots; trusted requires a canonical existing directory', async () => {
    const f = await setup();
    const real = await directory(); const link = join(await directory(), 'link'); await symlink(real, link);
    const file = join(real, 'file.txt'); await writeFile(file, 'x');
    for (const workspace of [undefined, join(real, 'missing'), file]) {
      expect(await f.gateway.dispatch(cmd({ type: 'bot.create', bot: botInput({ profile: 'trusted', ...(workspace ? { workspace } : {}) }) }), owner)).toMatchObject({ ok: false, error: { code: 'INVALID_WORKSPACE' } });
    }
    const bot = await createBot(f.gateway, botInput({ profile: 'trusted', workspace: link, instructions: 'Be terse', modelId: 'model' }));
    expect(bot.workspace).toBe(real);
    const updated = await f.gateway.dispatch(cmd({ type: 'bot.update', botId: bot.id, patch: { name: 'Renamed', modelId: '' } }), owner); ok(updated);
    expect(updated.bot).toMatchObject({ id: bot.id, name: 'Renamed', instructions: 'Be terse', workspace: real, createdAt: bot.createdAt });
    expect(updated.bot).not.toHaveProperty('modelId');
    expect(await f.gateway.dispatch(cmd({ type: 'bot.update', botId: bot.id, patch: { workspace: '' } }), owner)).toMatchObject({ ok: false, error: { code: 'INVALID_WORKSPACE' } });
    const downgraded = await f.gateway.dispatch(cmd({ type: 'bot.update', botId: bot.id, patch: { profile: 'strict', workspace: '' } }), owner); ok(downgraded);
    expect(downgraded.bot).not.toHaveProperty('workspace');
    // Delete cascades sessions (cancelling their tasks) and revokes grants; audit history remains.
    await mkdir(join(real, 'docs'));
    const sessionId = await botSession(f.gateway, bot.id);
    ok(await f.gateway.dispatch(cmd({ type: 'bot.update', botId: bot.id, patch: { workspace: real } }), owner));
    const grant = await f.gateway.dispatch(cmd({ type: 'grant.create', grant: { botId: bot.id, capability: 'file.read', scope: { folder: join(real, 'docs') } } }), owner); ok(grant);
    ok(await f.gateway.dispatch(cmd({ type: 'bot.delete', botId: bot.id }), owner));
    expect(await f.gateway.dispatch(cmd({ type: 'session.open', sessionId }), owner)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(f.events.some(event => event.type === 'bot.deleted' && event.botId === bot.id)).toBe(true);
    expect(f.events.some(event => event.type === 'session.deleted' && event.sessionId === sessionId)).toBe(true);
    expect(f.events.filter(event => event.type === 'grant.updated').at(-1)).toMatchObject({ grant: { id: grant.grant!.id, revokedBy: owner.id } });
    expect(await f.gateway.dispatch(cmd({ type: 'bot.session.create', botId: bot.id }), owner)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    // Bots belong to their owner.
    const stranger = { id: 'stranger', kind: 'remote' as const, capabilities: owner.capabilities };
    const other = await createBot(f.gateway, botInput({ agentId: 'fake' }));
    expect(await f.gateway.dispatch(cmd({ type: 'bot.update', botId: other.id, patch: { name: 'x' } }), stranger)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await f.gateway.dispatch(cmd({ type: 'bot.create', bot: botInput() }), { ...owner, capabilities: ['conversation'] })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('delivers bot instructions and persists bounded adapter state per (owner, session, adapter), deleted with the session', async () => {
    const contexts: AgentRunContextV2[] = []; const values: (JsonValue | undefined)[] = []; const errors: string[] = [];
    const f = await setup({ adapters: [agent('fake', undefined, async context => {
      contexts.push(context); values.push(await context.state.get());
      await context.state.set({ acpSessionId: 'abc', count: values.length });
      await context.state.set('x'.repeat(70_000)).catch(error => errors.push(error.code));
    })] });
    const bot = await createBot(f.gateway, botInput({ agentId: 'fake', instructions: 'Answer in French' }));
    const sessionId = await botSession(f.gateway, bot.id);
    await finished(f.events, await send(f.gateway, sessionId));
    await finished(f.events, await send(f.gateway, sessionId));
    expect(values).toEqual([undefined, { acpSessionId: 'abc', count: 1 }]); expect(errors).toEqual(['LIMIT_EXCEEDED', 'LIMIT_EXCEEDED']);
    expect(contexts[0]).toMatchObject({ instructions: 'Answer in French', profile: 'strict', bot: { id: bot.id }, session: { botId: bot.id } });
    const other = await botSession(f.gateway, bot.id);
    await finished(f.events, await send(f.gateway, other));
    expect(values[2]).toBeUndefined();
    ok(await f.gateway.dispatch(cmd({ type: 'session.delete', sessionId }), owner));
    await expect(contexts[0].state.get()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('snapshot, host identity and devices', () => {
  it('returns v2 snapshot fields with a persisted host identity and routes device commands for the local owner', async () => {
    const path = join(await directory(), 'data', 'gateway.sqlite'); const devices = new FakeDevices();
    const make = (host?: {id: string; name: string}) => createGatewayV2({ databasePath: path, localPrincipalId: owner.id, executor: executor(), devices, ...(host ? { host } : {}) });
    let gateway = await make();
    const first = await gateway.dispatch(cmd({ type: 'state.sync' }), owner); ok(first);
    expect(first.snapshot!.host.id).toMatch(/^[0-9a-f-]{36}$/); expect(first.snapshot!.host.name.length).toBeGreaterThan(0);
    const pairing = await gateway.dispatch(cmd({ type: 'device.pair.start', name: 'Phone', capabilities: ['conversation'] }), owner); ok(pairing);
    expect(pairing.pairing?.code).toBe('ybp1.secret');
    const listed = await gateway.dispatch(cmd({ type: 'device.list' }), owner); ok(listed); expect(listed.devices?.map(entry => entry.id)).toEqual(['phone']);
    await gateway.close();
    gateway = await make();
    const second = await gateway.dispatch(cmd({ type: 'state.sync' }), owner); ok(second); expect(second.snapshot!.host.id).toBe(first.snapshot!.host.id);
    await gateway.close();
    gateway = await make({ id: 'configured', name: 'Workstation' });
    try {
      const third = await gateway.dispatch(cmd({ type: 'state.sync' }), owner); ok(third);
      expect(third.snapshot!.host).toEqual({ id: 'configured', name: 'Workstation' });
      expect(third.snapshot).toMatchObject({ routines: [], routineRuns: [], notifications: [], skills: [], grants: [], devices: [{ id: 'phone' }] });
    } finally { await gateway.close(); }
  });

  it('preserves v2 provider launch fields across v1 settings updates', async () => {
    const reload = vi.fn(async () => undefined);
    const { gateway } = await setup({ onSettingsChanged: reload });
    ok(await gateway.dispatch(cmd({ type: 'settings.update', settings: { providers: [{ id: 'g', name: 'Grok', kind: 'acp', enabled: true, command: 'grok', launch: 'host', envPassthrough: ['GROK_API_KEY'] }] } }), owner));
    ok(await gateway.dispatch({ version: 1, id: 'v1-settings', type: 'settings.update', settings: { providers: [{ id: 'g', name: 'Grok renamed', kind: 'acp', enabled: true, command: 'grok' }] } }, owner));
    expect((reload.mock.calls.at(-1) as unknown[])[0]).toMatchObject({ providers: [{ name: 'Grok renamed', launch: 'host', envPassthrough: ['GROK_API_KEY'] }] });
    const v1 = await gateway.dispatch({ version: 1, id: 'v1-sync-settings', type: 'state.sync' }, owner); ok(v1);
    expect(v1.snapshot!.settings.providers[0]).not.toHaveProperty('launch');
  });
});
