import { describe, expect, it } from 'vitest';
import { parseToolInvocation } from '../src/index.js';

describe('untrusted tool arguments', () => {
  it.each([
    ['execute_tool', '{'],
    ['shell', '{}'],
    ['execute_tool', { kind: 'python', code: 'x' }],
    ['execute_tool', { kind: 'python', code: 'x', input: null, authorization: { allow: true } }],
    ['execute_tool', { kind: 'skill', input: null }],
    ['execute_tool', { kind: 'library.install', input: null, packages: [] }],
    ['execute_tool', { kind: 'python', code: 'x', input: null, timeoutMs: -1 }],
    ['execute_tool', { kind: 'python', code: 'x', input: null, paths: [{ path: '/file', access: 'execute' }] }],
    ['execute_tool', { kind: 'python', code: 'x', input: { invalid: undefined } }],
    ['execute_tool', { kind: 'python', code: 'x', input: Number.NaN }],
  ])('rejects invalid or authorization-bearing arguments %#', (name, input) => {
    expect(() => parseToolInvocation(name, input, 'call-id')).toThrow();
  });

  it('preserves explicit paths and packages for core authorization without granting access', () => {
    expect(parseToolInvocation('execute_tool', JSON.stringify({
      kind: 'library.install', input: null, packages: ['numpy'], paths: [{ path: '/approved/file', access: 'read' }], timeoutMs: 2000,
    }), 'call-id')).toEqual({ id: 'call-id', kind: 'library.install', input: null, packages: ['numpy'], paths: [{ path: '/approved/file', access: 'read' }], timeoutMs: 2000 });
  });
});
