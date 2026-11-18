// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AppSnapshotV2, PermissionRequestV2, Routine, StandingGrant } from '@your-bot/contracts';
import { App } from '../src/renderer/App';
import { agents, coder, harness, helper, session, T0, type Responder } from './support';

afterEach(() => cleanup());
async function open(initial: Partial<AppSnapshotV2> = {}, respond?: Responder) {
  const h = harness({ bots: [coder, helper], sessions: [session('s1', 'bot-1', 'Coder chat'), session('s2', 'bot-2', 'Helper chat'), session('s0', undefined, 'Legacy chat')], ...initial }, respond);
  render(createElement(App, { transport: h.transport }));
  await screen.findByText('Backend connected');
  return { ...h, user: userEvent.setup() };
}
const nav = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const base = { id: 'req-1', principalId: 'local-owner', sessionId: 's1', taskId: 't1', botId: 'bot-1', reason: 'The agent needs access' };
const request = (extra: Partial<PermissionRequestV2>): PermissionRequestV2 => ({ ...base, capability: 'file.read', ...extra });
const fileRequest = request({ capability: 'file.write', paths: [{ path: '/w/src/index.ts', access: 'write' }] });

describe('sidebar', () => {
  it('groups sessions by bot and starts bot sessions with bot.session.create', async () => {
    const { user, commands } = await open();
    const coderGroup = screen.getByRole('group', { name: 'Bot Coder' });
    expect(within(coderGroup).getByText('Coder chat')).toBeTruthy(); expect(within(coderGroup).queryByText('Helper chat')).toBeNull();
    expect(within(screen.getByRole('group', { name: 'Bot Helper' })).getByText('Helper chat')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Other conversations' })).getByText('Legacy chat')).toBeTruthy();
    expect(within(coderGroup).getByText('trusted')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'New session in Helper' }));
    await waitFor(() => expect(commands('bot.session.create')).toHaveLength(1));
    expect(commands('bot.session.create')[0]).toMatchObject({ version: 2, botId: 'bot-2' });
  });
});

describe('bot editor', () => {
  it('creates a trusted bot with the exact v2 command, after showing the trusted warning', async () => {
    const { user, commands, chooseDirectory } = await open({ skills: [{ id: 'summarize', name: 'Summarize', description: 'Shorten text', source: 'global', folder: '/s/summarize' }, { id: 'broken', name: 'broken', description: '', source: 'global', folder: '/s/broken', error: 'No description' }] });
    await user.click(nav('Bots'));
    await user.click(screen.getByRole('button', { name: 'New bot' }));
    const dialog = await screen.findByRole('dialog', { name: 'New bot' });
    expect(within(dialog).queryByText(/Trusted bots run uncontained/)).toBeNull();
    await user.type(within(dialog).getByLabelText('Name'), 'Release bot');
    await user.type(within(dialog).getByLabelText('Instructions'), 'Ship it');
    await user.selectOptions(within(dialog).getByLabelText('Agent'), 'grok');
    await user.selectOptions(within(dialog).getByLabelText('Model'), 'grok-mini');
    await user.click(within(dialog).getByRole('radio', { name: /Trusted/ }));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/uncontained, with your user.s file rights and network access/);
    await user.click(within(dialog).getByRole('button', { name: 'Create bot' }));
    expect(within(dialog).getAllByRole('alert').at(-1)!.textContent).toBe('Trusted bots need a workspace folder.');
    await user.click(within(dialog).getByRole('button', { name: 'Browse…' }));
    await waitFor(() => expect((within(dialog).getByLabelText('Workspace folder') as HTMLInputElement).value).toBe('/home/me/project'));
    expect(chooseDirectory).toHaveBeenCalledOnce();
    await user.click(within(dialog).getByRole('button', { name: 'Create bot' }));
    expect(within(dialog).getAllByRole('alert').at(-1)!.textContent).toMatch(/understand/);
    await user.click(within(dialog).getByRole('checkbox', { name: /I understand/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Add browser automation' }));
    expect((within(dialog).getByRole('button', { name: 'Add browser automation' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole('checkbox', { name: /broken/ }) as HTMLInputElement).disabled).toBe(true);
    await user.click(within(dialog).getByRole('checkbox', { name: /Summarize/ }));
    await user.click(within(dialog).getByRole('checkbox', { name: /Compact long conversations/ }));
    await user.clear(within(dialog).getByLabelText('Compact above (messages)')); await user.type(within(dialog).getByLabelText('Compact above (messages)'), '40');
    await user.clear(within(dialog).getByLabelText('Keep recent (messages)')); await user.type(within(dialog).getByLabelText('Keep recent (messages)'), '8');
    await user.click(within(dialog).getByRole('button', { name: 'Create bot' }));
    await waitFor(() => expect(commands('bot.create')).toHaveLength(1));
    expect(commands('bot.create')[0]).toEqual({
      version: 2, id: expect.any(String), type: 'bot.create',
      bot: { name: 'Release bot', instructions: 'Ship it', agentId: 'grok', modelId: 'grok-mini', workspace: '/home/me/project', profile: 'trusted',
        mcpServers: [{ id: 'browser', name: 'Browser automation', enabled: true, preset: 'browser', transport: 'stdio', command: 'npx' }], skills: ['summarize'], memoryEnabled: true, compaction: { maxMessages: 40, keepRecent: 8 } },
    });
  });
  it('creates a strict bot with a custom MCP server and omits unset optional fields', async () => {
    const { user, commands } = await open({ bots: [] });
    await user.click(nav('Bots'));
    await user.click(screen.getByRole('button', { name: 'New bot' }));
    const dialog = await screen.findByRole('dialog', { name: 'New bot' });
    await user.type(within(dialog).getByLabelText('Name'), 'Plain');
    await user.selectOptions(within(dialog).getByLabelText('Model'), '');
    await user.click(within(dialog).getByRole('button', { name: 'Add MCP server' }));
    await user.type(within(dialog).getByLabelText('Name', { selector: 'fieldset input' }), 'Tracker');
    await user.type(within(dialog).getByLabelText('Command'), 'tracker-mcp');
    await user.click(within(dialog).getByRole('button', { name: /Add environment/ }));
    await user.type(within(dialog).getByLabelText('Environment name 1'), 'TOKEN');
    await user.type(within(dialog).getByLabelText('Environment value 1'), 's3cret');
    await user.click(within(dialog).getByRole('button', { name: 'Create bot' }));
    await waitFor(() => expect(commands('bot.create')).toHaveLength(1));
    expect(commands('bot.create')[0].bot).toEqual({
      name: 'Plain', instructions: '', agentId: 'grok', profile: 'strict', skills: [], memoryEnabled: true,
      mcpServers: [{ id: 'server-1', name: 'Tracker', enabled: true, transport: 'stdio', command: 'tracker-mcp', env: { TOKEN: 's3cret' } }],
    });
  });
  it('edits with a minimal patch: null clears optional fields and unchanged secrets are not resent', async () => {
    const { user, commands } = await open();
    await user.click(nav('Bots'));
    await user.click(screen.getByRole('button', { name: 'Edit Coder' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit bot: Coder' });
    // Stored secret: key shown, value blank.
    expect((within(dialog).getByLabelText('Environment name 1') as HTMLInputElement).value).toBe('TOKEN');
    expect((within(dialog).getByLabelText('Environment value 1') as HTMLInputElement).value).toBe('');
    await user.click(within(dialog).getByRole('button', { name: 'Save bot' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commands('bot.update')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Edit Coder' }));
    const again = await screen.findByRole('dialog', { name: 'Edit bot: Coder' });
    await user.selectOptions(within(again).getByLabelText('Model'), '');
    await user.click(within(again).getByRole('radio', { name: /Strict/ }));
    await user.click(within(again).getByRole('button', { name: 'Clear' }));
    await user.click(within(again).getByRole('checkbox', { name: /Compact long conversations/ }));
    await user.click(within(again).getByRole('checkbox', { name: /Remember things/ }));
    await user.click(within(again).getByRole('button', { name: 'Save bot' }));
    await waitFor(() => expect(commands('bot.update')).toHaveLength(1));
    expect(commands('bot.update')[0]).toEqual({ version: 2, id: expect.any(String), type: 'bot.update', botId: 'bot-1', patch: { profile: 'strict', memoryEnabled: false, modelId: null, workspace: null, compaction: null } });
  });
  it('sends rotated MCP secrets with blank values for the keys that stay unchanged', async () => {
    const { user, commands } = await open({ bots: [{ ...coder, mcpServers: [{ id: 'tracker', name: 'Tracker', enabled: true, transport: 'stdio', command: 'tracker-mcp', env: { TOKEN: '', OTHER: '' } }] }] });
    await user.click(nav('Bots'));
    await user.click(screen.getByRole('button', { name: 'Edit Coder' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit bot: Coder' });
    await user.type(within(dialog).getByLabelText('Environment value 1'), 'rotated');
    await user.click(within(dialog).getByRole('button', { name: 'Save bot' }));
    await waitFor(() => expect(commands('bot.update')).toHaveLength(1));
    expect(commands('bot.update')[0].patch).toEqual({ mcpServers: [{ id: 'tracker', name: 'Tracker', enabled: true, transport: 'stdio', command: 'tracker-mcp', env: { TOKEN: 'rotated', OTHER: '' } }] });
  });
  it('shows the trusted warning when editing a trusted bot and not for a strict one', async () => {
    const { user } = await open();
    await user.click(nav('Bots'));
    await user.click(screen.getByRole('button', { name: 'Edit Coder' }));
    expect((await screen.findByRole('dialog', { name: 'Edit bot: Coder' })).textContent).toMatch(/Trusted bots run uncontained/);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Edit Helper' }));
    expect((await screen.findByRole('dialog', { name: 'Edit bot: Helper' })).textContent).not.toMatch(/Trusted bots run uncontained/);
  });
  it('lists, adds and deletes memory entries', async () => {
    const entry = { id: 'm1', botId: 'bot-1', content: 'Prefers tabs', source: 'owner' as const, createdAt: T0 };
    const { user, commands } = await open({}, command => {
      if (command.type === 'memory.list') return { memory: [entry] };
      if (command.type === 'memory.add') return { memory: [{ ...entry, id: 'm2', content: command.content }, entry] };
      if (command.type === 'memory.delete') return { memory: [] };
    });
    await user.click(nav('Bots'));
    await user.click(screen.getByRole('button', { name: 'Memory for Coder' }));
    const dialog = await screen.findByRole('dialog', { name: 'Memory: Coder' });
    await within(dialog).findByText('Prefers tabs');
    await user.type(within(dialog).getByLabelText('Add a memory'), 'Uses pnpm');
    await user.click(within(dialog).getByRole('button', { name: 'Add memory' }));
    await within(dialog).findByText('Uses pnpm');
    expect(commands('memory.add')[0]).toMatchObject({ botId: 'bot-1', content: 'Uses pnpm' });
    await user.click(within(dialog).getByRole('button', { name: /Delete memory Uses pnpm/ }));
    await waitFor(() => expect(commands('memory.delete')[0]).toMatchObject({ botId: 'bot-1', memoryId: 'm2' }));
  });
});

describe('approval dialog', () => {
  const dialogFor = async (req: PermissionRequestV2, initial: Partial<AppSnapshotV2> = {}, respond?: Responder) => {
    const ctx = await open({ pendingPermissions: [req], ...initial }, respond);
    return { ...ctx, dialog: await screen.findByRole('dialog', { name: 'Your permission is needed' }) };
  };
  it('renders file paths, bot and capability', async () => {
    const { dialog } = await dialogFor(fileRequest);
    expect(within(dialog).getByText('file.write')).toBeTruthy(); expect(within(dialog).getByText('Coder')).toBeTruthy();
    expect(within(dialog).getByText('/w/src/index.ts')).toBeTruthy(); expect(within(dialog).getByText('write')).toBeTruthy();
  });
  it('renders the exact argv, cwd and env names (not values) of a command', async () => {
    const { dialog } = await dialogFor(request({ capability: 'process.spawn', command: { command: 'npm', args: ['run', 'build:prod'], cwd: '/w/app', env: [{ name: 'API_TOKEN', value: 'topsecret' }] } }));
    const argv = within(dialog).getByLabelText('Command arguments');
    expect([...argv.querySelectorAll('code')].map(code => code.textContent)).toEqual(['npm', 'run', 'build:prod']);
    expect(within(dialog).getByText('/w/app')).toBeTruthy(); expect(within(dialog).getByText('API_TOKEN')).toBeTruthy();
    expect(dialog.textContent).not.toContain('topsecret');
    expect(within(dialog).queryByRole('button', { name: 'Always allow…' })).toBeNull();
  });
  it('renders MCP server and tool, agent tool title and kind, and routine run context', async () => {
    const mcp = await dialogFor(request({ capability: 'mcp.call', mcp: { serverId: 'browser', tool: 'browser_click' } }));
    expect(within(mcp.dialog).getByText('browser')).toBeTruthy(); expect(within(mcp.dialog).getByText('browser_click')).toBeTruthy();
    cleanup();
    const tool = await dialogFor(request({ capability: 'tool.execute', agentTool: { toolCallId: 'tc', title: 'Edit src/app.ts', kind: 'edit' } }));
    expect(within(tool.dialog).getByText('Edit src/app.ts')).toBeTruthy(); expect(within(tool.dialog).getByText('edit')).toBeTruthy();
    cleanup();
    const routine: Routine = { id: 'rt', botId: 'bot-1', name: 'Nightly build', prompt: 'p', schedule: { kind: 'interval', everyMinutes: 60 }, missedRunPolicy: 'skip', enabled: true, sessionMode: 'new', createdAt: T0, updatedAt: T0 };
    const routed = await dialogFor(request({ routineRunId: 'run-9', paths: [{ path: '/w/a', access: 'read' }] }), { routines: [routine], routineRuns: [{ id: 'run-9', routineId: 'rt', botId: 'bot-1', trigger: 'schedule', scheduledFor: T0, status: 'blocked', blockedOn: ['req-1'] }] });
    expect(within(routed.dialog).getByText('Nightly build')).toBeTruthy(); expect(within(routed.dialog).getByText(/run-9 · schedule/)).toBeTruthy();
  });
  it('sends once/task/deny decisions unchanged', async () => {
    const { user, dialog, commands } = await dialogFor(fileRequest);
    await user.click(within(dialog).getByRole('button', { name: 'Allow for this task' }));
    await waitFor(() => expect(commands('permission.decide')).toHaveLength(1));
    expect(commands('permission.decide')[0].decision).toEqual({ requestId: 'req-1', outcome: 'allow', scope: 'task' });
    await user.click(within(dialog).getByRole('button', { name: 'Deny' }));
    expect(commands('permission.decide')[1].decision).toEqual({ requestId: 'req-1', outcome: 'deny', scope: 'once' });
  });
  it('builds a folder standing scope that must stay a parent of the file', async () => {
    const { user, dialog, commands } = await dialogFor(fileRequest);
    await user.click(within(dialog).getByRole('button', { name: 'Always allow…' }));
    const folder = within(dialog).getByLabelText('Folder') as HTMLInputElement;
    expect(folder.value).toBe('/w/src');
    const confirm = within(dialog).getByRole('button', { name: 'Always allow' }) as HTMLButtonElement;
    await user.clear(folder); await user.type(folder, '/w/src/deeper');
    expect(confirm.disabled).toBe(true); expect(within(dialog).getByText(/parent of every requested path/)).toBeTruthy();
    await user.clear(folder); await user.type(folder, '/elsewhere');
    expect(confirm.disabled).toBe(true);
    await user.clear(folder); await user.type(folder, '/w');
    expect(confirm.disabled).toBe(false);
    await user.selectOptions(within(dialog).getByLabelText('Expires'), '24 hours');
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-01T00:00:00.000Z') });
    try { await user.click(confirm); } finally { vi.useRealTimers(); }
    await waitFor(() => expect(commands('permission.decide')).toHaveLength(1));
    expect(commands('permission.decide')[0].decision).toEqual({ requestId: 'req-1', outcome: 'allow', scope: 'standing', standing: { folder: '/w' }, standingExpiresAt: '2026-03-02T00:00:00.000Z' });
  });
  it('builds argv-prefix, MCP and agent-tool-kind standing scopes', async () => {
    const spawn = await dialogFor(request({ capability: 'process.spawn', command: { command: 'npm', args: ['test', '--silent'], cwd: '/w' } }));
    await spawn.user.click(within(spawn.dialog).getByRole('button', { name: 'Always allow…' }));
    expect((within(spawn.dialog).getByLabelText('Prefix token 1') as HTMLInputElement).value).toBe('npm');
    await spawn.user.click(within(spawn.dialog).getByRole('button', { name: 'Add next token' }));
    expect((within(spawn.dialog).getByLabelText('Prefix token 2') as HTMLInputElement).value).toBe('test');
    await spawn.user.type(within(spawn.dialog).getByLabelText('Prefix token 2'), 'x');
    expect((within(spawn.dialog).getByRole('button', { name: 'Always allow' }) as HTMLButtonElement).disabled).toBe(true);
    await spawn.user.click(within(spawn.dialog).getByRole('button', { name: 'Remove last token' }));
    await spawn.user.click(within(spawn.dialog).getByRole('button', { name: 'Always allow' }));
    await waitFor(() => expect(spawn.commands('permission.decide')).toHaveLength(1));
    expect(spawn.commands('permission.decide')[0].decision).toEqual({ requestId: 'req-1', outcome: 'allow', scope: 'standing', standing: { commandPrefix: ['npm'] } });
    cleanup();
    const mcp = await dialogFor(request({ capability: 'mcp.call', mcp: { serverId: 'browser', tool: 'browser_click' } }));
    await mcp.user.click(within(mcp.dialog).getByRole('button', { name: 'Always allow…' }));
    await mcp.user.click(within(mcp.dialog).getByRole('radio', { name: /Every tool on browser/ }));
    await mcp.user.click(within(mcp.dialog).getByRole('button', { name: 'Always allow' }));
    await waitFor(() => expect(mcp.commands('permission.decide')).toHaveLength(1));
    expect(mcp.commands('permission.decide')[0].decision).toMatchObject({ scope: 'standing', standing: { mcp: { serverId: 'browser' } } });
    expect(mcp.commands('permission.decide')[0].decision.standing?.mcp).not.toHaveProperty('tool');
    cleanup();
    const tool = await dialogFor(request({ capability: 'tool.execute', agentTool: { toolCallId: 'tc', title: 'Edit', kind: 'edit' } }));
    await tool.user.click(within(tool.dialog).getByRole('button', { name: 'Always allow…' }));
    await tool.user.click(within(tool.dialog).getByRole('button', { name: 'Always allow' }));
    await waitFor(() => expect(tool.commands('permission.decide')).toHaveLength(1));
    expect(tool.commands('permission.decide')[0].decision).toEqual({ requestId: 'req-1', outcome: 'allow', scope: 'standing', standing: { agentToolKind: 'edit' } });
  });
  it('offers no standing option for custom Python, installs, network, settings or env commands', async () => {
    const forbidden: PermissionRequestV2[] = [
      request({ capability: 'tool.execute', reason: 'Execute custom Python sha256:deadbeef' }),
      request({ capability: 'library.install', packages: ['numpy'] }), request({ capability: 'network' }), request({ capability: 'settings' }),
      request({ capability: 'process.spawn', command: { command: 'make', args: [], cwd: '/w', env: [{ name: 'CC', value: 'gcc' }] } }),
    ];
    for (const req of forbidden) {
      const { dialog } = await dialogFor(req);
      expect(within(dialog).getByRole('button', { name: 'Allow once' })).toBeTruthy();
      expect(within(dialog).queryByRole('button', { name: /Always allow/ })).toBeNull();
      cleanup();
    }
  });
});

describe('permissions page', () => {
  const grant: StandingGrant = { id: 'g1', botId: 'bot-1', capability: 'file.write', scope: { folder: '/w/src' }, createdAt: T0, createdBy: 'local-owner' };
  const entries = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${from + i}`, at: T0, botId: 'bot-1', taskId: 't', sessionId: 's1', requestId: 'r', capability: 'file.write' as const, subject: `/w/src/f${from + i}.ts`, outcome: (i % 2 ? 'deny' : 'allow') as 'allow' | 'deny', via: (i % 2 ? 'interactive' : 'standing') as 'standing' | 'interactive' }));
  it('revokes a grant and pages the audit log with via/outcome', async () => {
    const { user, commands } = await open({ grants: [grant] }, command => command.type === 'audit.list' ? { audit: command.beforeId ? entries(51, 1) : entries(1, 50) } : undefined);
    await user.click(nav('Permissions'));
    const grants = await screen.findByLabelText('Grant g1');
    expect(within(grants).getByText('folder /w/src')).toBeTruthy();
    const log = await screen.findByRole('list', { name: 'Audit log' });
    await waitFor(() => expect(within(log).getAllByRole('listitem')).toHaveLength(50));
    const first = within(log).getAllByRole('listitem')[0];
    expect(within(first).getByText('allow')).toBeTruthy(); expect(within(first).getByText('standing')).toBeTruthy();
    expect(within(within(log).getAllByRole('listitem')[1]).getByText('interactive')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Load older entries' }));
    await waitFor(() => expect(within(log).getAllByRole('listitem')).toHaveLength(51));
    expect(commands('audit.list').map(c => [c.limit, c.beforeId])).toEqual([[50, undefined], [50, 'a50']]);
    expect(screen.queryByRole('button', { name: 'Load older entries' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Revoke Coder file.write grant' }));
    await waitFor(() => expect(commands('grant.revoke')).toHaveLength(1));
    expect(commands('grant.revoke')[0].grantId).toBe('g1');
    await waitFor(() => expect(screen.queryByLabelText('Grant g1')).toBeNull());
  });
  it('lists pending approvals and reopens one for review after it was dismissed', async () => {
    const { user } = await open({ pendingPermissions: [fileRequest] });
    const dialog = await screen.findByRole('dialog', { name: 'Your permission is needed' });
    await user.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(nav('Permissions'));
    await user.click(await screen.findByRole('button', { name: 'Review file.write request' }));
    expect(await screen.findByRole('dialog', { name: 'Your permission is needed' })).toBeTruthy();
  });
});

describe('routines', () => {
  const routine: Routine = { id: 'rt1', botId: 'bot-1', name: 'Nightly', prompt: 'Run tests', schedule: { kind: 'interval', everyMinutes: 60 }, missedRunPolicy: 'skip', enabled: true, sessionMode: 'new', createdAt: T0, updatedAt: T0 };
  it('turns the form into the exact routine.create command', async () => {
    const { user, commands } = await open();
    await user.click(nav('Routines'));
    await user.click(screen.getByRole('button', { name: 'New routine' }));
    const dialog = await screen.findByRole('dialog', { name: 'New routine' });
    await user.type(within(dialog).getByLabelText('Name'), 'Weekday check');
    await user.selectOptions(within(dialog).getByLabelText('Bot'), 'bot-1');
    await user.type(within(dialog).getByLabelText('Prompt'), 'Summarise failures');
    await user.selectOptions(within(dialog).getByLabelText('Schedule'), 'cron');
    await user.clear(within(dialog).getByLabelText('Cron expression')); await user.type(within(dialog).getByLabelText('Cron expression'), '30 8 * * 1-5');
    await user.clear(within(dialog).getByLabelText('Timezone')); await user.type(within(dialog).getByLabelText('Timezone'), 'Europe/Berlin');
    await user.selectOptions(within(dialog).getByLabelText('If runs were missed'), 'runAll');
    await user.clear(within(dialog).getByLabelText('At most (catch-up runs)')); await user.type(within(dialog).getByLabelText('At most (catch-up runs)'), '4');
    await user.selectOptions(within(dialog).getByLabelText('Conversation'), 'reuse');
    await user.click(within(dialog).getByRole('button', { name: 'Create routine' }));
    await waitFor(() => expect(commands('routine.create')).toHaveLength(1));
    expect(commands('routine.create')[0]).toEqual({ version: 2, id: expect.any(String), type: 'routine.create', routine: {
      botId: 'bot-1', name: 'Weekday check', prompt: 'Summarise failures', schedule: { kind: 'cron', expression: '30 8 * * 1-5', timezone: 'Europe/Berlin' },
      missedRunPolicy: 'runAll', maxCatchUp: 4, enabled: true, sessionMode: 'reuse' } });
  });
  it('validates the schedule locally and builds interval and once schedules', async () => {
    const { user, commands } = await open();
    await user.click(nav('Routines'));
    await user.click(screen.getByRole('button', { name: 'New routine' }));
    const dialog = await screen.findByRole('dialog', { name: 'New routine' });
    await user.type(within(dialog).getByLabelText('Name'), 'Once'); await user.type(within(dialog).getByLabelText('Prompt'), 'Do it');
    await user.selectOptions(within(dialog).getByLabelText('Schedule'), 'once');
    await user.click(within(dialog).getByRole('button', { name: 'Create routine' }));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/date and time/);
    expect(commands('routine.create')).toHaveLength(0);
    await user.type(within(dialog).getByLabelText('Run at'), '2030-05-06T07:08');
    await user.click(within(dialog).getByRole('button', { name: 'Create routine' }));
    await waitFor(() => expect(commands('routine.create')).toHaveLength(1));
    const { schedule } = commands('routine.create')[0].routine;
    expect(schedule).toEqual({ kind: 'once', at: new Date('2030-05-06T07:08').toISOString() });
  });
  it('edits with a patch, runs now, and links a blocked run to its pending approval', async () => {
    const approval = request({ id: 'req-run', routineRunId: 'run-1', capability: 'process.spawn', command: { command: 'npm', args: ['test'], cwd: '/w' } });
    const blocked = { id: 'run-1', routineId: 'rt1', botId: 'bot-1', trigger: 'manual' as const, scheduledFor: T0, status: 'blocked' as const, blockedOn: ['req-run'] };
    const failed = { id: 'run-0', routineId: 'rt1', botId: 'bot-1', trigger: 'schedule' as const, scheduledFor: '2026-02-28T09:00:00.000Z', status: 'failed' as const, error: { code: 'X', message: 'Agent crashed' } };
    const { user, commands } = await open({ routines: [routine], routineRuns: [blocked, failed], pendingPermissions: [approval] }, command => command.type === 'routine.runs' ? { runs: [blocked, failed] } : undefined);
    const dialog = await screen.findByRole('dialog', { name: 'Your permission is needed' });
    await user.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
    await user.click(nav('Routines'));
    await user.click(screen.getByRole('button', { name: 'Run Nightly now' }));
    await waitFor(() => expect(commands('routine.runNow')[0]).toMatchObject({ routineId: 'rt1' }));
    await user.click(screen.getByRole('button', { name: 'Runs' }));
    const runs = await screen.findByRole('list', { name: 'Runs of Nightly' });
    expect(within(runs).getByText('blocked')).toBeTruthy(); expect(within(runs).getByText('failed')).toBeTruthy(); expect(within(runs).getByText('Agent crashed')).toBeTruthy();
    expect(commands('routine.runs')[0]).toMatchObject({ routineId: 'rt1', limit: 20 });
    await user.click(within(runs).getByRole('button', { name: 'Review approval' }));
    const approvalDialog = await screen.findByRole('dialog', { name: 'Your permission is needed' });
    expect(within(approvalDialog).getByText('Nightly')).toBeTruthy();
    expect(within(approvalDialog).getByText('npm')).toBeTruthy();
    await user.click(within(approvalDialog).getByRole('button', { name: 'Close dialog' }));
    await user.click(screen.getByRole('button', { name: 'Edit Nightly' }));
    const editor = await screen.findByRole('dialog', { name: 'Edit routine: Nightly' });
    await user.clear(within(editor).getByLabelText('Every (minutes)')); await user.type(within(editor).getByLabelText('Every (minutes)'), '30');
    await user.click(within(editor).getByRole('checkbox', { name: 'Enabled' }));
    await user.click(within(editor).getByRole('button', { name: 'Save routine' }));
    await waitFor(() => expect(commands('routine.update')).toHaveLength(1));
    expect(commands('routine.update')[0]).toMatchObject({ routineId: 'rt1', patch: { schedule: { kind: 'interval', everyMinutes: 30 }, enabled: false } });
    expect(Object.keys(commands('routine.update')[0].patch).sort()).toEqual(['enabled', 'schedule']);
  });
});

describe('notifications', () => {
  it('shows an unread badge, links to approvals and acknowledges', async () => {
    const note = { id: 'n1', kind: 'approval.required' as const, title: 'Nightly needs approval', body: 'npm test', botId: 'bot-1', requestId: 'req-1', createdAt: T0 };
    const read = { id: 'n2', kind: 'device.paired' as const, title: 'Phone paired', body: 'ok', createdAt: T0, acknowledgedAt: T0 };
    const { user, commands } = await open({ notifications: [note, read], pendingPermissions: [fileRequest] });
    await user.click(within(await screen.findByRole('dialog', { name: 'Your permission is needed' })).getByRole('button', { name: 'Close dialog' }));
    expect(within(nav('Notifications')).getByLabelText('1 waiting')).toBeTruthy();
    await user.click(nav('Notifications'));
    const list = await screen.findByRole('list', { name: 'Notifications' });
    expect(within(list).getByLabelText('Unread: Nightly needs approval')).toBeTruthy();
    expect(within(list).queryByRole('button', { name: 'Acknowledge Phone paired' })).toBeNull();
    await user.click(within(list).getByRole('button', { name: 'Review approval' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Your permission is needed' })).getByRole('button', { name: 'Close dialog' }));
    await user.click(within(list).getByRole('button', { name: 'Acknowledge Nightly needs approval' }));
    await waitFor(() => expect(commands('notification.ack')).toHaveLength(1));
    expect(commands('notification.ack')[0].notificationId).toBe('n1');
    await waitFor(() => expect(within(nav('Notifications')).queryByLabelText('1 waiting')).toBeNull());
    expect(within(list).queryByLabelText('Unread: Nightly needs approval')).toBeNull();
  });
});

describe('devices', () => {
  it('shows the one-time pairing code with its expiry and lists devices with revoke', async () => {
    const expiresAt = '2030-01-01T10:10:00.000Z';
    const device = { id: 'd1', name: 'Phone', capabilities: ['conversation' as const], pairedAt: T0 };
    const { user, commands } = await open({ devices: [device], host: { id: 'h', name: 'Workstation' } }, command => command.type === 'device.pair.start' ? { pairing: { code: 'ybp1.ABC123-secret-code', expiresAt, hostFingerprint: 'AA:BB', urls: ['wss://192.168.1.5:7443'] } } : undefined);
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    await user.click(nav('Devices'));
    expect(screen.getByText('Phone')).toBeTruthy();
    await user.type(screen.getByLabelText('Device name (optional)'), 'Tablet');
    await user.click(screen.getByRole('button', { name: 'Pair a device' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pair a device' });
    expect((within(dialog).getByLabelText('Pairing code') as HTMLInputElement).value).toBe('ybp1.ABC123-secret-code');
    expect(dialog.textContent).toContain(new Date(expiresAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }));
    expect(commands('device.pair.start')[0]).toMatchObject({ name: 'Tablet' });
    await user.click(within(dialog).getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('ybp1.ABC123-secret-code');
    await within(dialog).findByText('Copied');
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByDisplayValue('ybp1.ABC123-secret-code')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Revoke Phone' }));
    await waitFor(() => expect(commands('device.revoke')[0]).toMatchObject({ deviceId: 'd1' }));
  });
  it('offers no revoke buttons when the host reports no devices, and explains unsupported pairing', async () => {
    const { user } = await open({ devices: [] }, command => command.type === 'device.pair.start' ? { ok: false, commandId: command.id, error: { code: 'NOT_SUPPORTED', message: 'nope' } } : undefined);
    await user.click(nav('Devices'));
    expect(screen.queryByRole('button', { name: /^Revoke/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Pair a device' }));
    await waitFor(() => expect(screen.getAllByRole('alert').map(alert => alert.textContent)).toContain('This host does not support pairing devices.'));
  });
});

describe('provider settings', () => {
  it('configures a host-launched ACP agent for trusted bots with an exact settings.update', async () => {
    const { user, commands } = await open();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    await user.click(within(dialog).getByRole('tab', { name: 'Providers' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add provider' }));
    await user.selectOptions(within(dialog).getByLabelText('Provider type'), 'acp');
    await user.selectOptions(within(dialog).getByLabelText('Launch mode'), 'host');
    expect(within(dialog).getByRole('note').textContent).toMatch(/uncontained/);
    await user.type(within(dialog).getByLabelText('Agent command'), 'grok');
    await user.type(within(dialog).getByLabelText('Arguments (one per line)'), 'agent{Enter}stdio');
    await user.type(within(dialog).getByLabelText(/Environment variables to pass through/), 'GROK_API_KEY');
    await user.click(within(dialog).getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(commands('settings.update')).toHaveLength(1));
    expect(commands('settings.update')[0].settings.providers).toEqual([{ id: expect.any(String), name: 'Local provider', kind: 'acp', enabled: true, launch: 'host', command: 'grok', args: ['agent', 'stdio'], envPassthrough: ['GROK_API_KEY'], endpoint: 'http://127.0.0.1:8080/v1' }]);
  });
});

describe('agents on this computer', () => {
  const agent = (extra: object) => ({ id: 'claude', name: 'Claude Code', installed: true, version: '2.1.0', auth: 'signed-in', providerId: 'agent-claude', linked: false, installHint: 'npm i -g x', docs: 'https://docs.example', ...extra });
  const scan = () => ({ agents: [agent({ latestVersion: '2.2.0', updateAvailable: true, install: { kind: 'mise', label: 'mise (claude)' }, update: { command: 'mise upgrade claude' } }), agent({ id: 'codex', name: 'Codex', auth: 'signed-out', login: 'codex login', update: { manual: 'Update Codex with brew' }, missingNpx: true }), agent({ id: 'grok', name: 'Grok Build', installed: false, installHint: 'curl grok.sh | bash' })], servers: [{ id: 'ollama', name: 'Ollama', endpoint: 'http://127.0.0.1:11434', running: true, models: ['m'], providerId: 'local-ollama', linked: false }] });
  async function openProviders(providers?: unknown, respond?: Responder) {
    const h = await open({}, respond);
    if (providers) (h.transport as any).providers = providers;
    await h.user.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    await h.user.click(within(dialog).getByRole('tab', { name: 'Providers' }));
    return { ...h, dialog };
  }
  it('lists detected agents, servers and not-installed agents', async () => {
    const api = { scan: vi.fn(async () => scan()), link: vi.fn(), update: vi.fn(), login: vi.fn() };
    const { dialog } = await openProviders(api);
    await within(dialog).findByText('Claude Code');
    expect(within(dialog).getByText('mise (claude)')).toBeTruthy(); expect(within(dialog).getByText('Update available → 2.2.0')).toBeTruthy();
    expect(within(dialog).getByText('Signed in')).toBeTruthy(); expect(within(dialog).getByText('Not signed in')).toBeTruthy();
    expect(within(dialog).getByText(/needs Node\.js/)).toBeTruthy(); expect(within(dialog).getByText('Update Codex with brew')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Connect Ollama' })).toBeTruthy();
    expect(within(dialog).getByText('Not installed (1)')).toBeTruthy(); expect(within(dialog).getByText('curl grok.sh | bash')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Update Codex' })).toBeNull(); expect(within(dialog).queryByRole('button', { name: 'Sign in to Claude Code' })).toBeNull();
    expect(within(dialog).getByText('Manual setup')).toBeTruthy();
  });
  it('connects, refreshes the local provider list and keeps it on Save', async () => {
    const linkedProvider = { id: 'agent-claude', name: 'Claude Code', kind: 'acp', enabled: true, launch: 'host', command: 'claude', args: [] };
    let connected = false;
    const api = { scan: vi.fn(async () => { const s = scan(); if (connected) s.agents[0].linked = true; return s; }), link: vi.fn(async (_t: unknown) => ({ linked: [] as { id: string; name: string; providerId: string; created: boolean }[], skipped: [] })), update: vi.fn(), login: vi.fn() };
    const { dialog, user, commands, snapshot } = await openProviders(api);
    api.link.mockImplementation(async () => { connected = true; snapshot.settings = { providers: [linkedProvider] } as never; return { linked: [{ id: 'claude', name: 'Claude Code', providerId: 'agent-claude', created: true }], skipped: [] }; });
    await user.click(await within(dialog).findByRole('button', { name: 'Connect Claude Code' }));
    await waitFor(() => expect(api.link).toHaveBeenCalledWith(['claude']));
    await within(dialog).findByRole('button', { name: 'Reconnect Claude Code' });
    expect(within(dialog).getByDisplayValue('Claude Code')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(commands('settings.update')).toHaveLength(1));
    expect(commands('settings.update')[0].settings.providers.map(p => p.id)).toEqual(['agent-claude']);
  });
  it('connects everything with Connect all', async () => {
    const api = { scan: vi.fn(async () => scan()), link: vi.fn(async () => ({ linked: [], skipped: [] })), update: vi.fn(), login: vi.fn() };
    const { dialog, user } = await openProviders(api);
    await within(dialog).findByText('Claude Code');
    await user.click(within(dialog).getByRole('button', { name: 'Connect all' }));
    await waitFor(() => expect(api.link).toHaveBeenCalledWith('all'));
  });
  it('shows the update result and output, and rescans', async () => {
    const api = { scan: vi.fn(async () => scan()), link: vi.fn(), update: vi.fn(async () => ({ ok: true, message: 'Claude Code updated to 2.2.0', output: 'installing\ndone' })), login: vi.fn() };
    const { dialog, user } = await openProviders(api);
    await user.click(await within(dialog).findByRole('button', { name: 'Update Claude Code' }));
    await within(dialog).findByText(/Claude Code updated to 2\.2\.0/);
    expect(within(dialog).getByText(/installing/)).toBeTruthy(); expect(api.update).toHaveBeenCalledWith('claude');
    await waitFor(() => expect(api.scan).toHaveBeenCalledTimes(2));
  });
  it('opens sign-in in the terminal and explains the next step', async () => {
    const api = { scan: vi.fn(async () => scan()), link: vi.fn(), update: vi.fn(), login: vi.fn(async () => ({ ok: true })) };
    const { dialog, user } = await openProviders(api);
    await user.click(await within(dialog).findByRole('button', { name: 'Sign in to Codex' }));
    expect(api.login).toHaveBeenCalledWith('codex');
    await within(dialog).findByText(/terminal window that opened/);
  });
  it('hides the section when the host has no providers API', async () => {
    const { dialog } = await openProviders();
    expect(within(dialog).queryByText('Agents on this computer')).toBeNull(); expect(within(dialog).getByRole('button', { name: 'Add provider' })).toBeTruthy();
  });
});
void agents;
