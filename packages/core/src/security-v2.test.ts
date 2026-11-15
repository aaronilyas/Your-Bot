import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRunContextV2, AppSettingsV2, DesktopEventV2, GrantAuditEntry, PermissionRequestV2, PrincipalV2 } from '@your-bot/contracts';
import { createGatewayV2, isWithin } from './index.js';
import {
  agent, audits, botInput, botSession, cipher, cleanupAll, cmd, createBot, decide, device, directory, executor, FakeBroker, FakeDevices,
  FakeHost, finished, gate, ok, owner, requested, send, setup, stranger, type Run,
} from './v2.fixtures.js';

afterEach(cleanupAll);

/** Trusted bot over a real temporary workspace with a fake WorkspaceHost. */
async function trustedFixture(run: Run, extra: Parameters<typeof setup>[0] = {}, principals: PrincipalV2[] = [owner]) {
  const workspace = await directory(); const host = new FakeHost();
  const trustedAgent = agent('host-agent', ['trusted'], run);
  const f = await setup({ adapters: [agent('fake', undefined), trustedAgent], workspaceHost: host, ...extra }, principals);
  const bot = await createBot(f.gateway, botInput({ profile: 'trusted', workspace }));
  const sessionId = await botSession(f.gateway, bot.id);
  return { ...f, workspace, host, bot, sessionId, trustedAgent };
}
/** Auto-answers every permission request with `outcome` and records it. */
function responder(f: Awaited<ReturnType<typeof setup>>, outcome: 'allow' | 'deny') {
  const seen: PermissionRequestV2[] = [];
  f.gateway.subscribe(event => {
    if (event.type !== 'permission.requested') return;
    seen.push(event.request as PermissionRequestV2);
    void decide(f.gateway, event.request.id, owner, outcome);
  }, owner, { contractVersion: 2 });
  return seen;
}
const codeOf = (error: unknown) => (error as {code?: string}).code ?? 'UNKNOWN';

describe('identity and owner-based data model', () => {
  it('rejects local principals with foreign ids or any ownerId, and remote principals claiming the local id or a foreign owner', async () => {
    const { gateway } = await setup();
    for (const principal of [
      { ...owner, id: 'someone-else' }, { ...owner, ownerId: 'owner' }, { ...owner, deviceId: 'x' },
      { ...device, id: owner.id }, { ...device, ownerId: 'another-owner' }, { ...device, kind: 'local' as const },
    ]) expect(await gateway.dispatch(cmd({ type: 'state.sync' }), principal)).toMatchObject({ ok: false, error: { code: 'IDENTITY_MISMATCH' } });
    ok(await gateway.dispatch(cmd({ type: 'state.sync' }), device));
  });

  it('lets a paired device see and decide owner approvals and cancel owner tasks, but never owner-only actions', async () => {
    const devices = new FakeDevices();
    const ws = await directory();
    const f = await setup({ devices, executor: executor() }, [owner]);
    const deviceEvents: DesktopEventV2[] = []; f.gateway.subscribe(event => deviceEvents.push(event), device, { contractVersion: 2 });
    const strangerEvents: DesktopEventV2[] = []; f.gateway.subscribe(event => strangerEvents.push(event), stranger, { contractVersion: 2 });
    // Owner data is visible to the device.
    const created = await f.gateway.dispatch(cmd({ type: 'session.create', agentId: 'fake' }), owner); ok(created);
    const sessionId = created.sessionId!;
    const toolTask = await f.gateway.dispatch(cmd({ type: 'tool.run', sessionId, invocation: { id: 'calc', kind: 'skill', skillId: 'calculation', input: null } }), owner); ok(toolTask);
    const request = await requested(deviceEvents, r => r.capability === 'tool.execute');
    expect(strangerEvents.some(event => event.type === 'permission.requested')).toBe(false);
    expect(await decide(f.gateway, request.id, stranger)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    ok(await decide(f.gateway, request.id, device));
    expect((await finished(deviceEvents, toolTask.taskId!)).type).toBe('task.completed');
    expect(audits(f.events).find(entry => entry.requestId === request.id)).toMatchObject({ via: 'interactive', outcome: 'allow', decidedBy: device.id });
    // Device can cancel an owner task.
    const longTask = await f.gateway.dispatch(cmd({ type: 'tool.run', sessionId, invocation: { id: 'calc2', kind: 'skill', skillId: 'calculation', input: null } }), owner); ok(longTask);
    await requested(deviceEvents, r => r.taskId === longTask.taskId);
    ok(await f.gateway.dispatch(cmd({ type: 'task.cancel', taskId: longTask.taskId! }), device));
    expect((await finished(f.events, longTask.taskId!)).type).toBe('task.cancelled');
    // Owner-only operations fail even though the device holds every capability.
    const trusted = await createBot(f.gateway, botInput({ profile: 'trusted', workspace: ws }));
    const strict = await createBot(f.gateway, botInput({ name: 'Device bot' }), device);
    const settings: AppSettingsV2 = { providers: [] };
    for (const payload of [
      { type: 'settings.update' as const, settings },
      { type: 'bot.create' as const, bot: botInput({ profile: 'trusted', workspace: ws }) },
      { type: 'bot.update' as const, botId: strict.id, patch: { profile: 'trusted' as const, workspace: ws } },
      { type: 'bot.update' as const, botId: trusted.id, patch: { workspace: await directory() } },
      { type: 'bot.update' as const, botId: trusted.id, patch: { mcpServers: [{ id: 'x', name: 'X', enabled: true, transport: 'stdio' as const, command: '/bin/true' }] } },
      { type: 'device.list' as const }, { type: 'device.pair.start' as const }, { type: 'device.revoke' as const, deviceId: 'phone' },
    ]) expect(await f.gateway.dispatch(cmd(payload), device)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const trustedSession = await botSession(f.gateway, trusted.id);
    expect(await f.gateway.dispatch(cmd({ type: 'session.selectAgent', sessionId: trustedSession, agentId: 'fake' }), device)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    // Non-owner-only management stays possible with the settings capability.
    ok(await f.gateway.dispatch(cmd({ type: 'bot.update', botId: trusted.id, patch: { instructions: 'Be careful' } }), device));
    // Snapshots: devices/settings for the local owner only; device revocation events never reach devices.
    const deviceSync = await f.gateway.dispatch(cmd({ type: 'state.sync' }), device); ok(deviceSync);
    expect(deviceSync.snapshot!.devices).toEqual([]); expect(deviceSync.snapshot!.settings.providers).toEqual([]);
    expect(deviceSync.snapshot!.bots.map(bot => bot.id)).toEqual(expect.arrayContaining([trusted.id, strict.id]));
    const ownerSync = await f.gateway.dispatch(cmd({ type: 'state.sync' }), owner); ok(ownerSync);
    expect(ownerSync.snapshot!.devices.map(entry => entry.id)).toEqual(['phone']);
    ok(await f.gateway.dispatch(cmd({ type: 'device.revoke', deviceId: 'phone' }), owner));
    expect(f.events.some(event => event.type === 'device.updated')).toBe(true);
    expect(deviceEvents.some(event => event.type === 'device.updated')).toBe(false);
    // Snapshots are delivered only to the principal that synced.
    expect(deviceEvents.filter(event => event.type === 'state.snapshot')).toHaveLength(1);
  });
});

describe('standing grants', () => {
  it('matches canonical folders by segment: allows inside, prompts for sibling/prefix/symlink paths, refuses workspace escapes', async () => {
    const results: string[] = [];
    let paths: string[] = [];
    const f = await trustedFixture(async context => {
      for (const path of paths) {
        try { await context.host!.readTextFile({ path }); results.push('ok'); } catch (error) { results.push(codeOf(error)); }
      }
    });
    const outside = await directory(); await writeFile(join(outside, 'secret.txt'), 'outside');
    const ws = f.workspace;
    await mkdir(join(ws, 'docs')); await mkdir(join(ws, 'docs-private')); await mkdir(join(ws, 'other'));
    await writeFile(join(ws, 'docs', 'a.txt'), 'a'); await writeFile(join(ws, 'docs-private', 'x.txt'), 'x'); await writeFile(join(ws, 'other', 's.txt'), 's');
    await symlink(join(ws, 'other', 's.txt'), join(ws, 'docs', 'link.txt'));
    await symlink(join(outside, 'secret.txt'), join(ws, 'docs', 'escape.txt'));
    paths = ['docs/a.txt', 'docs-private/x.txt', join(ws, 'other', 's.txt'), 'docs/link.txt', 'docs/escape.txt', '../' + outside.split('/').pop() + '/secret.txt'];
    const grant = await f.gateway.dispatch(cmd({ type: 'grant.create', grant: { botId: f.bot.id, capability: 'file.read', scope: { folder: join(ws, 'docs') } } }), owner); ok(grant);
    const prompted = responder(f, 'deny');
    const taskId = await send(f.gateway, f.sessionId);
    expect((await finished(f.events, taskId)).type).toBe('task.completed');
    expect(results).toEqual(['ok', 'PERMISSION_DENIED', 'PERMISSION_DENIED', 'PERMISSION_DENIED', 'OUTSIDE_WORKSPACE', 'OUTSIDE_WORKSPACE']);
    expect(prompted.map(request => request.paths![0].path)).toEqual([join(ws, 'docs-private', 'x.txt'), join(ws, 'other', 's.txt'), join(ws, 'other', 's.txt')]);
    expect(f.host.calls).toEqual([`read ${join(ws, 'docs', 'a.txt')}`]);
    const entries = audits(f.events);
    expect(entries[0]).toMatchObject({ via: 'standing', outcome: 'allow', grantId: grant.grant!.id, subject: join(ws, 'docs', 'a.txt'), decidedBy: owner.id });
    expect(entries.filter(entry => entry.via === 'policy' && entry.outcome === 'deny')).toHaveLength(2);
  });

  it('compares segments, never prefixes, and ignores case only on win32/darwin', () => {
    expect(isWithin('/a/b', '/a/b', 'linux')).toBe(true);
    expect(isWithin('/a/b', '/a/b/c', 'linux')).toBe(true);
    expect(isWithin('/a/b/', '/a/b/c', 'linux')).toBe(true);
    expect(isWithin('/a/b', '/a/bc', 'linux')).toBe(false);
    expect(isWithin('/a/b', '/a', 'linux')).toBe(false);
    expect(isWithin('/A/b', '/a/B/c', 'linux')).toBe(false);
    expect(isWithin('/A/b', '/a/B/c', 'darwin')).toBe(true);
    expect(isWithin('C:\\Work', 'c:\\work\\x.txt', 'win32')).toBe(true);
    expect(isWithin('C:\\Work', 'C:\\Workspace\\x.txt', 'win32')).toBe(false);
    expect(isWithin('C:\\', 'C:\\x', 'win32')).toBe(true);
    expect(isWithin('/', '/etc', 'linux')).toBe(true);
  });

  it('revocation applies to the next request inside a running task', async () => {
    const paused = gate(); const resumed = gate(); const results: string[] = [];
    const f = await trustedFixture(async context => {
      results.push((await context.host!.readTextFile({ path: 'a.txt' })).content);
      paused.open(); await resumed.promise;
      results.push((await context.host!.readTextFile({ path: 'a.txt' })).content);
    });
    await writeFile(join(f.workspace, 'a.txt'), 'content');
    const grant = await f.gateway.dispatch(cmd({ type: 'grant.create', grant: { botId: f.bot.id, capability: 'file.read', scope: { folder: f.workspace } } }), owner); ok(grant);
    const taskId = await send(f.gateway, f.sessionId);
    await paused.promise;
    expect(f.events.some(event => event.type === 'permission.requested')).toBe(false);
    const revoked = await f.gateway.dispatch(cmd({ type: 'grant.revoke', grantId: grant.grant!.id }), owner); ok(revoked);
    expect(revoked.grant!.revokedAt).toBeDefined();
    resumed.open();
    const request = await requested(f.events, r => r.capability === 'file.read');
    ok(await decide(f.gateway, request.id));
    expect((await finished(f.events, taskId)).type).toBe('task.completed');
    expect(results).toEqual(['content', 'content']);
    expect(audits(f.events).map(entry => entry.via)).toEqual(['standing', 'interactive']);
    const sync = await f.gateway.dispatch(cmd({ type: 'state.sync' }), owner); ok(sync); expect(sync.snapshot!.grants).toEqual([]);
  });

  it('rejects forbidden standing types and malformed or out-of-workspace scopes', async () => {
    const ws = await directory(); await mkdir(join(ws, 'inner'));
    const f = await setup();
    const trusted = await createBot(f.gateway, botInput({ profile: 'trusted', workspace: ws }));
    const strict = await createBot(f.gateway, botInput({ agentId: 'fake' }));
    const outside = await directory();
    const cases: [Parameters<typeof cmd>[0], string][] = [
      [{ type: 'grant.create', grant: { botId: trusted.id, capability: 'library.install', scope: {} } }, 'STANDING_FORBIDDEN'],
      [{ type: 'grant.create', grant: { botId: trusted.id, capability: 'network', scope: {} } }, 'STANDING_FORBIDDEN'],
      [{ type: 'grant.create', grant: { botId: trusted.id, capability: 'settings', scope: {} } }, 'STANDING_FORBIDDEN'],
      [{ type: 'grant.create', grant: { botId: trusted.id, capability: 'conversation', scope: {} } }, 'STANDING_FORBIDDEN'],
      [{ type: 'grant.create', grant: { botId: trusted.id, capability: 'tool.execute', scope: {} } }, 'INVALID_INPUT'],
      [{ type: 'grant.create', grant: { botId: trusted.id, capability: 'file.read', scope: {} } }, 'INVALID_INPUT'],
      [{ type: 'grant.create', grant: { botId: trusted.id, capability: 'file.read', scope: { folder: ws, commandPrefix: ['ls'] } } }, 'INVALID_INPUT'],
      [{ type: 'grant.create', grant: { botId: trusted.id, capability: 'file.read', scope: { folder: outside } } }, 'OUTSIDE_WORKSPACE'],
      [{ type: 'grant.create', grant: { botId: trusted.id, capability: 'file.read', scope: { folder: join(ws, 'missing') } } }, 'INVALID_INPUT'],
      [{ type: 'grant.create', grant: { botId: trusted.id, capability: 'process.spawn', scope: { commandPrefix: ['git'], folder: outside } } }, 'OUTSIDE_WORKSPACE'],
      [{ type: 'grant.create', grant: { botId: trusted.id, capability: 'mcp.call', scope: { mcp: { serverId: 'unknown' } } } }, 'NOT_FOUND'],
      [{ type: 'grant.create', grant: { botId: strict.id, capability: 'file.read', scope: { folder: ws } } }, 'INVALID_INPUT'],
      [{ type: 'grant.create', grant: { botId: trusted.id, capability: 'file.read', scope: { folder: ws }, expiresAt: '2000-01-01T00:00:00Z' } }, 'INVALID_INPUT'],
    ];
    for (const [payload, code] of cases) expect(await f.gateway.dispatch(cmd(payload), owner), JSON.stringify(payload)).toMatchObject({ ok: false, error: { code } });
    ok(await f.gateway.dispatch(cmd({ type: 'grant.create', grant: { botId: trusted.id, capability: 'file.read', scope: { folder: join(ws, 'inner') } } }), owner));
    // A custom Python approval can never become standing, even through a decision.
    const sessionId = await botSession(f.gateway, strict.id);
    const run = await f.gateway.dispatch(cmd({ type: 'tool.run', sessionId, invocation: { id: 'py', kind: 'python', input: null, code: 'result = 1' } }), owner); ok(run);
    const request = await requested(f.events, r => r.capability === 'tool.execute');
    expect(await f.gateway.dispatch(cmd({ type: 'permission.decide', decision: { requestId: request.id, outcome: 'allow', scope: 'standing', standing: { agentToolKind: 'edit' } } }), owner)).toMatchObject({ ok: false, error: { code: 'STANDING_FORBIDDEN' } });
    ok(await decide(f.gateway, request.id, owner, 'deny'));
    await finished(f.events, run.taskId!);
  });

  it('audits standing, interactive and policy decisions, pages newest first, and hides audit events from v1 subscribers', async () => {
    const f = await trustedFixture(async context => {
      await context.host!.readTextFile({ path: 'docs/a.txt' });
      await context.host!.readTextFile({ path: 'b.txt' });
      await context.host!.readTextFile({ path: '/etc/hostname' }).catch(() => undefined);
    });
    await mkdir(join(f.workspace, 'docs')); await writeFile(join(f.workspace, 'docs', 'a.txt'), 'a'); await writeFile(join(f.workspace, 'b.txt'), 'b');
    ok(await f.gateway.dispatch(cmd({ type: 'grant.create', grant: { botId: f.bot.id, capability: 'file.read', scope: { folder: join(f.workspace, 'docs') } } }), owner));
    responder(f, 'allow');
    const taskId = await send(f.gateway, f.sessionId); await finished(f.events, taskId);
    const listed = await f.gateway.dispatch(cmd({ type: 'audit.list', botId: f.bot.id }), owner); ok(listed);
    expect(listed.audit!.map(entry => entry.via)).toEqual(['policy', 'interactive', 'standing']);
    expect(listed.audit!.every((entry: GrantAuditEntry) => entry.botId === f.bot.id && entry.taskId === taskId && entry.sessionId === f.sessionId)).toBe(true);
    const page = await f.gateway.dispatch(cmd({ type: 'audit.list', limit: 1, beforeId: listed.audit![0].id }), owner); ok(page);
    expect(page.audit!.map(entry => entry.id)).toEqual([listed.audit![1].id]);
    expect(await f.gateway.dispatch(cmd({ type: 'audit.list', beforeId: 'missing' }), owner)).toMatchObject({ ok: false, error: { code: 'INVALID_CURSOR' } });
    expect(f.v1Events.some(event => (event.type as string) === 'grant.audited')).toBe(false);
    expect(audits(f.events).filter(entry => entry.taskId === taskId)).toHaveLength(3);
    const strangerList = await f.gateway.dispatch(cmd({ type: 'audit.list' }), stranger); ok(strangerList); expect(strangerList.audit).toEqual([]);
  });
});

describe('workspace host channel', () => {
  it('denies outside-workspace paths by policy without prompting or touching the host', async () => {
    const outside = await directory(); await writeFile(join(outside, 'x.txt'), 'x');
    const results: string[] = [];
    const f = await trustedFixture(async context => {
      for (const operation of [
        () => context.host!.readTextFile({ path: join(outside, 'x.txt') }),
        () => context.host!.writeTextFile({ path: '../escape.txt', content: 'bad' }),
        () => context.host!.createTerminal({ command: 'ls', cwd: outside }),
      ]) { try { await operation(); results.push('ok'); } catch (error) { results.push(codeOf(error)); } }
    });
    const taskId = await send(f.gateway, f.sessionId); await finished(f.events, taskId);
    expect(results).toEqual(['OUTSIDE_WORKSPACE', 'OUTSIDE_WORKSPACE', 'OUTSIDE_WORKSPACE']);
    expect(f.events.some(event => event.type === 'permission.requested')).toBe(false);
    expect(f.host.calls).toEqual([]);
    expect(audits(f.events).map(entry => [entry.via, entry.outcome, entry.capability])).toEqual([['policy', 'deny', 'file.read'], ['policy', 'deny', 'file.write'], ['policy', 'deny', 'process.spawn']]);
  });

  it('authorizes writes and commands with canonical paths before performing, binds terminals to the task, and releases them at task end', async () => {
    const results: unknown[] = []; let firstTerminal = '';
    const f = await trustedFixture(async context => {
      await context.host!.writeTextFile({ path: 'out.txt', content: 'written' });
      const { terminalId } = await context.host!.createTerminal({ command: 'git', args: ['status', '--short'], cwd: 'sub' });
      firstTerminal = terminalId;
      results.push(await context.host!.terminalOutput(terminalId));
      results.push(await context.host!.waitForTerminalExit(terminalId));
      for (const foreign of ['term-999', '']) await context.host!.terminalOutput(foreign).catch(error => results.push(codeOf(error)));
      await context.host!.createTerminal({ command: 'git', args: ['log'], cwd: 'sub' });
      await context.host!.createTerminal({ command: 'git', args: ['log'], cwd: 'sub', env: [{ name: 'GIT_PAGER', value: 'cat' }] });
      await context.host!.releaseTerminal(terminalId);
      await context.host!.terminalOutput(terminalId).catch(error => results.push(codeOf(error)));
    });
    await mkdir(join(f.workspace, 'sub'));
    // `git log …` is covered by a standing prefix; `git status` is not, and env variables always prompt.
    ok(await f.gateway.dispatch(cmd({ type: 'grant.create', grant: { botId: f.bot.id, capability: 'process.spawn', scope: { commandPrefix: ['git', 'log'], folder: join(f.workspace, 'sub') } } }), owner));
    const prompted = responder(f, 'allow');
    const taskId = await send(f.gateway, f.sessionId);
    expect((await finished(f.events, taskId)).type).toBe('task.completed');
    expect(await readFile(join(f.workspace, 'out.txt'), 'utf8')).toBe('written');
    expect(prompted.map(request => request.capability)).toEqual(['file.write', 'process.spawn', 'process.spawn']);
    expect(prompted[0].paths).toEqual([{ path: join(f.workspace, 'out.txt'), access: 'write' }]);
    expect(prompted[1].command).toEqual({ command: 'git', args: ['status', '--short'], cwd: join(f.workspace, 'sub') });
    expect(prompted[2].reason).toContain('GIT_PAGER=cat');
    expect(results).toEqual([{ output: 'out', truncated: false }, { exitCode: 0, signal: null }, 'TERMINAL_NOT_FOUND', 'INVALID_INPUT', 'TERMINAL_NOT_FOUND']);
    expect(f.host.calls.indexOf(`write ${join(f.workspace, 'out.txt')}`)).toBe(0);
    expect(f.host.calls).toContain(`release ${firstTerminal}`);
    await vi.waitFor(() => expect(f.host.released).toEqual([taskId]));
    expect(audits(f.events).filter(entry => entry.capability === 'process.spawn').map(entry => entry.via)).toEqual(['interactive', 'standing', 'interactive']);
  });
});

describe('execution profiles', () => {
  it('never gives a strict bot host, workspace or MCP access even when all services are configured', async () => {
    const ws = await directory(); const broker = new FakeBroker(); const host = new FakeHost();
    let strictContext!: AgentRunContextV2; let trustedContext!: AgentRunContextV2;
    const strictAgent = agent('fake', undefined, async context => { strictContext = context; });
    const trustedAgent = agent('both', ['strict', 'trusted'], async context => { trustedContext = context; });
    const f = await setup({ adapters: [strictAgent, trustedAgent], workspaceHost: host, mcpBroker: broker });
    const servers = [{ id: 'files', name: 'Files', enabled: true, transport: 'stdio' as const, command: '/usr/bin/files-mcp' }];
    const strictBot = await createBot(f.gateway, botInput({ agentId: 'fake', workspace: ws, mcpServers: servers }));
    const strictOnBoth = await createBot(f.gateway, botInput({ agentId: 'both', workspace: ws, mcpServers: servers }));
    for (const bot of [strictBot, strictOnBoth]) {
      const taskId = await send(f.gateway, await botSession(f.gateway, bot.id)); expect((await finished(f.events, taskId)).type).toBe('task.completed');
    }
    for (const context of [strictContext, trustedContext]) {
      expect(context.profile).toBe('strict');
      expect(context.host).toBeUndefined(); expect(context.workspace).toBeUndefined(); expect(context.mcp).toBeUndefined();
    }
    expect(broker.sessions).toEqual([]);
    // Positive control: the same agent gets all three for a trusted bot.
    const trustedBot = await createBot(f.gateway, botInput({ agentId: 'both', profile: 'trusted', workspace: ws, mcpServers: servers }));
    const taskId = await send(f.gateway, await botSession(f.gateway, trustedBot.id)); await finished(f.events, taskId);
    expect(trustedContext.profile).toBe('trusted'); expect(trustedContext.workspace).toBe(ws);
    expect(trustedContext.host).toBeDefined(); expect(trustedContext.mcp?.url).toBe('http://127.0.0.1:9/mcp');
    expect(broker.sessions).toHaveLength(1);
  });

  it('fails PROFILE_UNSUPPORTED when the adapter does not list the bot profile (both directions)', async () => {
    const ws = await directory();
    const f = await setup({ workspaceHost: new FakeHost() });
    const trustedOnStrictAgent = await createBot(f.gateway, botInput({ agentId: 'fake', profile: 'trusted', workspace: ws }));
    const strictOnHostAgent = await createBot(f.gateway, botInput({ agentId: 'host-agent' }));
    for (const bot of [trustedOnStrictAgent, strictOnHostAgent]) {
      const taskId = await send(f.gateway, await botSession(f.gateway, bot.id));
      expect(await finished(f.events, taskId)).toMatchObject({ type: 'task.failed', error: { code: 'PROFILE_UNSUPPORTED' } });
    }
    expect(f.strict.run).not.toHaveBeenCalled(); expect(f.trusted.run).not.toHaveBeenCalled();
  });

  it('fails a trusted run whose workspace disappeared instead of running uncontained elsewhere', async () => {
    const f = await trustedFixture(async () => {});
    const { rm } = await import('node:fs/promises'); await rm(f.workspace, { recursive: true });
    const taskId = await send(f.gateway, f.sessionId);
    expect(await finished(f.events, taskId)).toMatchObject({ type: 'task.failed', error: { code: 'WORKSPACE_UNAVAILABLE' } });
    expect(f.trustedAgent.run).not.toHaveBeenCalled();
  });

  it('routes agent built-in tool permissions through the pipeline: once is not retained, standing by kind, strict denied by policy', async () => {
    const outcomes: string[] = [];
    const tool = (id: string) => ({ capability: 'tool.execute' as const, reason: 'Edit file', agentTool: { toolCallId: id, title: 'Edit a.txt', kind: 'edit' } });
    let standingRequest: string | undefined;
    const f = await trustedFixture(async context => {
      for (const id of ['1', '2', '3']) outcomes.push((await context.requestPermission(tool(id))).outcome);
    });
    f.gateway.subscribe(event => {
      if (event.type !== 'permission.requested') return;
      const request = event.request as PermissionRequestV2;
      if (request.agentTool?.toolCallId === '2') {
        standingRequest = request.id;
        void f.gateway.dispatch(cmd({ type: 'permission.decide', decision: { requestId: request.id, outcome: 'allow', scope: 'standing', standing: { agentToolKind: 'edit' } } }), owner);
      } else void decide(f.gateway, request.id);
    }, owner, { contractVersion: 2 });
    const taskId = await send(f.gateway, f.sessionId); await finished(f.events, taskId);
    expect(outcomes).toEqual(['allow', 'allow', 'allow']);
    expect(f.events.filter(event => event.type === 'permission.requested')).toHaveLength(2);
    expect(f.events.find(event => event.type === 'grant.updated')).toMatchObject({ grant: { capability: 'tool.execute', scope: { agentToolKind: 'edit' } } });
    expect(audits(f.events).map(entry => entry.via)).toEqual(['interactive', 'interactive', 'standing']);
    expect(audits(f.events)[1]).toMatchObject({ requestId: standingRequest, grantId: expect.any(String) });
    // A strict run cannot obtain approval for agent built-in tools.
    let strictOutcome = '';
    const g = await setup({ adapters: [agent('fake', undefined, async context => { strictOutcome = (await context.requestPermission(tool('x'))).outcome; })] });
    const strictTask = await send(g.gateway, await botSession(g.gateway, (await createBot(g.gateway, botInput({ agentId: 'fake' }))).id));
    await finished(g.events, strictTask);
    expect(strictOutcome).toBe('deny'); expect(g.events.some(event => event.type === 'permission.requested')).toBe(false);
    expect(audits(g.events)).toMatchObject([{ via: 'policy', outcome: 'deny' }]);
  });

  it('opens MCP per trusted task with decrypted enabled servers, authorizes every call through the pipeline, and closes it', async () => {
    const broker = new FakeBroker(); const running = gate(); const finish = gate();
    const f = await trustedFixture(async () => { running.open(); await finish.promise; }, { mcpBroker: broker, secretCipher: cipher });
    ok(await f.gateway.dispatch(cmd({ type: 'bot.update', botId: f.bot.id, patch: { mcpServers: [
      { id: 'files', name: 'Files', enabled: true, transport: 'stdio', command: '/usr/bin/files-mcp', env: { TOKEN: 'mcp-env-secret-123' } },
      { id: 'off', name: 'Off', enabled: false, transport: 'http', url: 'https://example.invalid/mcp' },
    ] } }), owner));
    const taskId = await send(f.gateway, f.sessionId); await running.promise;
    const session = broker.sessions[0];
    expect(session.servers).toEqual([{ id: 'files', name: 'Files', enabled: true, transport: 'stdio', command: '/usr/bin/files-mcp', env: { TOKEN: 'mcp-env-secret-123' } }]);
    const signal = new AbortController().signal;
    const first = session.authorize({ serverId: 'files', tool: 'read', arguments: { path: 'x' } }, signal);
    const request = await requested(f.events, r => r.capability === 'mcp.call');
    expect(request.mcp).toEqual({ serverId: 'files', tool: 'read' });
    expect(f.v1Events.some(event => event.type === 'permission.requested' || event.type === 'permission.resolved')).toBe(false);
    ok(await f.gateway.dispatch(cmd({ type: 'permission.decide', decision: { requestId: request.id, outcome: 'allow', scope: 'standing', standing: { mcp: { serverId: 'files' } } } }), owner));
    expect(await first).toBe(true);
    expect(await session.authorize({ serverId: 'files', tool: 'write', arguments: null }, signal)).toBe(true);
    expect(f.events.filter(event => event.type === 'permission.requested')).toHaveLength(1);
    expect(await session.authorize({ serverId: 'files', tool: 'x', arguments: (() => {}) as never }, signal)).toBe(false);
    finish.open(); await finished(f.events, taskId);
    await vi.waitFor(() => expect(session.closed).toBe(true));
    expect(await session.authorize({ serverId: 'files', tool: 'read', arguments: null }, signal)).toBe(false);
    expect(JSON.stringify(f.events)).not.toContain('mcp-env-secret-123');
  });
});

describe('secrets at rest', () => {
  const apiKey = 'sk-provider-secret-value-0001'; const envSecret = 'mcp-env-secret-value-0002'; const headerSecret = 'Bearer mcp-header-secret-0003';
  async function populate(databasePath: string, withCipher: boolean) {
    const reload = vi.fn(async (_settings: AppSettingsV2) => undefined);
    const ws = await directory();
    const gateway = await createGatewayV2({ databasePath, localPrincipalId: owner.id, adapters: [agent('host-agent', ['trusted'])], executor: executor(), onSettingsChanged: reload, ...(withCipher ? { secretCipher: cipher } : {}) });
    ok(await gateway.dispatch(cmd({ type: 'settings.update', settings: { providers: [{ id: 'p', name: 'P', kind: 'openai-compatible', enabled: true, apiKey }] } }), owner));
    const created = await gateway.dispatch(cmd({ type: 'bot.create', bot: botInput({ profile: 'trusted', workspace: ws, mcpServers: [
      { id: 'a', name: 'A', enabled: true, transport: 'stdio', command: '/bin/a', env: { TOKEN: envSecret } },
      { id: 'b', name: 'B', enabled: true, transport: 'http', url: 'https://mcp.example/x', headers: { Authorization: headerSecret } },
    ] }) }), owner); ok(created);
    expect(JSON.stringify(created)).not.toContain(envSecret);
    expect(created.bot!.mcpServers).toMatchObject([{ env: { TOKEN: '' } }, { headers: { Authorization: '' } }]);
    await gateway.close();
    return created.bot!.id;
  }
  const bytes = async (path: string) => (await readFile(path)).toString('latin1');

  it('keeps provider keys, the redaction registry and MCP env/header values out of the database file bytes', async () => {
    const path = join(await directory(), 'data', 'gateway.sqlite');
    const botId = await populate(path, true);
    const content = await bytes(path);
    for (const secret of [apiKey, envSecret, headerSecret, 'mcp-header-secret-0003']) expect(content).not.toContain(secret);
    // Reopen: the cipher restores credentials for the host and MCP broker only.
    const reload = vi.fn(async (_settings: AppSettingsV2) => undefined); const broker = new FakeBroker(); const running = gate();
    const gateway = await createGatewayV2({ databasePath: path, localPrincipalId: owner.id, adapters: [agent('host-agent', ['trusted'], async () => { running.open(); })], executor: executor(), onSettingsChanged: reload, secretCipher: cipher, mcpBroker: broker, workspaceHost: new FakeHost() });
    try {
      expect(reload.mock.calls[0][0].providers[0].apiKey).toBe(apiKey);
      const events: DesktopEventV2[] = []; gateway.subscribe(event => events.push(event), owner, { contractVersion: 2 });
      const session = await gateway.dispatch(cmd({ type: 'bot.session.create', botId }), owner); ok(session);
      const taskId = await send(gateway, session.sessionId!); await running.promise; await finished(events, taskId);
      expect(broker.sessions[0].servers).toMatchObject([{ env: { TOKEN: envSecret } }, { headers: { Authorization: headerSecret } }]);
      // Preserve-on-empty update keeps the stored secret.
      ok(await gateway.dispatch(cmd({ type: 'bot.update', botId, patch: { mcpServers: [{ id: 'a', name: 'A2', enabled: true, transport: 'stdio', command: '/bin/a', env: { TOKEN: '' } }] } }), owner));
      const sync = await gateway.dispatch(cmd({ type: 'state.sync' }), owner); ok(sync);
      expect(JSON.stringify(sync)).not.toContain(envSecret); expect(JSON.stringify(sync)).not.toContain(apiKey);
    } finally { await gateway.close(); }
    const again = await createGatewayV2({ databasePath: path, localPrincipalId: owner.id, executor: executor(), secretCipher: cipher, mcpBroker: new FakeBroker() });
    await again.close();
    expect(await bytes(path)).not.toContain(envSecret);
    await expect(createGatewayV2({ databasePath: path, localPrincipalId: owner.id, executor: executor() })).rejects.toMatchObject({ code: 'SECRET_CIPHER_REQUIRED' });
    await expect(createGatewayV2({ databasePath: path, localPrincipalId: owner.id, executor: executor(), secretCipher: { ...cipher, id: 'other' } })).rejects.toMatchObject({ code: 'SECRET_CIPHER_MISMATCH' });
  });

  it('migrates existing plaintext secrets to ciphertext on open', async () => {
    const path = join(await directory(), 'data', 'gateway.sqlite');
    await populate(path, false);
    expect(await bytes(path)).toContain(apiKey); expect(await bytes(path)).toContain(envSecret);
    const reload = vi.fn(async (_settings: AppSettingsV2) => undefined);
    const gateway = await createGatewayV2({ databasePath: path, localPrincipalId: owner.id, executor: executor(), onSettingsChanged: reload, secretCipher: cipher });
    await gateway.close();
    expect(reload.mock.calls[0][0].providers[0].apiKey).toBe(apiKey);
    const content = await bytes(path);
    for (const secret of [apiKey, envSecret, headerSecret]) expect(content).not.toContain(secret);
  });
});
