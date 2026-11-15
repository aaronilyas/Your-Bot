import { describe, expect, it } from 'vitest';
import { parseAnyCommand, parseCommand, parseCommandV2, redactResult, rendererEvent } from '../src/main/security';
import { emptySnapshot } from '../src/renderer/store';

const v2 = (extra: Record<string, unknown>) => ({ version: 2, id: 'c1', ...extra });
const bot = { name: 'Coder', instructions: '', agentId: 'acp', profile: 'strict', mcpServers: [], skills: [], memoryEnabled: true };

describe('v2 IPC command validation', () => {
  it('accepts every v2 command shape and keeps v1 frames valid', () => {
    const valid: Record<string, unknown>[] = [
      { type: 'state.sync', afterSequence: 4 }, { type: 'bot.create', bot }, { type: 'bot.update', botId: 'b1', patch: { modelId: null, workspace: null, compaction: null, name: 'x' } },
      { type: 'bot.delete', botId: 'b1' }, { type: 'bot.session.create', botId: 'b1', title: 't' },
      { type: 'permission.decide', decision: { requestId: 'r', outcome: 'allow', scope: 'standing', standing: { folder: '/w/src' }, standingExpiresAt: '2030-01-01T00:00:00Z' } },
      { type: 'permission.decide', decision: { requestId: 'r', outcome: 'deny', scope: 'once' } },
      { type: 'grant.create', grant: { botId: 'b1', capability: 'process.spawn', scope: { commandPrefix: ['npm', 'test'] } } }, { type: 'grant.revoke', grantId: 'g1' },
      { type: 'audit.list', botId: 'b1', limit: 50, beforeId: 'a1' }, { type: 'memory.list', botId: 'b1' }, { type: 'memory.add', botId: 'b1', content: 'x' }, { type: 'memory.delete', botId: 'b1', memoryId: 'm' },
      { type: 'session.compact', sessionId: 's' },
      { type: 'routine.create', routine: { botId: 'b1', name: 'n', prompt: 'p', schedule: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'UTC' }, missedRunPolicy: 'runAll', maxCatchUp: 3, enabled: true, sessionMode: 'new' } },
      { type: 'routine.update', routineId: 'r1', patch: { enabled: false } }, { type: 'routine.delete', routineId: 'r1' }, { type: 'routine.runNow', routineId: 'r1' }, { type: 'routine.runs', routineId: 'r1', limit: 20 },
      { type: 'notification.ack', notificationId: 'n1' }, { type: 'device.pair.start', name: 'Phone' }, { type: 'device.list' }, { type: 'device.revoke', deviceId: 'd1' }, { type: 'skills.refresh' },
      { type: 'session.create', agentId: 'a' }, { type: 'message.send', sessionId: 's', content: 'hi' }, { type: 'models.refresh' },
      { type: 'settings.update', settings: { providers: [{ id: 'p', name: 'Grok', kind: 'acp', enabled: true, command: 'grok', args: ['agent', 'stdio'], launch: 'host', envPassthrough: ['GROK_API_KEY'] }] } },
    ];
    for (const payload of valid) expect(parseCommandV2(v2(payload)).type).toBe(payload.type);
    expect(parseAnyCommand({ version: 1, id: 'c', type: 'state.sync' }).version).toBe(1);
    expect(parseAnyCommand(v2({ type: 'state.sync' })).version).toBe(2);
    // The v1-only parser is unchanged and still refuses version 2.
    expect(() => parseCommand(v2({ type: 'state.sync' }))).toThrow();
  });
  it('rejects forged principals and identity-shaped extras', () => {
    for (const forged of [{ principalId: 'admin' }, { principal: { id: 'local-owner', kind: 'local', capabilities: [] } }, { ownerId: 'someone' }, { deviceId: 'd' }]) {
      expect(() => parseCommandV2(v2({ type: 'state.sync', ...forged }))).toThrow();
    }
    expect(() => parseCommandV2(v2({ type: 'bot.create', bot: { ...bot, ownerId: 'x' } }))).toThrow();
  });
  it('rejects malformed v2 shapes', () => {
    const bad: Record<string, unknown>[] = [
      { type: 'nope' }, { type: 'bot.create' }, { type: 'bot.create', bot: { ...bot, profile: 'root' } }, { type: 'bot.create', bot: { ...bot, workspace: 'relative/dir' } },
      { type: 'bot.create', bot: { ...bot, modelId: null } }, { type: 'bot.update', botId: 'b1', patch: { profile: null } }, { type: 'bot.update', botId: 'b1', patch: { name: null } },
      { type: 'bot.create', bot: { ...bot, compaction: { maxMessages: 10, keepRecent: 10 } } },
      { type: 'bot.create', bot: { ...bot, mcpServers: [{ id: 'a_b', name: 'x', enabled: true, transport: 'stdio', command: 'c' }] } },
      { type: 'bot.create', bot: { ...bot, mcpServers: [{ id: 'a', name: 'x', enabled: true, transport: 'http', url: 'https://u:p@h.test' }] } },
      { type: 'bot.create', bot: { ...bot, mcpServers: [{ id: 'a', name: 'x', enabled: true, transport: 'stdio', command: 'c', env: { 'bad name': '1' } }] } },
      { type: 'bot.create', bot: { ...bot, skills: ['Bad Skill'] } },
      { type: 'permission.decide', decision: { requestId: 'r', outcome: 'allow', scope: 'standing' } },
      { type: 'permission.decide', decision: { requestId: 'r', outcome: 'deny', scope: 'standing', standing: { folder: '/x' } } },
      { type: 'permission.decide', decision: { requestId: 'r', outcome: 'allow', scope: 'once', standing: { folder: '/x' } } },
      { type: 'permission.decide', decision: { requestId: 'r', outcome: 'allow', scope: 'task', paths: ['/'] } },
      { type: 'permission.decide', decision: { requestId: 'r', outcome: 'allow', scope: 'standing', standing: { folder: '/x', extra: 1 } } },
      { type: 'grant.create', grant: { botId: 'b1', capability: 'sudo', scope: {} } },
      { type: 'audit.list', limit: 0 }, { type: 'audit.list', limit: 501 }, { type: 'memory.add', botId: 'b1', content: '' },
      { type: 'routine.create', routine: { botId: 'b1', name: 'n', prompt: 'p', schedule: { kind: 'cron', expression: '* * *' }, missedRunPolicy: 'skip', enabled: true, sessionMode: 'new' } },
      { type: 'routine.create', routine: { botId: 'b1', name: 'n', prompt: 'p', schedule: { kind: 'interval', everyMinutes: 0 }, missedRunPolicy: 'skip', enabled: true, sessionMode: 'new' } },
      { type: 'routine.update', routineId: 'r', patch: { sessionId: 's' } },
      { type: 'device.pair.start', capabilities: ['root'] }, { type: 'device.revoke' }, { type: 'bot.delete', botId: '../etc' },
      { type: 'settings.update', settings: { providers: [{ id: 'p', name: 'x', kind: 'acp', enabled: true, launch: 'sandbox' }] } },
    ];
    for (const payload of bad) expect(() => parseCommandV2(v2(payload)), JSON.stringify(payload)).toThrow();
    expect(() => parseAnyCommand({ version: 3, id: 'c', type: 'state.sync' })).toThrow();
    expect(() => parseAnyCommand(null)).toThrow();
    expect(() => parseAnyCommand({ id: 'c', type: 'state.sync' })).toThrow();
  });
  it('bounds size, depth and prototype keys for v2 frames', () => {
    expect(() => parseCommandV2(v2({ type: 'memory.add', botId: 'b', content: 'x'.repeat(1048577) }))).toThrow();
    expect(() => parseCommandV2(v2({ type: 'bot.create', bot: { ...bot, instructions: 'x'.repeat(65537) } }))).toThrow();
    expect(() => parseCommandV2(JSON.parse('{"version":2,"id":"c","type":"state.sync","__proto__":{}}'))).toThrow();
    let deep: unknown = null; for (let i = 0; i < 30; i++) deep = { nested: deep };
    expect(() => parseCommandV2(v2({ type: 'tool.run', sessionId: 's', invocation: { id: 't', kind: 'python', input: deep } }))).toThrow();
    expect(() => parseCommandV2(v2({ type: 'state.sync', id: 'x'.repeat(257) }))).toThrow();
  });
});

describe('v2 redaction before the renderer', () => {
  const secretBot = { id: 'b', name: 'b', instructions: '', agentId: 'a', profile: 'trusted' as const, workspace: '/w', skills: [], memoryEnabled: true, createdAt: '', updatedAt: '',
    mcpServers: [{ id: 's', name: 's', enabled: true, transport: 'stdio' as const, command: 'c', env: { TOKEN: 'leaky-secret' } }, { id: 'h', name: 'h', enabled: true, transport: 'http' as const, url: 'https://x.test', headers: { Authorization: 'Bearer leaky-secret' } }] };
  it('blanks MCP env/header values and provider keys in results and events, keeping keys', () => {
    const snapshot = { ...emptySnapshot(), bots: [secretBot], settings: { providers: [{ id: 'p', name: 'P', kind: 'lmstudio' as const, enabled: true, apiKey: 'leaky-secret' }] } };
    const result = redactResult({ ok: true, commandId: 'c', snapshot, bot: secretBot });
    expect(JSON.stringify(result)).not.toContain('leaky-secret');
    expect(JSON.stringify(result)).toContain('TOKEN');
    expect(JSON.stringify(result)).toContain('Authorization');
    const principal = { id: 'local-owner', kind: 'local' as const, capabilities: [] };
    const common = { version: 2 as const, sequence: 1, timestamp: '', principalId: 'local-owner' };
    expect(JSON.stringify(rendererEvent({ ...common, type: 'bot.updated', bot: secretBot }, principal))).not.toContain('leaky-secret');
    expect(JSON.stringify(rendererEvent({ ...common, type: 'state.snapshot', snapshot }, principal))).not.toContain('leaky-secret');
    expect(rendererEvent({ ...common, type: 'bot.updated', bot: secretBot, principalId: 'other' }, principal)).toBeUndefined();
    expect(secretBot.mcpServers[0].env.TOKEN).toBe('leaky-secret');
  });
});
