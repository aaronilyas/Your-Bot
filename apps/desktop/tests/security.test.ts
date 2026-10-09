import { describe, expect, it } from 'vitest';
import { parseCommand, PRODUCTION_CSP, redactResult, rendererCSP, rendererEvent, trustedRendererURL, validateDevelopmentURL } from '../src/main/security';
import { emptySnapshot } from '../src/renderer/store';
describe('IPC security boundary', () => {
  it('accepts contract commands and rejects forged principals and approval expansion', () => {
    expect(parseCommand({ version: 1, id: 'c1', type: 'message.send', sessionId: 's1', content: 'hello' }).type).toBe('message.send');
    expect(() => parseCommand({ version: 1, id: 'c1', type: 'state.sync', principalId: 'admin' })).toThrow();
    expect(() => parseCommand({ version: 2, id: 'c1', type: 'state.sync' })).toThrow();
    expect(() => parseCommand({ version: 1, id: 'c1', type: 'permission.decide', decision: { requestId: 'r1', outcome: 'allow', scope: 'task', paths: ['/'] } })).toThrow();
    expect(() => parseCommand({ version: 1, id: 'c1', type: 'tool.run', sessionId: 's1', invocation: { id: 't', kind: 'python', input: null, timeoutMs: -1 } })).toThrow();
  });
  it('bounds command size and nesting and rejects prototype keys', () => {
    expect(() => parseCommand({ version: 1, id: 'c', type: 'message.send', sessionId: 's', content: 'x'.repeat(1048577) })).toThrow();
    expect(() => parseCommand(JSON.parse('{"version":1,"id":"c","type":"state.sync","__proto__":{}}'))).toThrow();
    let deep: unknown = null; for (let i = 0; i < 30; i++) deep = { nested: deep };
    expect(() => parseCommand({ version: 1, id: 'c', type: 'tool.run', sessionId: 's', invocation: { id: 't', kind: 'python', input: deep } })).toThrow();
  });
  it('requires the exact renderer URL, allowing only fragment changes', () => {
    const expected = 'file:///app/dist/renderer/index.html';
    expect(trustedRendererURL(`${expected}#section`, expected)).toBe(true);
    for (const actual of ['file:///tmp/index.html', `${expected}?spoof=1`, 'https://evil.test', 'invalid']) expect(trustedRendererURL(actual, expected)).toBe(false);
    expect(trustedRendererURL('http://127.0.0.1:5173/', 'http://127.0.0.1:5173/')).toBe(true);
    expect(trustedRendererURL('http://127.0.0.1:5174/', 'http://127.0.0.1:5173/')).toBe(false);
  });
  it('permits loopback-only development and denies production network access', () => {
    expect(validateDevelopmentURL('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173/');
    for (const url of ['https://example.com', 'http://127.0.0.1.evil.test', 'http://user:pw@localhost:5173', 'http://localhost:5173/path', 'http://localhost:5173/?demo=1']) expect(() => validateDevelopmentURL(url)).toThrow();
    expect(PRODUCTION_CSP).toContain("connect-src 'none'");
    expect(PRODUCTION_CSP).not.toContain('unsafe-inline');
    expect(rendererCSP('http://127.0.0.1:5173')).toContain('connect-src http://127.0.0.1:5173 ws://127.0.0.1:5173');
  });
  it('redacts credentials without mutating backend state and drops other owners', () => {
    const snapshot = emptySnapshot(); snapshot.settings.providers.push({ id: 'p', name: 'P', kind: 'lmstudio', apiKey: 'secret', enabled: true });
    const result = redactResult({ ok: true, commandId: 'c', snapshot });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(snapshot.settings.providers[0].apiKey).toBe('secret');
    const event = { type: 'state.snapshot' as const, snapshot, sequence: 1, timestamp: '', version: 1 as const, principalId: 'local-owner' };
    expect(JSON.stringify(rendererEvent(event, { id: 'local-owner', kind: 'local', capabilities: [] }))).not.toContain('secret');
    expect(rendererEvent(event, { id: 'other', kind: 'remote', capabilities: [] })).toBeUndefined();
  });
});
