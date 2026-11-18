import { describe, expect, it } from 'vitest';
import type { AppSettingsV2, ProviderConfigV2 } from '@your-bot/contracts';
import type { AgentCliSpec, AgentRow, LinkSummary, ProviderScan, UpdateResult } from '@your-bot/providers';
import { loginSpawnArgs, runCli, type CliIO, type OwnerSession, type ProvidersDeps } from '../apps/host/src/cli.js';

const NOT_RUNNING = 'Your Bot is not running. Open the app (or `your-bot-host run`) and try again.';

function agent(over: Partial<AgentRow> & Pick<AgentRow, 'id' | 'name'>): AgentRow {
  return {
    installed: false, auth: 'unknown', providerId: `agent-${over.id}`, installHint: `install ${over.id}`, docs: 'https://example.test', linked: false,
    ...over,
  };
}

function capture(extra: Partial<CliIO> = {}): { io: CliIO; out: string[]; err: string[]; raw: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const raw: string[] = [];
  return {
    out, err, raw,
    io: { env: {}, stdout: line => out.push(line), stderr: line => err.push(line), write: text => raw.push(text), ...extra },
  };
}

function scanOf(agents: AgentRow[], servers: ProviderScan['servers'] = []): ProviderScan {
  return { agents, servers };
}

describe('providers CLI', () => {
  it('prints a human scan and JSON, using live settings when the app answers', async () => {
    const claude = agent({
      id: 'claude', name: 'Claude Code', installed: true, version: '1.2.3', auth: 'signed-in', updateAvailable: true, linked: true, providerId: 'agent-claude',
      install: { kind: 'npm', label: 'npm global' },
    });
    const gemini = agent({ id: 'gemini', name: 'Gemini CLI', installHint: 'npm install -g @google/gemini-cli' });
    let seen: readonly ProviderConfigV2[] | undefined;
    let scanOptions: { checkUpdates?: boolean; checkAuth?: boolean } | undefined;
    const listed = scanOf([claude, gemini], [{ id: 'ollama', name: 'Ollama', endpoint: 'http://127.0.0.1:11434/v1', running: true, models: ['llama3'], providerId: 'local-ollama', linked: false }, { id: 'lmstudio', name: 'LM Studio', endpoint: 'http://127.0.0.1:1234/v1', running: false, models: [], providerId: 'local-lmstudio', linked: false }]);
    const providers: ProvidersDeps = {
      scanProviders: async (rows, options) => { seen = rows; scanOptions = options; return listed; },
      linkProviders: async settings => ({ settings, linked: [], skipped: [] }),
      updateAgentCli: async () => { throw new Error('not used'); },
      loginTarget: async () => { throw new Error('not used'); },
      agentSpec: () => undefined,
    };
    const live = { id: 'agent-claude', name: 'Claude Code', kind: 'acp' as const, enabled: true };
    const session: OwnerSession = {
      async call(command) {
        expect(command.type).toBe('state.sync');
        return { ok: true, snapshot: { settings: { providers: [live] } } };
      },
      close() {},
    };
    const human = capture({ env: { YOUR_BOT_DATA: '/data' }, providers, connectOwner: async () => session });
    expect(await runCli(['providers', 'list', '--no-updates', '--no-auth'], human.io)).toBe(0);
    expect(seen).toEqual([live]);
    expect(scanOptions).toMatchObject({ checkUpdates: false, checkAuth: false });
    expect(human.out).toEqual([
      'Claude Code  1.2.3  npm global  signed-in  update available  linked agent-claude',
      '',
      'Ollama  http://127.0.0.1:11434/v1  running  1 model  not linked',
      '',
      'Not installed:',
      'Gemini CLI  npm install -g @google/gemini-cli',
    ]);

    const json = capture({ providers, connectOwner: async () => undefined });
    expect(await runCli(['providers', 'list', '--json', '--no-updates'], json.io)).toBe(0);
    const parsed = JSON.parse(json.out.join('\n')) as ProviderScan;
    expect(parsed.agents.map(row => row.id)).toEqual(['claude', 'gemini']);
    expect(parsed.servers).toHaveLength(2);
  });

  it('links through the running app, refuses a stopped app, and exits 1 when every target was skipped', async () => {
    const saved: AppSettingsV2[] = [];
    const calls: string[] = [];
    const provider: ProviderConfigV2 = { id: 'agent-claude', name: 'Claude Code', kind: 'acp', enabled: true, launch: 'host', command: '/usr/bin/claude', args: ['--acp'] };
    const summary: LinkSummary = {
      settings: { providers: [provider] },
      linked: [{ id: 'claude', name: 'Claude Code', providerId: 'agent-claude', created: true }],
      skipped: [{ id: 'gemini', reason: 'Gemini CLI is not installed.' }],
    };
    const providers: ProvidersDeps = {
      scanProviders: async () => scanOf([]),
      linkProviders: async () => summary,
      updateAgentCli: async () => { throw new Error('not used'); },
      loginTarget: async () => { throw new Error('not used'); },
      agentSpec: () => undefined,
    };
    const session: OwnerSession = {
      async call(command) {
        calls.push(String(command.type));
        if (command.type === 'state.sync') return { ok: true, snapshot: { settings: { providers: [] } } };
        if (command.type === 'settings.update') { saved.push(command.settings as AppSettingsV2); return { ok: true }; }
        if (command.type === 'models.refresh') return { ok: true };
        return { ok: false, error: { code: 'NOPE', message: 'no' } };
      },
      close() {},
    };
    const happy = capture({ env: { YOUR_BOT_DATA: '/data' }, providers, connectOwner: async () => session });
    expect(await runCli(['providers', 'link', 'claude'], happy.io)).toBe(0);
    expect(calls).toEqual(['state.sync', 'settings.update', 'models.refresh']);
    expect(saved[0]?.providers[0]?.id).toBe('agent-claude');
    expect(happy.out).toEqual(['skipped gemini: Gemini CLI is not installed.', 'created Claude Code (agent-claude)']);

    const down = capture({ env: { YOUR_BOT_DATA: '/data' }, providers, connectOwner: async () => undefined });
    expect(await runCli(['providers', 'link', '--all'], down.io)).toBe(1);
    expect(down.err).toEqual([NOT_RUNNING]);

    const skipped = capture({
      env: { YOUR_BOT_DATA: '/data' },
      providers: { ...providers, linkProviders: async settings => ({ settings, linked: [], skipped: [{ id: 'gemini', reason: 'Gemini CLI is not installed.' }] }) },
      connectOwner: async () => session,
    });
    calls.length = 0;
    expect(await runCli(['providers', 'link', 'gemini'], skipped.io)).toBe(1);
    expect(calls).toEqual(['state.sync']);
    expect(skipped.out).toEqual(['skipped gemini: Gemini CLI is not installed.']);
  });

  it('explains SETTINGS_BUSY without claiming a link', async () => {
    const providers: ProvidersDeps = {
      scanProviders: async () => scanOf([]),
      linkProviders: async settings => ({ settings, linked: [{ id: 'claude', name: 'Claude Code', providerId: 'agent-claude', created: false }], skipped: [] }),
      updateAgentCli: async () => { throw new Error('not used'); },
      loginTarget: async () => { throw new Error('not used'); },
      agentSpec: () => undefined,
    };
    const session: OwnerSession = {
      async call(command) {
        if (command.type === 'state.sync') return { ok: true, snapshot: { settings: { providers: [] } } };
        return { ok: false, error: { code: 'SETTINGS_BUSY', message: 'Provider settings require idle tasks' } };
      },
      close() {},
    };
    const busy = capture({ env: { YOUR_BOT_DATA: '/data' }, providers, connectOwner: async () => session });
    expect(await runCli(['providers', 'link', 'claude'], busy.io)).toBe(1);
    expect(busy.err).toEqual(['Settings cannot change while a task is running. Wait for it to finish, then try again.']);
    expect(busy.out).toEqual([]);
  });

  it('updates every outdated agent, or reports that everything is current', async () => {
    const updated: string[] = [];
    const providers: ProvidersDeps = {
      scanProviders: async () => scanOf([
        agent({ id: 'grok', name: 'Grok Build', installed: true, updateAvailable: false }),
        agent({ id: 'claude', name: 'Claude Code', installed: true, updateAvailable: true }),
      ]),
      linkProviders: async settings => ({ settings, linked: [], skipped: [] }),
      updateAgentCli: async (id, options) => {
        updated.push(id);
        options?.onOutput?.('fetching\n');
        const result: UpdateResult = { ok: true, message: 'Claude Code is now 2.0.0.', output: 'fetching\n' };
        return result;
      },
      loginTarget: async () => { throw new Error('not used'); },
      agentSpec: id => id === 'claude' ? { name: 'Claude Code', acp: { via: 'self', args: [] } } as unknown as AgentCliSpec : undefined,
    };
    const none = capture({
      providers: { ...providers, scanProviders: async () => scanOf([agent({ id: 'grok', name: 'Grok Build', installed: true, updateAvailable: false })]) },
    });
    expect(await runCli(['providers', 'update', '--all'], none.io)).toBe(0);
    expect(none.out).toEqual(['Everything is up to date.']);

    const one = capture({ providers });
    expect(await runCli(['providers', 'update', '--all'], one.io)).toBe(0);
    expect(updated).toEqual(['claude']);
    expect(one.raw).toEqual(['fetching\n']);
    expect(one.out).toEqual(['Updating Claude Code...', 'Claude Code is now 2.0.0.']);
  });

  it('returns the sign-in command status', async () => {
    let plan: { command: string; args: readonly string[] } | undefined;
    const providers: ProvidersDeps = {
      scanProviders: async () => scanOf([]),
      linkProviders: async settings => ({ settings, linked: [], skipped: [] }),
      updateAgentCli: async () => { throw new Error('not used'); },
      loginTarget: async id => ({ plan: { command: `${id}.cmd`, args: ['auth', 'login'], display: `${id}.cmd auth login` }, name: 'Claude Code' }),
      agentSpec: () => undefined,
    };
    const logged = capture({ providers, runLogin: async value => { plan = value; return 7; } });
    expect(await runCli(['providers', 'login', 'claude'], logged.io)).toBe(7);
    expect(plan).toEqual({ command: 'claude.cmd', args: ['auth', 'login'], display: 'claude.cmd auth login' });
    expect(loginSpawnArgs({ command: 'C:\\Program Files\\claude.cmd', args: ['auth', 'login'] }, 'win32').args).toEqual(['/d', '/s', '/c', '""C:\\Program Files\\claude.cmd" auth login"']);
  });
});
