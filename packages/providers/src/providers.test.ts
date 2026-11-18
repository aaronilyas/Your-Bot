import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ProviderConfigV2 } from '@your-bot/contracts';
import {
  AGENT_CLIS, agentSpec, compareVersions, detectInstallMethod, linkProviders, linkedProvider, mergePath, npmPackageFor,
  parseVersion, providerFor, scanAgentClis, scanLocalServers, updatePlan, which, withLinkedProvider,
} from './index.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;
const root = mkdtempSync(path.join(tmpdir(), 'your-bot-providers-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Executable shell script standing in for an agent CLI. */
function fakeCli(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

const registry = (versions: Record<string, string>): typeof fetch => (async (input: string | URL | Request) => {
  const url = String(input);
  const pkg = decodeURIComponent(url.replace('https://registry.npmjs.org/', '').replace(/\/latest$/, ''));
  if (!versions[pkg]) return new Response('not found', { status: 404 });
  return new Response(JSON.stringify({ version: versions[pkg] }), { status: 200 });
}) as typeof fetch;

describe('environment', () => {
  it('merges PATH parts in order, dropping duplicates and relative entries', () => {
    expect(mergePath('linux', '/a:/b', '/b:relative:/c', undefined)).toBe('/a:/b:/c');
    expect(mergePath('win32', 'C:\\A;c:\\a', 'C:\\B')).toBe('C:\\A;C:\\B');
  });
  posixOnly('finds only executable files', () => {
    const dir = path.join(root, 'which');
    fakeCli(dir, 'tool', 'true');
    writeFileSync(path.join(dir, 'plain'), 'x');
    expect(which('tool', `/nonexistent:${dir}`)).toBe(path.join(dir, 'tool'));
    expect(which('plain', dir)).toBeUndefined();
  });
});

describe('versions', () => {
  it('parses CLI version output', () => {
    expect(parseVersion('2.1.327 (Claude Code)')).toBe('2.1.327');
    expect(parseVersion('codex-cli 0.170.0')).toBe('0.170.0');
    expect(parseVersion('grok 1.0.89 (28be5bb1bf65) [alpha]')).toBe('1.0.89');
    expect(parseVersion('opencode v2.3.2')).toBe('2.3.2');
    expect(parseVersion('2026.11.17-f532c45')).toBe('2026.11.17-f532c45');
    expect(parseVersion('no version here')).toBeUndefined();
  });
  it('compares dotted versions numerically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0-beta')).toBe(0);
    expect(compareVersions('0.9', '0.9.1')).toBe(-1);
  });
  it('uses the renamed npm package for newer majors', () => {
    const opencode = agentSpec('opencode')!;
    expect(npmPackageFor(opencode, '1.19.6')).toBe('opencode-ai');
    expect(npmPackageFor(opencode, '2.3.2')).toBe('@opencode/cli');
    expect(npmPackageFor(opencode)).toBe('opencode-ai');
  });
});

describe('install method and update command', () => {
  const claude = agentSpec('claude')!;
  it('recognises mise installs, shims and command wrappers', () => {
    expect(detectInstallMethod(claude, '/home/u/.local/share/mise/installs/claude/latest/claude')).toEqual({ kind: 'mise', tool: 'claude', dir: 'claude' });
    expect(detectInstallMethod(claude, '/home/u/.local/share/mise/shims/claude')).toEqual({ kind: 'mise', tool: 'claude' });
    expect(detectInstallMethod(agentSpec('cursor')!, '/home/u/.local/share/mise/installs/cursor-agent/latest/bin/cursor-agent')).toEqual({ kind: 'mise', tool: 'cursor-agent', dir: 'cursor-agent' });
    expect(updatePlan(claude, { kind: 'mise', tool: 'claude' }, '/x/claude')).toMatchObject({ command: 'mise', args: ['upgrade', 'claude'], display: 'mise upgrade claude' });
  });
  it('recognises npm, bun, Homebrew, Nix and native installs', () => {
    expect(detectInstallMethod(claude, '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js')).toEqual({ kind: 'npm', prefix: '/usr/local', package: '@anthropic-ai/claude-code' });
    expect(detectInstallMethod(claude, '/home/u/.bun/bin/claude')).toEqual({ kind: 'bun' });
    expect(detectInstallMethod(claude, '/opt/homebrew/Caskroom/claude-code/2.1.0/claude')).toEqual({ kind: 'brew', name: 'claude-code', cask: true });
    expect(detectInstallMethod(claude, '/nix/store/abc-claude/bin/claude').kind).toBe('manual');
    expect(detectInstallMethod(claude, '/home/u/.claude/local/claude')).toEqual({ kind: 'native' });
    expect(detectInstallMethod(agentSpec('kiro')!, '/opt/kiro/kiro-cli').kind).toBe('manual');
  });
  it('plans package-manager and self updates', () => {
    expect(updatePlan(claude, { kind: 'npm', prefix: '/usr/local', package: '@anthropic-ai/claude-code' }, '/x'))
      .toMatchObject({ display: 'npm install -g --prefix /usr/local @anthropic-ai/claude-code@latest' });
    expect(updatePlan(claude, { kind: 'brew', name: 'claude-code', cask: true }, '/x')).toMatchObject({ display: 'brew upgrade --cask claude-code' });
    expect(updatePlan(claude, { kind: 'native' }, '/home/u/.local/bin/claude')).toMatchObject({ display: '/home/u/.local/bin/claude update' });
    expect(updatePlan(claude, { kind: 'manual', reason: 'Use Nix.' }, '/x')).toEqual({ manual: 'Use Nix.' });
  });
});

describe('auth probes', () => {
  const parse = (id: string, stdout: string, code = 0) => agentSpec(id)!.auth!.parse({ stdout, stderr: '', code });
  it('reads Claude JSON status', () => {
    expect(parse('claude', '{"loggedIn": true, "authMethod": "claude.ai"}')).toBe(true);
    expect(parse('claude', '{"loggedIn": false}', 1)).toBe(false);
  });
  it('reads text status', () => {
    expect(parse('codex', 'Not logged in', 1)).toBe(false);
    expect(parse('codex', 'Logged in using ChatGPT')).toBe(true);
    expect(parse('cursor', 'something unexpected')).toBeUndefined();
    expect(parse('kiro', '{"account":null}', 1)).toBe(false);
    expect(parse('kiro', '{"account":{"email":"x"}}')).toBe(true);
  });
});

describe('linking', () => {
  const grokByHand: ProviderConfigV2 = { id: 'grok-build', name: 'My Grok', kind: 'acp', launch: 'host', command: 'grok', args: ['agent', 'stdio'], enabled: false, modelId: 'grok-4', envPassthrough: ['CUSTOM'] };
  it('finds a provider added by hand and keeps its id, name, enabled flag and model', () => {
    expect(linkedProvider([grokByHand], agentSpec('grok')!)?.id).toBe('grok-build');
    const fresh: ProviderConfigV2 = { id: 'agent-grok', name: 'Grok Build', kind: 'acp', launch: 'host', command: '/bin/grok', args: ['agent', 'stdio'], enabled: true, envPassthrough: ['XAI_API_KEY'] };
    const result = withLinkedProvider({ providers: [grokByHand] }, fresh);
    expect(result).toMatchObject({ providerId: 'grok-build', created: false });
    expect(result.settings.providers).toEqual([{ ...grokByHand, command: '/bin/grok', envPassthrough: ['CUSTOM', 'XAI_API_KEY'] }]);
  });
  it('adds a new provider and never echoes stored API keys', () => {
    const local: ProviderConfigV2 = { id: 'lm', name: 'LM', kind: 'lmstudio', endpoint: 'http://127.0.0.1:1234/v1', enabled: true, apiKey: 'secret' };
    const fresh: ProviderConfigV2 = { id: 'agent-codex', name: 'Codex', kind: 'acp', launch: 'host', command: '/bin/npx', args: [], enabled: true };
    const result = withLinkedProvider({ providers: [local] }, fresh);
    expect(result.created).toBe(true);
    expect(result.settings.providers.map(p => p.id)).toEqual(['lm', 'agent-codex']);
    expect(JSON.stringify(result.settings)).not.toContain('secret');
  });
  posixOnly('pins npx adapters to the newest release', async () => {
    const bin = path.join(root, 'npx-bin');
    const npx = fakeCli(bin, 'npx', 'true');
    const provider = await providerFor({ id: 'claude', name: 'Claude Code', installed: true, path: '/x/claude', auth: 'unknown', providerId: 'agent-claude', installHint: '', docs: '' },
      { searchPath: bin, fetch: registry({ '@agentclientprotocol/claude-agent-acp': '0.108.1' }) });
    expect(provider).toMatchObject({ id: 'agent-claude', kind: 'acp', launch: 'host', command: npx, args: ['-y', '@agentclientprotocol/claude-agent-acp@0.108.1'] });
    expect(provider.envPassthrough).toContain('ANTHROPIC_API_KEY');
  });
  it('refuses an agent that is not installed', async () => {
    await expect(providerFor({ id: 'gemini', name: 'Gemini CLI', installed: false, auth: 'unknown', providerId: 'agent-gemini', installHint: '', docs: '' })).rejects.toThrow(/not installed/);
  });
});

describe('scanning a machine', () => {
  const bin = path.join(root, 'scan-bin');
  const options = () => ({ searchPath: bin, fetch: registry({ '@xai-official/grok': '1.1.0', '@openai/codex': '0.170.0' }), probeTimeoutMs: 5_000 });
  posixOnly('reports installed CLIs, versions, auth and available updates without touching anything else', async () => {
    fakeCli(bin, 'grok', '[ "$1" = "--version" ] && echo "grok 1.0.89 (abc) [alpha]"');
    fakeCli(bin, 'codex', 'case "$1" in --version) echo "codex-cli 0.170.0";; login) echo "Not logged in"; exit 1;; esac');
    const statuses = await scanAgentClis(options());
    expect(statuses.map(s => s.id)).toEqual(AGENT_CLIS.map(spec => spec.id));
    const grok = statuses.find(s => s.id === 'grok')!;
    expect(grok).toMatchObject({ installed: true, version: '1.0.89', latestVersion: '1.1.0', updateAvailable: true, path: path.join(bin, 'grok'), login: `${path.join(bin, 'grok')} login` });
    expect(grok.update).toEqual({ command: `${path.join(bin, 'grok')} update` });
    const codex = statuses.find(s => s.id === 'codex')!;
    expect(codex).toMatchObject({ installed: true, version: '0.170.0', updateAvailable: false, auth: 'signed-out' });
    expect(statuses.find(s => s.id === 'gemini')).toMatchObject({ installed: false, installHint: 'npm install -g @google/gemini-cli' });
  });
  posixOnly('links every installed agent with "all" and explains named agents that are missing', async () => {
    const all = await linkProviders({ providers: [] }, 'all', { ...options(), fetch: registry({}) });
    expect(all.linked.map(entry => entry.id).sort()).toEqual(['grok']);
    expect(all.skipped.map(entry => entry.id)).toEqual(['codex']); // npx (for its ACP adapter) is not on this PATH
    expect(all.settings.providers[0]).toMatchObject({ id: 'agent-grok', command: path.join(bin, 'grok'), args: ['agent', 'stdio'], launch: 'host' });
    const named = await linkProviders({ providers: [] }, ['gemini', 'nope'], options());
    expect(named.linked).toEqual([]);
    expect(named.skipped.map(entry => entry.id).sort()).toEqual(['gemini', 'nope']);
  });
});

describe('local model servers', () => {
  it('reports running servers and their models', async () => {
    const fetchImpl = (async (input: string | URL | Request) => String(input).startsWith('http://127.0.0.1:11434/')
      ? new Response(JSON.stringify({ data: [{ id: 'llama3' }, { id: 7 }] }), { status: 200 })
      : Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;
    const servers = await scanLocalServers([], fetchImpl);
    expect(servers.find(s => s.id === 'ollama')).toMatchObject({ running: true, models: ['llama3'], linked: false, providerId: 'local-ollama' });
    expect(servers.find(s => s.id === 'lmstudio')).toMatchObject({ running: false });
    const linked = await scanLocalServers([{ id: 'mine', name: 'O', kind: 'openai-compatible', endpoint: 'http://127.0.0.1:11434/v1/', enabled: true }], fetchImpl);
    expect(linked.find(s => s.id === 'ollama')).toMatchObject({ linked: true, providerId: 'mine' });
  });
});
