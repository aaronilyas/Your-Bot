import { describe, expect, it } from 'vitest';
import type { StandingGrant } from '@your-bot/contracts';
import { matches, shellTokens } from './grants.js';

const ws = '/work/space';
const grant: StandingGrant = { id: 'g', botId: 'b', capability: 'process.spawn', scope: { commandPrefix: ['git', 'status'] }, createdAt: '2026-01-01T00:00:00Z', createdBy: 'local' };
const request = (command: string, args: string[] = []) => ({ capability: 'process.spawn' as const, reason: 'r', botId: 'b', command: { command, args, cwd: ws } });

describe('standing grants for shell command lines', () => {
  it('tokenizes plain lines and refuses any shell syntax', () => {
    expect(shellTokens('git  status --short')).toEqual(['git', 'status', '--short']);
    for (const line of ['git status; rm -rf ~', 'git status && x', 'git status | sh', 'git status $(id)', 'git status `id`', 'git status > f', 'git status\nrm x', 'git status *'])
      expect(shellTokens(line)).toBeUndefined();
  });
  it('matches a syntax-free line by prefix and never a line with shell syntax', () => {
    expect(matches(grant, request('git status --short'), 'b', ws, Date.now(), 'linux')).toBe(true);
    expect(matches(grant, request('git status; rm -rf ~'), 'b', ws, Date.now(), 'linux')).toBe(false);
    expect(matches(grant, request('git statusx'), 'b', ws, Date.now(), 'linux')).toBe(false);
    expect(matches(grant, request('git', ['status', ';rm']), 'b', ws, Date.now(), 'linux')).toBe(true); // argv form: no shell
  });
});

describe('agent-style shell lines and environments', () => {
  it('tokenizes POSIX single quotes literally and keeps whole-token prefix matching', () => {
    expect(shellTokens("/usr/bin/bash -lc 'git status'", 'linux')).toEqual(['/usr/bin/bash', '-lc', 'git status']);
    expect(shellTokens("bash -lc 'unterminated", 'linux')).toBeUndefined();
    const g: StandingGrant = { ...grant, scope: { commandPrefix: ['/usr/bin/bash', '-lc', 'git status'] } };
    expect(matches(g, request("/usr/bin/bash -lc 'git status'"), 'b', ws, Date.now(), 'linux')).toBe(true);
    expect(matches(g, request("/usr/bin/bash -lc 'git status; rm -rf ~'"), 'b', ws, Date.now(), 'linux')).toBe(false);
    expect(matches(g, request("/usr/bin/bash -lc 'git status' ; rm x"), 'b', ws, Date.now(), 'linux')).toBe(false);
  });
  it('never honours single quotes on Windows, where cmd.exe would still run `& calc`', () => {
    expect(shellTokens("pwd 'x & calc'", 'win32')).toBeUndefined();
    expect(shellTokens('pwd', 'win32')).toEqual(['pwd']);
  });
  it('treats only presentation variables as inert', async () => {
    const { inertEnvironment } = await import('./grants.js');
    for (const name of ['TERM', 'FORCE_COLOR', 'CI', 'GROK_SESSION_ID', 'CARGO_TERM_PROGRESS_WIDTH']) expect(inertEnvironment({ name, value: 'x' })).toBe(true);
    expect(inertEnvironment({ name: 'GRADLE_OPTS', value: '-Dorg.gradle.console=rich' })).toBe(true);
    expect(inertEnvironment({ name: 'GRADLE_OPTS', value: '-javaagent:/tmp/evil.jar' })).toBe(false);
    for (const name of ['PATH', 'LD_PRELOAD', 'NODE_OPTIONS', 'BASH_ENV', 'HOME']) expect(inertEnvironment({ name, value: 'x' })).toBe(false);
    expect(inertEnvironment({ name: 'TERM', value: 'x\ny' })).toBe(false);
  });
});
