import { describe, expect, it } from 'vitest';
import type { StandingGrant } from '@your-bot/contracts';
import { matches, shellTokens } from './grants.js';

const ws = '/work/space';
const grant: StandingGrant = { id: 'g', botId: 'b', capability: 'process.spawn', scope: { commandPrefix: ['git', 'status'] }, createdAt: '2026-01-01T00:00:00Z', createdBy: 'local' };
const request = (command: string, args: string[] = []) => ({ capability: 'process.spawn' as const, reason: 'r', botId: 'b', command: { command, args, cwd: ws } });

describe('standing grants for shell command lines', () => {
  it('tokenizes plain lines and refuses any shell syntax', () => {
    expect(shellTokens('git  status --short')).toEqual(['git', 'status', '--short']);
    for (const line of ['git status; rm -rf ~', 'git status && x', 'git status | sh', 'git status $(id)', 'git status `id`', 'git status > f', "git status 'a'", 'git status\nrm x', 'git status *'])
      expect(shellTokens(line)).toBeUndefined();
  });
  it('matches a syntax-free line by prefix and never a line with shell syntax', () => {
    expect(matches(grant, request('git status --short'), 'b', ws, Date.now(), 'linux')).toBe(true);
    expect(matches(grant, request('git status; rm -rf ~'), 'b', ws, Date.now(), 'linux')).toBe(false);
    expect(matches(grant, request('git statusx'), 'b', ws, Date.now(), 'linux')).toBe(false);
    expect(matches(grant, request('git', ['status', ';rm']), 'b', ws, Date.now(), 'linux')).toBe(true); // argv form: no shell
  });
});
