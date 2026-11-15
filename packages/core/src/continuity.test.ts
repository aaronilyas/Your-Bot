import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentRunContextV2, DesktopGatewayV2, MissedRunPolicy, OwnerNotification, PrincipalV2, Routine, RoutineInput, RoutineRun, SessionV2 } from '@your-bot/contracts';
import {
  agent, botInput, botSession, cleanupAll, cmd, createBot, device, directory, FakeClock, FakeSkills, finished, gate, latestRuns, notifications, ok,
  owner, runEvents, runStatus, send, settle, setup, type Run,
} from './v2.fixtures.js';

afterEach(cleanupAll);

const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-16T10:00:00.000Z');
const at = (offset: number) => new Date(T0 + offset).toISOString();

function routineInput(botId: string, patch: Partial<RoutineInput> = {}): RoutineInput {
  return { botId, name: 'Hourly check', prompt: 'Check things', schedule: { kind: 'interval', everyMinutes: 60 }, missedRunPolicy: 'skip', enabled: true, sessionMode: 'new', ...patch };
}
async function createRoutine(gateway: DesktopGatewayV2, input: RoutineInput, principal: PrincipalV2 = owner): Promise<Routine> {
  const result = await gateway.dispatch(cmd({ type: 'routine.create', routine: input }), principal); ok(result); return result.routine!;
}
async function runsOf(gateway: DesktopGatewayV2, routineId: string): Promise<RoutineRun[]> {
  const result = await gateway.dispatch(cmd({ type: 'routine.runs', routineId }), owner); ok(result); return result.runs!.reverse();
}
async function routineOf(gateway: DesktopGatewayV2, routineId: string): Promise<Routine> {
  const sync = await gateway.dispatch(cmd({ type: 'state.sync' }), owner); ok(sync);
  return sync.snapshot!.routines.find(routine => routine.id === routineId)!;
}
async function openSession(gateway: DesktopGatewayV2, sessionId: string): Promise<SessionV2> {
  const result = await gateway.dispatch(cmd({ type: 'session.open', sessionId }), owner); ok(result); return result.session as SessionV2;
}
async function routineFixture(run?: Run, extra: Parameters<typeof setup>[0] = {}) {
  const clock = new FakeClock(T0); const notified: OwnerNotification[] = [];
  const adapter = agent('fake', undefined, run);
  const f = await setup({ clock, adapters: [adapter, agent('host-agent', ['trusted'])], notifier: { notify: notification => { notified.push(notification); } }, ...extra });
  const bot = await createBot(f.gateway, botInput({ agentId: 'fake', name: 'Helper' }));
  return { ...f, clock, notified, bot, adapter };
}

describe('routines', () => {
  it('runs on schedule as the local owner without settings, in a new session per run, with routine.run lifecycle events', async () => {
    const f = await routineFixture();
    const routine = await createRoutine(f.gateway, routineInput(f.bot.id));
    expect(routine).toMatchObject({ nextRunAt: at(HOUR), createdAt: at(0) });
    expect(routine).not.toHaveProperty('lastRunAt');
    await f.clock.advance(HOUR);
    const first = await runStatus(f.events, run => run.status === 'completed');
    expect(runEvents(f.events).map(run => run.status)).toEqual(['queued', 'running', 'completed']);
    expect(first).toMatchObject({ routineId: routine.id, botId: f.bot.id, trigger: 'schedule', scheduledFor: at(HOUR), startedAt: at(HOUR), finishedAt: at(HOUR) });
    const session = await openSession(f.gateway, first.sessionId!);
    expect(session.messages.map(message => [message.role, message.content])).toEqual([['user', 'Check things'], ['assistant', 'Hello']]);
    expect(session.botId).toBe(f.bot.id);
    const context = f.adapter.run.mock.calls[0][0] as AgentRunContextV2;
    expect(context.principal).toMatchObject({ id: owner.id, kind: 'local' });
    expect(context.principal.capabilities).not.toContain('settings');
    expect(context.principal.capabilities).toEqual(expect.arrayContaining(['conversation', 'tool.execute', 'file.write', 'mcp.call']));
    expect(await routineOf(f.gateway, routine.id)).toMatchObject({ lastRunAt: at(HOUR), nextRunAt: at(2 * HOUR) });
    await f.clock.advance(HOUR);
    await vi.waitFor(() => expect(latestRuns(f.events).filter(run => run.status === 'completed')).toHaveLength(2));
    const runs = await runsOf(f.gateway, routine.id);
    expect(runs.map(run => run.scheduledFor)).toEqual([at(HOUR), at(2 * HOUR)]);
    expect(runs[1].sessionId).not.toBe(runs[0].sessionId);
    const sync = await f.gateway.dispatch(cmd({ type: 'state.sync' }), owner); ok(sync);
    expect(sync.snapshot!.routineRuns.map(run => run.id)).toEqual(expect.arrayContaining(runs.map(run => run.id)));
    // v1 subscribers never see routine events.
    expect(f.v1Events.some(event => event.type.startsWith('routine.'))).toBe(false);
  });

  it.each<[MissedRunPolicy, number | undefined, number[]]>([
    ['skip', undefined, []],
    ['runOnce', undefined, [5]],
    ['runAll', 3, [3, 4, 5]],
    ['runAll', undefined, [1, 2, 3, 4, 5]],
  ])('applies missedRunPolicy %s (maxCatchUp %s) to occurrences missed while the host was down', async (policy, maxCatchUp, hours) => {
    const databasePath = join(await directory(), 'gateway.db');
    const first = await setup({ databasePath, clock: new FakeClock(T0), adapters: [agent('fake', undefined)] });
    const bot = await createBot(first.gateway, botInput({ agentId: 'fake' }));
    const routine = await createRoutine(first.gateway, routineInput(bot.id, { missedRunPolicy: policy, ...(maxCatchUp ? { maxCatchUp } : {}) }));
    await first.gateway.close();
    // Down from T0 to T0+5h30: occurrences at +1h … +5h were missed.
    const second = await setup({ databasePath, clock: new FakeClock(T0 + 5.5 * HOUR), adapters: [agent('fake', undefined)] });
    await settle();
    await vi.waitFor(async () => expect((await runsOf(second.gateway, routine.id)).filter(run => run.status === 'completed')).toHaveLength(hours.length));
    await settle();
    const runs = await runsOf(second.gateway, routine.id);
    expect(runs.map(run => [run.trigger, run.scheduledFor, run.status])).toEqual(hours.map(hour => ['catchup', at(hour * HOUR), 'completed']));
    expect(await routineOf(second.gateway, routine.id)).toMatchObject({ nextRunAt: at(6 * HOUR) });
  });

  it('detects a late timer fire after sleep and applies the missed-run policy, running the on-time occurrence normally', async () => {
    const f = await routineFixture();
    const skip = await createRoutine(f.gateway, routineInput(f.bot.id, { name: 'skip', missedRunPolicy: 'skip' }));
    const once = await createRoutine(f.gateway, routineInput(f.bot.id, { name: 'once', missedRunPolicy: 'runOnce' }));
    f.clock.sleep(3 * HOUR);
    await f.clock.fireDue();
    await vi.waitFor(() => expect(latestRuns(f.events).filter(run => run.status === 'completed')).toHaveLength(3));
    const byRoutine = (id: string) => latestRuns(f.events).filter(run => run.routineId === id).map(run => [run.trigger, run.scheduledFor]);
    expect(byRoutine(skip.id)).toEqual([['schedule', at(3 * HOUR)]]);
    expect(byRoutine(once.id)).toEqual([['catchup', at(2 * HOUR)], ['schedule', at(3 * HOUR)]]);
    expect(await routineOf(f.gateway, once.id)).toMatchObject({ nextRunAt: at(4 * HOUR) });
  });

  it('reuses one session, queues at most one run while busy and records further occurrences as skipped with a notification', async () => {
    const release = gate(); let calls = 0;
    const f = await routineFixture(async context => { if (++calls === 1) await release.promise; context.emit({ type: 'text', text: `Reply ${calls}` }); });
    const routine = await createRoutine(f.gateway, routineInput(f.bot.id, { sessionMode: 'reuse' }));
    await f.clock.advance(HOUR);
    const running = await runStatus(f.events, run => run.status === 'running');
    expect(await routineOf(f.gateway, routine.id)).toMatchObject({ sessionId: running.sessionId });
    expect(await f.gateway.dispatch(cmd({ type: 'message.send', sessionId: running.sessionId!, content: 'hi' }), owner)).toMatchObject({ ok: false, error: { code: 'SESSION_BUSY' } });
    const manual = await f.gateway.dispatch(cmd({ type: 'routine.runNow', routineId: routine.id }), owner); ok(manual);
    expect(manual.runs![0]).toMatchObject({ trigger: 'manual', status: 'queued' });
    expect(await f.gateway.dispatch(cmd({ type: 'routine.runNow', routineId: routine.id }), owner)).toMatchObject({ ok: false, error: { code: 'SESSION_BUSY' } });
    await f.clock.advance(HOUR);
    const skipped = await runStatus(f.events, run => run.status === 'skipped');
    expect(skipped).toMatchObject({ trigger: 'schedule', scheduledFor: at(2 * HOUR) });
    expect(f.notified).toEqual([expect.objectContaining({ kind: 'routine.skipped', routineRunId: skipped.id, botId: f.bot.id })]);
    release.open();
    await vi.waitFor(() => expect(latestRuns(f.events).filter(run => run.status === 'completed')).toHaveLength(2));
    const runs = await runsOf(f.gateway, routine.id);
    expect(runs.map(run => [run.trigger, run.status])).toEqual([['schedule', 'completed'], ['manual', 'completed'], ['schedule', 'skipped']]);
    expect(runs[1].sessionId).toBe(running.sessionId);
    const session = await openSession(f.gateway, running.sessionId!);
    expect(session.messages.map(message => message.content)).toEqual(['Check things', 'Reply 1', 'Check things', 'Reply 2']);
  });

  it('records failures with routine.failed notifications, delivered to the notifier, the snapshot and acknowledgeable', async () => {
    const f = await routineFixture(async () => { throw Object.assign(new Error('agent exploded'), { code: 'AGENT_CRASHED' }); });
    const routine = await createRoutine(f.gateway, routineInput(f.bot.id));
    ok(await f.gateway.dispatch(cmd({ type: 'routine.runNow', routineId: routine.id }), owner));
    const failed = await runStatus(f.events, run => run.status === 'failed');
    expect(failed.error).toMatchObject({ code: 'AGENT_CRASHED' });
    // A run that cannot start fails the same way.
    const orphan = await createBot(f.gateway, botInput({ agentId: 'not-installed' }));
    const broken = await createRoutine(f.gateway, routineInput(orphan.id, { name: 'Broken' }));
    ok(await f.gateway.dispatch(cmd({ type: 'routine.runNow', routineId: broken.id }), owner));
    const unavailable = await runStatus(f.events, run => run.routineId === broken.id && run.status === 'failed');
    expect(unavailable.error).toMatchObject({ code: 'AGENT_UNAVAILABLE' });
    expect(f.notified.map(entry => [entry.kind, entry.routineRunId])).toEqual([['routine.failed', failed.id], ['routine.failed', unavailable.id]]);
    expect(f.notified[0].title).toContain('Hourly check');
    expect(notifications(f.events)).toHaveLength(2);
    let sync = await f.gateway.dispatch(cmd({ type: 'state.sync' }), owner); ok(sync);
    expect(sync.snapshot!.notifications.map(entry => entry.id)).toEqual([f.notified[1].id, f.notified[0].id]);
    ok(await f.gateway.dispatch(cmd({ type: 'notification.ack', notificationId: f.notified[0].id }), device));
    ok(await f.gateway.dispatch(cmd({ type: 'notification.ack', notificationId: f.notified[0].id }), owner));
    expect(notifications(f.events).filter(entry => entry.acknowledgedAt)).toHaveLength(1);
    sync = await f.gateway.dispatch(cmd({ type: 'state.sync' }), owner); ok(sync);
    expect(sync.snapshot!.notifications.map(entry => entry.id)).toEqual([f.notified[1].id]);
    expect(f.notified).toHaveLength(2);
  });

  it('updates, disables, re-enables and deletes routines and keeps the timer consistent', async () => {
    const f = await routineFixture();
    const routine = await createRoutine(f.gateway, routineInput(f.bot.id));
    const disabled = await f.gateway.dispatch(cmd({ type: 'routine.update', routineId: routine.id, patch: { enabled: false } }), owner); ok(disabled);
    expect(disabled.routine).not.toHaveProperty('nextRunAt');
    expect(f.clock.pending).toBe(0);
    await f.clock.advance(3 * HOUR);
    expect(runEvents(f.events)).toEqual([]);
    const enabled = await f.gateway.dispatch(cmd({ type: 'routine.update', routineId: routine.id, patch: { enabled: true } }), owner); ok(enabled);
    expect(enabled.routine).toMatchObject({ nextRunAt: at(4 * HOUR), createdAt: routine.createdAt });
    const cron = await f.gateway.dispatch(cmd({ type: 'routine.update', routineId: routine.id, patch: { schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'Europe/Paris' } } }), owner); ok(cron);
    expect(cron.routine!.nextRunAt).toBe('2026-11-17T08:00:00.000Z');
    for (const schedule of [{ kind: 'cron' as const, expression: '0 9 * * *', timezone: 'Nowhere/City' }, { kind: 'once' as const, at: at(-HOUR) }, { kind: 'cron' as const, expression: '0 0 31 2 *' }]) {
      expect(await f.gateway.dispatch(cmd({ type: 'routine.update', routineId: routine.id, patch: { schedule } }), owner)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
    expect(await f.gateway.dispatch(cmd({ type: 'routine.create', routine: routineInput('missing-bot') }), owner)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const once = await createRoutine(f.gateway, routineInput(f.bot.id, { name: 'Once', schedule: { kind: 'once', at: at(4 * HOUR + 30 * 60_000) } }));
    await f.clock.advance(2 * HOUR);
    await runStatus(f.events, run => run.routineId === once.id && run.status === 'completed');
    expect(await routineOf(f.gateway, once.id)).not.toHaveProperty('nextRunAt');
    ok(await f.gateway.dispatch(cmd({ type: 'routine.delete', routineId: routine.id }), owner));
    ok(await f.gateway.dispatch(cmd({ type: 'routine.delete', routineId: once.id }), owner));
    expect(f.events.filter(event => event.type === 'routine.deleted')).toHaveLength(2);
    expect(await f.gateway.dispatch(cmd({ type: 'routine.runs', routineId: routine.id }), owner)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(f.clock.pending).toBe(0);
    // Deleting a bot deletes its routines.
    const again = await createRoutine(f.gateway, routineInput(f.bot.id));
    ok(await f.gateway.dispatch(cmd({ type: 'bot.delete', botId: f.bot.id }), owner));
    expect(f.events.some(event => event.type === 'routine.deleted' && event.routineId === again.id)).toBe(true);
  });
});

describe('memory and instructions', () => {
  it('lists, adds and deletes owner memory with events and limits; adding needs settings or the local owner', async () => {
    const f = await setup();
    const bot = await createBot(f.gateway, botInput({ agentId: 'fake' }));
    const added = await f.gateway.dispatch(cmd({ type: 'memory.add', botId: bot.id, content: '  Owner likes tea  ' }), owner); ok(added);
    expect(added.memory).toEqual([expect.objectContaining({ botId: bot.id, content: 'Owner likes tea', source: 'owner' })]);
    ok(await f.gateway.dispatch(cmd({ type: 'memory.add', botId: bot.id, content: 'Project is Apollo' }), device));
    const reader: PrincipalV2 = { id: 'device:reader', kind: 'remote', ownerId: owner.id, deviceId: 'reader', capabilities: ['conversation'] };
    expect(await f.gateway.dispatch(cmd({ type: 'memory.add', botId: bot.id, content: 'x' }), reader)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const listed = await f.gateway.dispatch(cmd({ type: 'memory.list', botId: bot.id }), reader); ok(listed);
    expect(listed.memory!.map(entry => entry.content)).toEqual(['Project is Apollo', 'Owner likes tea']);
    expect(await f.gateway.dispatch(cmd({ type: 'memory.add', botId: bot.id, content: 'x'.repeat(8193) }), owner)).toMatchObject({ ok: false, error: { code: 'LIMIT_EXCEEDED' } });
    expect(await f.gateway.dispatch(cmd({ type: 'memory.add', botId: bot.id, content: '   ' }), owner)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const stranger: PrincipalV2 = { id: 'stranger', kind: 'remote', capabilities: [...owner.capabilities] };
    expect(await f.gateway.dispatch(cmd({ type: 'memory.list', botId: bot.id }), stranger)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const removed = await f.gateway.dispatch(cmd({ type: 'memory.delete', botId: bot.id, memoryId: added.memory![0].id }), owner); ok(removed);
    expect(removed.memory!.map(entry => entry.content)).toEqual(['Project is Apollo']);
    expect(await f.gateway.dispatch(cmd({ type: 'memory.delete', botId: bot.id, memoryId: added.memory![0].id }), owner)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(f.events.filter(event => event.type === 'memory.updated')).toHaveLength(3);
    expect(f.v1Events.some(event => event.type === 'memory.updated')).toBe(false);
  });

  it('composes bot instructions, memory (newest first) and enabled skill bodies, skipping missing or invalid skills with a status', async () => {
    const workspace = await directory();
    const skills = new FakeSkills([
      { id: 'writing', name: 'Writing', description: 'Write well', source: 'global', folder: '/skills/writing' },
      { id: 'writing', name: 'Shadow', description: 'Workspace copy', source: 'workspace', folder: join(workspace, '.your-bot/skills/writing') },
      { id: 'deploy', name: 'Deploy', description: 'Ship it', source: 'workspace', folder: join(workspace, '.your-bot/skills/deploy') },
      { id: 'broken', name: 'broken', description: '', source: 'global', folder: '/skills/broken', error: 'Invalid frontmatter' },
    ], { 'global:writing': '---\nWrite clearly.', 'workspace:writing': 'SHADOW BODY', 'workspace:deploy': 'Deploy with care.' });
    const contexts: AgentRunContextV2[] = [];
    const f = await setup({ skillCatalog: skills, adapters: [agent('fake', undefined, async context => { contexts.push(context); })] });
    const bot = await createBot(f.gateway, botInput({ agentId: 'fake', instructions: 'Be terse.', memoryEnabled: true, workspace, skills: ['writing', 'deploy', 'broken', 'ghost'] }));
    ok(await f.gateway.dispatch(cmd({ type: 'memory.add', botId: bot.id, content: 'Owner likes tea' }), owner));
    ok(await f.gateway.dispatch(cmd({ type: 'memory.add', botId: bot.id, content: 'Project is Apollo' }), owner));
    const sessionId = await botSession(f.gateway, bot.id);
    const taskId = await send(f.gateway, sessionId);
    expect((await finished(f.events, taskId)).type).toBe('task.completed');
    const instructions = contexts[0].instructions!;
    expect(instructions.startsWith('Be terse.\n\n## Memory\n')).toBe(true);
    expect(instructions.indexOf('Project is Apollo')).toBeLessThan(instructions.indexOf('Owner likes tea'));
    expect(instructions).toContain('## Skill: Writing\n---\nWrite clearly.');
    expect(instructions).toContain('## Skill: Deploy\nDeploy with care.');
    expect(instructions).not.toContain('SHADOW');
    expect(skills.listed.at(-1)).toEqual([workspace]);
    const statuses = f.events.filter(event => event.type === 'task.status' && event.taskId === taskId).map(event => (event as {status: string}).status);
    expect(statuses).toEqual(['Skill broken was skipped: invalid', 'Skill ghost was skipped: not found']);
    // Memory disabled: no memory section; huge instructions stay within 64 KiB.
    ok(await f.gateway.dispatch(cmd({ type: 'bot.update', botId: bot.id, patch: { memoryEnabled: false, instructions: 'é'.repeat(40_000) } }), owner));
    await finished(f.events, await send(f.gateway, sessionId));
    expect(contexts[1].instructions).not.toContain('## Memory');
    expect(Buffer.byteLength(contexts[1].instructions!)).toBeLessThanOrEqual(64 * 1024);
    // Snapshot skills come from the catalog; skills.refresh re-lists and emits skills.updated.
    const sync = await f.gateway.dispatch(cmd({ type: 'state.sync' }), owner); ok(sync);
    expect(sync.snapshot!.skills.map(skill => `${skill.source}:${skill.id}`)).toEqual(['global:writing', 'workspace:writing', 'workspace:deploy', 'global:broken']);
    skills.skills = skills.skills.slice(0, 1);
    const refreshed = await f.gateway.dispatch(cmd({ type: 'skills.refresh' }), owner); ok(refreshed);
    expect(refreshed.skills!.map(skill => skill.id)).toEqual(['writing']);
    expect(f.events.filter(event => event.type === 'skills.updated')).toHaveLength(1);
  });

  it('skips enabled skills with a status when no catalog is configured', async () => {
    const contexts: AgentRunContextV2[] = [];
    const f = await setup({ adapters: [agent('fake', undefined, async context => { contexts.push(context); })] });
    const bot = await createBot(f.gateway, botInput({ agentId: 'fake', instructions: 'Hi', skills: ['writing'] }));
    const taskId = await send(f.gateway, await botSession(f.gateway, bot.id));
    await finished(f.events, taskId);
    expect(contexts[0].instructions).toBe('Hi');
    expect(f.events.some(event => event.type === 'task.status' && event.status === 'Skill writing was skipped: skills are unavailable on this host')).toBe(true);
  });
});

describe('compaction', () => {
  function archived(databasePath: string, sessionId: string): string[] {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try { return (db.prepare('SELECT value FROM archived_messages WHERE session_id=? ORDER BY seq').all(sessionId) as {value: string}[]).map(row => JSON.parse(row.value).content); }
    finally { db.close(); }
  }

  it('summarizes older messages with adapter.summarize, archives them and delivers the summary to later runs', async () => {
    const databasePath = join(await directory(), 'gateway.db');
    const contexts: AgentRunContextV2[] = []; const inputs: {previousSummary?: string; count: number}[] = [];
    const adapter = Object.assign(agent('fake', undefined, async context => { contexts.push(context); context.emit({ type: 'text', text: `Answer ${contexts.length}` }); }), {
      summarize: vi.fn(async (input: {previousSummary?: string; messages: {content: string}[]}) => { inputs.push({ ...(input.previousSummary ? { previousSummary: input.previousSummary } : {}), count: input.messages.length }); return `Summary #${inputs.length}`; }),
    });
    const f = await setup({ databasePath, adapters: [adapter] });
    const bot = await createBot(f.gateway, botInput({ agentId: 'fake', compaction: { maxMessages: 4, keepRecent: 2 } }));
    const sessionId = await botSession(f.gateway, bot.id);
    for (let i = 1; i <= 3; i++) await finished(f.events, await send(f.gateway, sessionId, owner, `Question ${i}`));
    await vi.waitFor(async () => expect((await openSession(f.gateway, sessionId)).summary).toBe('Summary #1'));
    let session = await openSession(f.gateway, sessionId);
    expect(session.compactedCount).toBe(4);
    expect(session.messages.map(message => message.content)).toEqual(['Question 3', 'Answer 3']);
    expect(archived(databasePath, sessionId)).toEqual(['Question 1', 'Answer 1', 'Question 2', 'Answer 2']);
    await finished(f.events, await send(f.gateway, sessionId, owner, 'Question 4'));
    expect(contexts[3].session).toMatchObject({ summary: 'Summary #1', compactedCount: 4 });
    await finished(f.events, await send(f.gateway, sessionId, owner, 'Question 5'));
    await vi.waitFor(async () => expect((await openSession(f.gateway, sessionId)).summary).toBe('Summary #2'));
    session = await openSession(f.gateway, sessionId);
    expect(session).toMatchObject({ compactedCount: 8 });
    expect(inputs).toEqual([{ count: 4 }, { previousSummary: 'Summary #1', count: 4 }]);
    expect(archived(databasePath, sessionId)).toHaveLength(8);
    // v1 subscribers never see summary fields.
    expect(f.v1Events.some(event => event.type === 'session.updated' && 'summary' in event.session)).toBe(false);
  });

  it('falls back to a deterministic bounded summary when summarize is absent, fails or exceeds its time bound (aborting it)', async () => {
    let signal: AbortSignal | undefined;
    const hanging = Object.assign(agent('fake', undefined), { summarize: vi.fn(async (input: {signal: AbortSignal}) => { signal = input.signal; return new Promise<string>(() => {}); }) });
    const failing = Object.assign(agent('host-agent', undefined), { summarize: vi.fn(async () => { throw new Error('nope'); }) });
    const plain = agent('plain', undefined);
    const f = await setup({ adapters: [hanging, failing, plain], summarizeTimeoutMs: 50 });
    for (const agentId of ['fake', 'host-agent', 'plain']) {
      const bot = await createBot(f.gateway, botInput({ agentId, compaction: { maxMessages: 2, keepRecent: 1 } }));
      const sessionId = await botSession(f.gateway, bot.id);
      await finished(f.events, await send(f.gateway, sessionId, owner, `First line for ${agentId}\nsecond line`));
      await finished(f.events, await send(f.gateway, sessionId, owner, 'Again'));
      await vi.waitFor(async () => expect((await openSession(f.gateway, sessionId)).summary).toBeDefined());
      const session = await openSession(f.gateway, sessionId);
      expect(session.summary).toBe(`Earlier conversation (3 messages compacted):\n- user: First line for ${agentId} second line\n- assistant: Hello\n- user: Again`);
      expect(session.messages.map(message => message.content)).toEqual(['Hello']);
    }
    expect(signal?.aborted).toBe(true);
  });

  it('compacts on demand with session.compact and refuses while a task runs', async () => {
    const release = gate(); let block = false;
    const f = await setup({ adapters: [agent('fake', undefined, async context => { if (block) await release.promise; context.emit({ type: 'text', text: 'ok' }); })] });
    const bot = await createBot(f.gateway, botInput({ agentId: 'fake', compaction: { maxMessages: 100, keepRecent: 1 } }));
    const sessionId = await botSession(f.gateway, bot.id);
    await finished(f.events, await send(f.gateway, sessionId));
    const compacted = await f.gateway.dispatch(cmd({ type: 'session.compact', sessionId }), owner); ok(compacted);
    expect(compacted.session).toMatchObject({ compactedCount: 1, messages: [{ content: 'ok' }] });
    block = true;
    const taskId = await send(f.gateway, sessionId);
    expect(await f.gateway.dispatch(cmd({ type: 'session.compact', sessionId }), owner)).toMatchObject({ ok: false, error: { code: 'SESSION_BUSY' } });
    release.open(); await finished(f.events, taskId);
    // Without a policy, session.compact keeps the 10 most recent messages.
    const plainBot = await createBot(f.gateway, botInput({ agentId: 'fake', name: 'Plain' }));
    const plain = await botSession(f.gateway, plainBot.id);
    for (let i = 0; i < 6; i++) await finished(f.events, await send(f.gateway, plain));
    const result = await f.gateway.dispatch(cmd({ type: 'session.compact', sessionId: plain }), owner); ok(result);
    expect(result.session).toMatchObject({ compactedCount: 2 });
    expect((result.session as SessionV2).messages).toHaveLength(10);
  });
});
