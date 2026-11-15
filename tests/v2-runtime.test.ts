import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppSettingsV2, BotInput, DesktopEventV2, StandingGrantInput } from '@your-bot/contracts';
import { createRuntime, type Runtime, type RuntimeClock } from '@your-bot/runtime';
import { command, ok, onCleanup, tempDir, trustedFixture, waitFor } from './v2-helpers.js';

const ACT_SCRIPT = "require('node:fs').writeFileSync('ran.txt','ok\\n')";

function fixtureSettings(): AppSettingsV2 {
  return {
    providers: [{
      id: 'fixture', name: 'Fixture', kind: 'acp', enabled: true, launch: 'host',
      command: process.execPath, args: [trustedFixture, 'act'],
    }],
  };
}

function trustedBot(workspace: string): BotInput {
  return {
    name: 'Worker', instructions: 'Use the client filesystem and terminal.', agentId: 'fixture', profile: 'trusted',
    workspace, mcpServers: [], skills: [], memoryEnabled: false,
  };
}

async function finished(events: DesktopEventV2[], taskId: string, timeoutMs = 25_000): Promise<DesktopEventV2> {
  const terminal = (event: DesktopEventV2) => (event.type === 'task.completed' || event.type === 'task.failed' || event.type === 'task.cancelled') && 'taskId' in event && event.taskId === taskId;
  try {
    await waitFor(() => events.some(terminal), `task ${taskId}`, timeoutMs);
  } catch (error) {
    const summary = events.map(event => event.type).join(',');
    throw new Error(`${error instanceof Error ? error.message : 'timeout'} events=${summary}`);
  }
  const event = events.find(terminal);
  if (!event) throw new Error('missing terminal task event');
  return event;
}

describe('headless runtime', () => {
  it('runs a trusted bot through the real workspace host and approvals', async () => {
    const dataDir = await tempDir('your-bot-v2-run-');
    const workspace = await tempDir('your-bot-v2-ws-');
    const runtime = await createRuntime({ dataDir });
    onCleanup(() => runtime.close());
    const events: DesktopEventV2[] = [];
    runtime.gateway.subscribe(event => {
      events.push(event);
      if (event.type !== 'permission.requested') return;
      void runtime.gateway.dispatch(command({ type: 'permission.decide', decision: { requestId: event.request.id, outcome: 'allow', scope: 'once' } }), runtime.principal);
    }, runtime.principal, { contractVersion: 2 });
    ok(await runtime.gateway.dispatch(command({ type: 'settings.update', settings: fixtureSettings() }), runtime.principal));
    const created = await runtime.gateway.dispatch(command({ type: 'bot.create', bot: trustedBot(workspace) }), runtime.principal);
    ok(created);
    const session = await runtime.gateway.dispatch(command({ type: 'bot.session.create', botId: created.bot!.id }), runtime.principal);
    ok(session);
    const sent = await runtime.gateway.dispatch(command({ type: 'message.send', sessionId: session.sessionId!, content: 'Go' }), runtime.principal);
    ok(sent);
    const done = await finished(events, sent.taskId!);
    expect(done.type, JSON.stringify(done)).toBe('task.completed');
    const requested = events.filter(event => event.type === 'permission.requested').map(event => event.type === 'permission.requested' ? event.request.capability : '');
    expect(requested).toContain('file.write');
    expect(requested).toContain('process.spawn');
    expect(await readFile(join(workspace, 'edited.txt'), 'utf8')).toBe('edited-by-agent\n');
    expect(await readFile(join(workspace, 'ran.txt'), 'utf8')).toBe('ok\n');
  });

  // P4 is not on this base: routine.* returns NOT_SUPPORTED and GatewayOptions does not yet
  // declare clock, notifier, skillCatalog or routineCapabilities. createRuntime still accepts
  // them (see the P4 cast). Switch this to `it` and call `unattendedRoutine` after that merge.
  it.todo('routine ~2s ahead completes unattended under standing grants (blocked on P4 — see unattendedRoutine)');
});

/** Lead: enable the todo above by calling this from `it`. Not executed on this base. */
export async function unattendedRoutine(): Promise<void> {
  const dataDir = await tempDir('your-bot-v2-routine-');
  const workspace = await tempDir('your-bot-v2-routine-ws-');
  const clock: RuntimeClock = {
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const runtime: Runtime = await createRuntime({ dataDir, clock });
  onCleanup(() => runtime.close());
  const events: DesktopEventV2[] = [];
  runtime.gateway.subscribe(event => events.push(event), runtime.principal, { contractVersion: 2 });
  ok(await runtime.gateway.dispatch(command({ type: 'settings.update', settings: fixtureSettings() }), runtime.principal));
  const created = await runtime.gateway.dispatch(command({ type: 'bot.create', bot: trustedBot(workspace) }), runtime.principal);
  ok(created);
  const botId = created.bot!.id;
  const grants: StandingGrantInput[] = [
    { botId, capability: 'file.write', scope: { folder: workspace } },
    { botId, capability: 'process.spawn', scope: { commandPrefix: [process.execPath, '-e', ACT_SCRIPT], folder: workspace } },
  ];
  for (const grant of grants) ok(await runtime.gateway.dispatch(command({ type: 'grant.create', grant }), runtime.principal));
  const at = new Date(clock.now() + 2_000).toISOString();
  ok(await runtime.gateway.dispatch(command({
    type: 'routine.create',
    routine: {
      botId, name: 'soon', prompt: 'Go', enabled: true, sessionMode: 'new', missedRunPolicy: 'skip',
      schedule: { kind: 'once', at },
    },
  }), runtime.principal));
  await waitFor(() => events.some(event => event.type === 'routine.run' && event.run.status === 'completed'), 'routine completion', 20_000);
  expect(events.some(event => event.type === 'permission.requested')).toBe(false);
  expect(await readFile(join(workspace, 'edited.txt'), 'utf8')).toBe('edited-by-agent\n');
  expect(await readFile(join(workspace, 'ran.txt'), 'utf8')).toBe('ok\n');
}

describe('opt-in real agent', () => {
  const run = process.env.YOUR_BOT_REAL_AGENT === 'grok' ? it : it.skip;
  run('grok agent stdio edits a file and runs a command through the runtime', async () => {
    const dataDir = await tempDir('your-bot-v2-grok-');
    const workspace = await tempDir('your-bot-v2-grok-ws-');
    const marker = randomBytes(8).toString('hex');
    const proof = 'your-bot-proof.txt';
    const commandProof = 'your-bot-command.txt';
    const nodeProgram = `require('node:fs').writeFileSync(${JSON.stringify(commandProof)}, process.argv[1] + '\\n')`;
    const runtime = await createRuntime({ dataDir, acpTimeoutMs: 180_000 });
    onCleanup(() => runtime.close());
    const events: DesktopEventV2[] = [];
    runtime.gateway.subscribe(event => {
      events.push(event);
      if (event.type !== 'permission.requested') return;
      void runtime.gateway.dispatch(command({ type: 'permission.decide', decision: { requestId: event.request.id, outcome: 'allow', scope: 'once' } }), runtime.principal);
    }, runtime.principal, { contractVersion: 2 });
    const settings: AppSettingsV2 = {
      providers: [{ id: 'grok', name: 'Grok', kind: 'acp', enabled: true, launch: 'host', command: 'grok', args: ['agent', 'stdio'] }],
    };
    ok(await runtime.gateway.dispatch(command({ type: 'settings.update', settings }), runtime.principal));
    const created = await runtime.gateway.dispatch(command({ type: 'bot.create', bot: { ...trustedBot(workspace), agentId: 'grok', instructions: 'Follow the latest user message exactly and finish.' } }), runtime.principal);
    ok(created);
    const session = await runtime.gateway.dispatch(command({ type: 'bot.session.create', botId: created.bot!.id }), runtime.principal);
    ok(session);
    const content = [
      `Write a file named ${proof} in the workspace whose exact contents are ${marker}.`,
      `Then run this command and wait until it exits: ${process.execPath} -e ${JSON.stringify(nodeProgram)} ${marker}`,
      'Prefer the client filesystem and client terminal tools. Do not ask questions.',
    ].join('\n');
    const sent = await runtime.gateway.dispatch(command({ type: 'message.send', sessionId: session.sessionId!, content }), runtime.principal);
    ok(sent);
    const done = await finished(events, sent.taskId!, 170_000);
    expect(done.type, JSON.stringify(done)).toBe('task.completed');
    expect(await readFile(join(workspace, proof), 'utf8')).toBe(marker);
    expect(await readFile(join(workspace, commandProof), 'utf8')).toContain(marker);
  }, 200_000);
});
