import { describe, expect, it } from 'vitest';
import type { PermissionRequestV2 } from '@your-bot/contracts';
import { commonParent, defaultStandingScope, isWithinFolder, parentFolder, standingDecision, standingKind, standingScopeError } from '../src/renderer/standing';
import { coder } from './support';

const base = { id: 'r1', principalId: 'p', sessionId: 's', taskId: 't', botId: 'bot-1', reason: 'because' };
const file = (...paths: string[]): PermissionRequestV2 => ({ ...base, capability: 'file.write', paths: paths.map(path => ({ path, access: 'write' as const })) });
const spawn = (args: string[], env?: { name: string; value: string }[]): PermissionRequestV2 => ({ ...base, capability: 'process.spawn', command: { command: 'npm', args, cwd: '/w', ...(env ? { env } : {}) } });

describe('standing grant scopes', () => {
  it('derives parent folders on POSIX and Windows spellings', () => {
    expect(parentFolder('/w/src/a.ts')).toBe('/w/src'); expect(parentFolder('/a.txt')).toBe('/');
    expect(parentFolder('C:\\w\\src\\a.ts')).toBe('C:\\w\\src'); expect(parentFolder('C:/a.txt')).toBe('C:\\');
    expect(commonParent(['/w/src/a/x.ts', '/w/src/b/y.ts'])).toBe('/w/src'); expect(commonParent(['/w/a.ts', '/v/b.ts'])).toBe('/');
    expect(commonParent(['C:\\w\\a.ts', 'D:\\w\\b.ts'])).toBeUndefined();
  });
  it('matches folders by whole segments, case-insensitively only for Windows paths', () => {
    expect(isWithinFolder('/w/src/a.ts', '/w/src')).toBe(true); expect(isWithinFolder('/w/src', '/w/src')).toBe(true);
    expect(isWithinFolder('/w/srcx/a.ts', '/w/src')).toBe(false); expect(isWithinFolder('/w/SRC/a.ts', '/w/src')).toBe(false);
    expect(isWithinFolder('C:\\W\\Src\\a.ts', 'c:\\w\\src')).toBe(true); expect(isWithinFolder('C:\\w\\a.ts', '/w')).toBe(false);
    expect(isWithinFolder('/w/a', '/')).toBe(true); expect(isWithinFolder('relative/a', '/w')).toBe(false);
  });
  it('defaults a file scope to the parent folder and keeps it a parent of every requested path', () => {
    const request = file('/w/src/a.ts', '/w/src/b.ts');
    expect(defaultStandingScope(request)).toEqual({ folder: '/w/src' });
    expect(standingScopeError(request, { folder: '/w/src' }, coder)).toBeUndefined();
    expect(standingScopeError(request, { folder: '/w' }, coder)).toBeUndefined();
    expect(standingScopeError(request, { folder: '/w/src/sub' }, coder)).toMatch(/parent/);
    expect(standingScopeError(request, { folder: '/w/srcx' }, coder)).toMatch(/parent/);
    expect(standingScopeError(request, { folder: '/' }, coder)).toMatch(/workspace/);
    expect(standingScopeError(request, { folder: 'src' }, coder)).toMatch(/absolute/);
    expect(standingScopeError(request, { folder: '' }, coder)).toMatch(/absolute/);
  });
  it('requires an argv prefix of the requested command, defaulting to argv[0]', () => {
    const request = spawn(['test', '--silent']);
    expect(defaultStandingScope(request)).toEqual({ commandPrefix: ['npm'] });
    expect(standingScopeError(request, { commandPrefix: ['npm', 'test'] })).toBeUndefined();
    expect(standingScopeError(request, { commandPrefix: ['npm', 'run'] })).toMatch(/beginning/);
    expect(standingScopeError(request, { commandPrefix: [] })).toMatch(/at least one/);
    expect(standingScopeError(request, { commandPrefix: ['npm', ''] })).toMatch(/empty/);
    expect(standingScopeError(request, { commandPrefix: ['npm', 'test', '--silent', 'x'] })).toMatch(/beginning/);
  });
  it('covers MCP and agent tools, and the decision carries the scope and expiry', () => {
    const mcp: PermissionRequestV2 = { ...base, capability: 'mcp.call', mcp: { serverId: 'browser', tool: 'navigate' } };
    expect(defaultStandingScope(mcp)).toEqual({ mcp: { serverId: 'browser', tool: 'navigate' } });
    expect(standingScopeError(mcp, { mcp: { serverId: 'browser' } })).toBeUndefined();
    expect(standingScopeError(mcp, { mcp: { serverId: 'other' } })).toBeDefined();
    expect(standingScopeError(mcp, { mcp: { serverId: 'browser', tool: 'click' } })).toBeDefined();
    const tool: PermissionRequestV2 = { ...base, capability: 'tool.execute', agentTool: { toolCallId: 'c', title: 'Edit', kind: 'edit' } };
    expect(defaultStandingScope(tool)).toEqual({ agentToolKind: 'edit' });
    expect(standingScopeError(tool, { agentToolKind: 'execute' })).toBeDefined();
    expect(standingDecision(tool, { agentToolKind: 'edit' })).toEqual({ requestId: 'r1', outcome: 'allow', scope: 'standing', standing: { agentToolKind: 'edit' } });
    expect(standingDecision(tool, { agentToolKind: 'edit' }, '2030-01-01T00:00:00.000Z')).toMatchObject({ standingExpiresAt: '2030-01-01T00:00:00.000Z' });
  });
  it('never offers standing for custom Python, installs, network, settings, env commands or bot-less requests', () => {
    const forbidden: PermissionRequestV2[] = [
      { ...base, capability: 'tool.execute', reason: 'Execute custom Python sha256:abc123' },
      { ...base, capability: 'tool.execute', reason: 'Execute custom Python sha256:abc', agentTool: { toolCallId: 'c', title: 't', kind: 'execute' } },
      { ...base, capability: 'tool.execute', reason: 'run skill' },
      { ...base, capability: 'library.install', packages: ['numpy'] }, { ...base, capability: 'network' }, { ...base, capability: 'settings' }, { ...base, capability: 'conversation' },
      spawn(['x'], [{ name: 'FOO', value: 'bar' }]),
      { ...file('/w/a'), botId: undefined },
      { ...base, capability: 'file.read', paths: [{ path: '/w/a', access: 'write' }] },
    ];
    for (const request of forbidden) { expect(standingKind(request)).toBeUndefined(); expect(defaultStandingScope(request)).toBeUndefined(); expect(standingScopeError(request, { folder: '/w' })).toBeDefined(); }
  });
});
