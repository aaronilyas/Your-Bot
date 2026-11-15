/** Boundary tests for P4: unattended routines, approvals that wait indefinitely, memory builtins, cursors and host reads. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRunContextV2, DesktopEventV2, DesktopGatewayV2, OwnerNotification, PrincipalV2, Routine, RoutineInput } from '@your-bot/contracts';
import {
  agent, audits, botInput, botSession, cleanupAll, cmd, createBot, decide, device, directory, FakeBroker, FakeClock, FakeHost, finished, gate,
  latestRuns, ok, owner, requested, runEvents, runStatus, send, settle, setup, stranger, type Run,
} from './v2.fixtures.js';

afterEach(cleanupAll);

const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-16T10:00:00.000Z');
const at = (offset: number) => new Date(T0 + offset).toISOString();
const codeOf = (error: unknown) => (error as {code?: string}).code ?? 'UNKNOWN';

function routineInput(botId: string, patch: Partial<RoutineInput> = {}): RoutineInput {
  return { botId, name: 'Nightly report', prompt: 'Write the report', schedule: { kind: 'once', at: at(HOUR) }, missedRunPolicy: 'skip', enabled: true, sessionMode: 'new', ...patch };
}
async function createRoutine(gateway: DesktopGatewayV2, input: RoutineInput, principal: PrincipalV2 = owner): Promise<Routine> {
  const result = await gateway.dispatch(cmd({ type: 'routine.create', routine: input }), principal); ok(result); return result.routine!;
}
/** Trusted bot over a real temporary workspace, fake WorkspaceHost, fake clock and recording notifier. */
async function trustedRoutineFixture(run: Run, extra: Parameters<typeof setup>[0] = {}, principals: PrincipalV2[] = [owner]) {
  const workspace = await directory(); const host = new FakeHost(); const clock = new FakeClock(T0); const notified: OwnerNotification[] = [];
  const trustedAgent = agent('host-agent', ['trusted'], run);
  const f = await setup({ adapters: [agent('fake', undefined), trustedAgent], workspaceHost: host, clock, notifier: { notify: entry => { notified.push(entry); } }, ...extra }, principals);
  const bot = await createBot(f.gateway, botInput({ name: 'Reporter', profile: 'trusted', workspace }));
  return { ...f, workspace, host, clock, notified, bot, trustedAgent };
}
const writeReport: Run = async context => {
  await context.host!.writeTextFile({ path: 'reports/today.txt', content: 'all good' });
  context.emit({ type: 'text', text: 'Report written' });
};

describe('unattended routines', () => {
  it('blocks on approval, notifies, waits indefinitely while the clock advances, and completes after a paired device approves', async () => {
    const f = await trustedRoutineFixture(writeReport);
    await mkdir(join(f.workspace, 'reports'));
    const deviceEvents: DesktopEventV2[] = [];
    f.gateway.subscribe(event => deviceEvents.push(event), device, { contractVersion: 2 });
    await createRoutine(f.gateway, routineInput(f.bot.id));
    await f.clock.advance(HOUR);
    const request = await requested(f.events, r => r.capability === 'file.write');
    const blocked = await runStatus(f.events, run => run.status === 'blocked');
    expect(request.routineRunId).toBe(blocked.id);
    expect(blocked.blockedOn).toEqual([request.id]);
    const notice = f.notified.find(entry => entry.kind === 'approval.required')!;
    expect(notice).toMatchObject({ botId: f.bot.id, routineRunId: blocked.id, requestId: request.id });
    expect(`${notice.title}\n${notice.body}`).toContain('Reporter');
    expect(`${notice.title}\n${notice.body}`).toContain('Nightly report');
    expect(notice.body).toContain(request.id);
    expect(deviceEvents.some(event => event.type === 'notification' && event.notification.id === notice.id)).toBe(true);
    // Nothing times out or auto-denies, no matter how long nobody answers.
    await f.clock.advance(72 * HOUR); await settle();
    expect(latestRuns(f.events).at(-1)).toMatchObject({ id: blocked.id, status: 'blocked', blockedOn: [request.id] });
    expect(f.events.some(event => event.type === 'permission.resolved' || event.type === 'task.failed' || event.type === 'task.cancelled')).toBe(false);
    const sync = await f.gateway.dispatch(cmd({ type: 'state.sync' }), device); ok(sync);
    expect(sync.snapshot!.pendingPermissions.map(entry => entry.id)).toEqual([request.id]);
    expect(sync.snapshot!.routineRuns.find(run => run.id === blocked.id)).toMatchObject({ status: 'blocked' });
    ok(await decide(f.gateway, request.id, device));
    const done = await runStatus(f.events, run => run.status === 'completed');
    expect(runEvents(f.events).map(run => run.status)).toEqual(['queued', 'running', 'blocked', 'running', 'completed']);
    expect(done).not.toHaveProperty('blockedOn');
    expect(await readFile(join(f.workspace, 'reports', 'today.txt'), 'utf8')).toBe('all good');
    expect(audits(f.events).find(entry => entry.requestId === request.id)).toMatchObject({ via: 'interactive', outcome: 'allow', decidedBy: device.id, routineRunId: blocked.id });
  });

  it('completes unattended with zero permission prompts under a standing file.write grant, audited as standing', async () => {
    const f = await trustedRoutineFixture(writeReport);
    await mkdir(join(f.workspace, 'reports'));
    const grant = await f.gateway.dispatch(cmd({ type: 'grant.create', grant: { botId: f.bot.id, capability: 'file.write', scope: { folder: join(f.workspace, 'reports') } } }), owner); ok(grant);
    const routine = await createRoutine(f.gateway, routineInput(f.bot.id, { schedule: { kind: 'interval', everyMinutes: 60 } }));
    await f.clock.advance(HOUR);
    const run = await runStatus(f.events, entry => entry.status === 'completed');
    expect(run).toMatchObject({ routineId: routine.id, trigger: 'schedule' });
    expect(f.events.some(event => event.type === 'permission.requested')).toBe(false);
    expect(f.notified).toEqual([]);
    expect(await readFile(join(f.workspace, 'reports', 'today.txt'), 'utf8')).toBe('all good');
    const list = await f.gateway.dispatch(cmd({ type: 'audit.list', botId: f.bot.id }), owner); ok(list);
    expect(list.audit).toEqual([expect.objectContaining({ via: 'standing', outcome: 'allow', capability: 'file.write', grantId: grant.grant!.id, routineRunId: run.id, taskId: run.taskId, subject: join(f.workspace, 'reports', 'today.txt') })]);
  });

  it('marks runs left running or blocked as interrupted on restart with a notification, and never resumes them', async () => {
    const databasePath = join(await directory(), 'gateway.db');
    const first = await trustedRoutineFixture(writeReport, { databasePath });
    await mkdir(join(first.workspace, 'reports'));
    const routine = await createRoutine(first.gateway, routineInput(first.bot.id));
    await first.clock.advance(HOUR);
    const request = await requested(first.events, r => r.capability === 'file.write');
    const blocked = await runStatus(first.events, run => run.status === 'blocked');
    await first.gateway.close();
    expect(latestRuns(first.events).at(-1)!.status).toBe('blocked');
    const notified: OwnerNotification[] = [];
    const second = await setup({ databasePath, clock: new FakeClock(T0 + 2 * HOUR), workspaceHost: new FakeHost(), adapters: [agent('fake', undefined), agent('host-agent', ['trusted'], writeReport)], notifier: { notify: entry => { notified.push(entry); } } });
    const runs = await second.gateway.dispatch(cmd({ type: 'routine.runs', routineId: routine.id }), owner); ok(runs);
    expect(runs.runs).toEqual([expect.objectContaining({ id: blocked.id, status: 'interrupted', finishedAt: at(2 * HOUR) })]);
    expect(runs.runs![0]).not.toHaveProperty('blockedOn');
    expect(notified).toEqual([expect.objectContaining({ kind: 'routine.interrupted', routineRunId: blocked.id, botId: first.bot.id })]);
    const sync = await second.gateway.dispatch(cmd({ type: 'state.sync' }), owner); ok(sync);
    expect(sync.snapshot!.pendingPermissions).toEqual([]);
    expect(sync.snapshot!.notifications.map(entry => entry.kind)).toEqual(['routine.interrupted', 'approval.required']);
    expect(await decide(second.gateway, request.id, owner)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    await settle();
    expect(second.events.some(event => event.type === 'task.started')).toBe(false);
  });

  it('lets only the local owner data hold routines; trusted-bot routines are local-owner only; runs never hold settings', async () => {
    const contexts: AgentRunContextV2[] = [];
    const f = await trustedRoutineFixture(async context => { contexts.push(context); }, { routineCapabilities: ['conversation', 'file.read'] });
    const strict = await createBot(f.gateway, botInput({ agentId: 'fake', name: 'Strict' }));
    const strangerBot = await createBot(f.gateway, botInput({ agentId: 'fake' }), stranger);
    expect(await f.gateway.dispatch(cmd({ type: 'routine.create', routine: routineInput(strangerBot.id) }), stranger)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await f.gateway.dispatch(cmd({ type: 'routine.create', routine: routineInput(f.bot.id) }), device)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const reader: PrincipalV2 = { ...device, id: 'device:reader', deviceId: 'reader', capabilities: ['conversation'] };
    expect(await f.gateway.dispatch(cmd({ type: 'routine.create', routine: routineInput(strict.id) }), reader)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const deviceRoutine = await createRoutine(f.gateway, routineInput(strict.id), device);
    const trustedRoutine = await createRoutine(f.gateway, routineInput(f.bot.id, { schedule: { kind: 'interval', everyMinutes: 600 } }));
    // A device cannot repoint, re-prompt or retarget a trusted routine, but can pause it.
    for (const patch of [{ prompt: 'rm -rf' }, { schedule: { kind: 'interval' as const, everyMinutes: 1 } }]) {
      expect(await f.gateway.dispatch(cmd({ type: 'routine.update', routineId: trustedRoutine.id, patch }), device)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    }
    expect(await f.gateway.dispatch(cmd({ type: 'routine.update', routineId: deviceRoutine.id, patch: { botId: f.bot.id } }), device)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    ok(await f.gateway.dispatch(cmd({ type: 'routine.update', routineId: trustedRoutine.id, patch: { enabled: false } }), device));
    expect(await f.gateway.dispatch(cmd({ type: 'routine.runNow', routineId: trustedRoutine.id }), reader)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    ok(await f.gateway.dispatch(cmd({ type: 'routine.runs', routineId: trustedRoutine.id }), reader));
    expect(await f.gateway.dispatch(cmd({ type: 'routine.runs', routineId: trustedRoutine.id }), stranger)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    ok(await f.gateway.dispatch(cmd({ type: 'routine.runNow', routineId: trustedRoutine.id }), device));
    await runStatus(f.events, run => run.routineId === trustedRoutine.id && run.status === 'completed');
    expect(contexts[0].principal).toEqual({ id: owner.id, kind: 'local', capabilities: ['conversation', 'file.read'] });
    // Data of other owners never sees owner routines.
    const strangerSync = await f.gateway.dispatch(cmd({ type: 'state.sync' }), stranger); ok(strangerSync);
    expect(strangerSync.snapshot!.routines).toEqual([]); expect(strangerSync.snapshot!.routineRuns).toEqual([]); expect(strangerSync.snapshot!.notifications).toEqual([]);
  });
});

describe('memory builtins', () => {
  it('serves remember/recall only through the MCP authorization pipeline (deny, standing grant) with bounded entries', async () => {
    const broker = new FakeBroker(); const running = gate(); const finish = gate();
    const f = await trustedRoutineFixture(async () => { running.open(); await finish.promise; }, { mcpBroker: broker });
    ok(await f.gateway.dispatch(cmd({ type: 'bot.update', botId: f.bot.id, patch: { memoryEnabled: true } }), owner));
    const sessionId = await botSession(f.gateway, f.bot.id);
    const taskId = await send(f.gateway, sessionId); await running.promise;
    const session = broker.sessions[0];
    expect(session.servers).toEqual([]);
    expect(session.builtins.map(tool => tool.name)).toEqual(['remember', 'recall']);
    const [remember, recall] = session.builtins;
    const signal = new AbortController().signal;
    const call = { serverId: 'your_bot', tool: 'remember', arguments: { content: 'Prefers metric units' } };
    const pending = session.authorize(call, signal);
    const request = await requested(f.events, r => r.capability === 'mcp.call');
    expect(request).toMatchObject({ mcp: { serverId: 'your_bot', tool: 'remember' }, botId: f.bot.id });
    ok(await decide(f.gateway, request.id, owner, 'deny'));
    expect(await pending).toBe(false);
    let memory = await f.gateway.dispatch(cmd({ type: 'memory.list', botId: f.bot.id }), owner); ok(memory);
    expect(memory.memory).toEqual([]);
    const grant = await f.gateway.dispatch(cmd({ type: 'grant.create', grant: { botId: f.bot.id, capability: 'mcp.call', scope: { mcp: { serverId: 'your_bot' } } } }), owner); ok(grant);
    expect(await session.authorize(call, signal)).toBe(true);
    expect(await session.authorize({ serverId: 'your_bot', tool: 'recall', arguments: {} }, signal)).toBe(true);
    expect(f.events.filter(event => event.type === 'permission.requested')).toHaveLength(1);
    expect(audits(f.events).filter(entry => entry.via === 'standing').map(entry => entry.subject)).toEqual(['your_bot/remember', 'your_bot/recall']);
    expect(await remember.handle(call.arguments, signal)).toMatchObject({ saved: true });
    memory = await f.gateway.dispatch(cmd({ type: 'memory.list', botId: f.bot.id }), owner); ok(memory);
    expect(memory.memory).toEqual([expect.objectContaining({ content: 'Prefers metric units', source: 'agent', botId: f.bot.id })]);
    expect(f.events.some(event => event.type === 'memory.updated' && event.botId === f.bot.id)).toBe(true);
    expect(await recall.handle({ query: 'METRIC' }, signal)).toEqual({ entries: [expect.objectContaining({ content: 'Prefers metric units', source: 'agent' })] });
    expect(await recall.handle({ query: 'imperial' }, signal)).toEqual({ entries: [] });
    for (const bad of [{ content: 'x'.repeat(2049) }, { content: '  ' }, {}, { content: 'a', extra: 1 }, 'text']) {
      await expect(remember.handle(bad as never, signal)).rejects.toMatchObject({ code: expect.stringMatching(/LIMIT_EXCEEDED|INVALID_INPUT/) });
    }
    await expect(remember.handle({ content: 'x'.repeat(2049) }, signal)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    for (let i = 1; i < 500; i++) await remember.handle({ content: `note ${i}` }, signal);
    await expect(remember.handle({ content: 'one too many' }, signal)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    finish.open(); await finished(f.events, taskId);
    await expect(remember.handle({ content: 'after the task' }, signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(recall.handle({}, signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('never opens builtins for bots without memory or for strict bots', async () => {
    const broker = new FakeBroker();
    const f = await trustedRoutineFixture(async () => {}, { mcpBroker: broker });
    await finished(f.events, await send(f.gateway, await botSession(f.gateway, f.bot.id)));
    const strict = await createBot(f.gateway, botInput({ agentId: 'fake', memoryEnabled: true }));
    await finished(f.events, await send(f.gateway, await botSession(f.gateway, strict.id)));
    expect(broker.sessions).toEqual([]);
  });
});

describe('P1 review fixes', () => {
  it('rejects state.sync with a cursor beyond the latest event with INVALID_CURSOR', async () => {
    const f = await setup();
    const sync = await f.gateway.dispatch(cmd({ type: 'state.sync' }), owner); ok(sync);
    const last = sync.snapshot!.lastSequence;
    expect(await f.gateway.dispatch(cmd({ type: 'state.sync', afterSequence: last + 1 }), owner)).toMatchObject({ ok: false, error: { code: 'INVALID_CURSOR' } });
    expect(await f.gateway.dispatch(cmd({ type: 'state.sync', afterSequence: Number.MAX_SAFE_INTEGER }), device)).toMatchObject({ ok: false, error: { code: 'INVALID_CURSOR' } });
    ok(await f.gateway.dispatch(cmd({ type: 'state.sync', afterSequence: last }), owner));
    // A stranger's cursor is checked against the stranger's own events.
    expect(await f.gateway.dispatch(cmd({ type: 'state.sync', afterSequence: last }), stranger)).toMatchObject({ ok: false, error: { code: 'INVALID_CURSOR' } });
  });

  it('reports a missing file inside the workspace as NOT_FOUND without prompting, and outside paths stay OUTSIDE_WORKSPACE', async () => {
    const results: string[] = [];
    const outside = await directory();
    const f = await trustedRoutineFixture(async context => {
      for (const path of ['missing.txt', 'no-dir/missing.txt', join(outside, 'missing.txt'), 'present.txt']) {
        try { results.push((await context.host!.readTextFile({ path })).content); } catch (error) { results.push(codeOf(error)); }
      }
    });
    await writeFile(join(f.workspace, 'present.txt'), 'here');
    f.gateway.subscribe(event => { if (event.type === 'permission.requested') void decide(f.gateway, event.request.id, owner); }, owner, { contractVersion: 2 });
    await finished(f.events, await send(f.gateway, await botSession(f.gateway, f.bot.id)));
    expect(results).toEqual(['NOT_FOUND', 'NOT_FOUND', 'OUTSIDE_WORKSPACE', 'here']);
    expect(f.events.filter(event => event.type === 'permission.requested')).toHaveLength(1);
    expect(f.host.calls).toEqual([`read ${join(f.workspace, 'present.txt')}`]);
  });
});

