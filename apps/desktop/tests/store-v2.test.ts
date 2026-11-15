import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopEventV2, EventPayloadV2 } from '@your-bot/contracts';
import { DesktopStore, normalizeSnapshot, emptySnapshot } from '../src/renderer/store';
import { coder, harness, helper, session, T0 } from './support';

afterEach(() => vi.restoreAllMocks());
const connected = async (store: DesktopStore) => { store.start(); await vi.waitFor(() => expect(store.getState().connection).toBe('connected')); };

describe('v2 store', () => {
  it('syncs with a v2 command and applies v2 events once, ignoring duplicates', async () => {
    const h = harness({ bots: [coder], sessions: [session('s1', 'bot-1', 'One')] });
    const store = new DesktopStore(h.transport); await connected(store);
    expect(h.dispatch.mock.calls[0][0]).toMatchObject({ version: 2, type: 'state.sync', afterSequence: 0 });
    const updated = { ...coder, name: 'Coder 2' };
    h.emit({ type: 'bot.updated', bot: updated });
    expect(store.getState().snapshot.bots[0].name).toBe('Coder 2');
    h.emit({ type: 'bot.updated', bot: { ...coder, name: 'Newer' } });
    expect(store.getState().snapshot.bots[0].name).toBe('Newer');
    const applied = store.getState().snapshot.lastSequence;
    // Same sequence again is dropped.
    const dup = { type: 'bot.updated', bot: { ...coder, name: 'Dup' }, version: 2, sequence: applied, timestamp: T0, principalId: 'p' } as DesktopEventV2;
    (store as unknown as { event(e: DesktopEventV2): void }).event(dup);
    expect(store.getState().snapshot.bots[0].name).toBe('Newer');
  });
  it('applies grant, audit, memory, routine, run, notification, device and skill events', async () => {
    const h = harness({ bots: [coder, helper] });
    const store = new DesktopStore(h.transport); await connected(store);
    const grant = { id: 'g', botId: 'bot-1', capability: 'file.read' as const, scope: { folder: '/w' }, createdAt: T0, createdBy: 'me' };
    h.emit({ type: 'grant.updated', grant });
    expect(store.getState().snapshot.grants).toHaveLength(1);
    h.emit({ type: 'grant.updated', grant: { ...grant, revokedAt: T0, revokedBy: 'me' } });
    expect(store.getState().snapshot.grants).toHaveLength(0);
    const entry = { id: 'a1', at: T0, botId: 'bot-1', taskId: 't', sessionId: 's', requestId: 'r', capability: 'file.read' as const, subject: '/w/x', outcome: 'allow' as const, via: 'standing' as const };
    h.emit({ type: 'grant.audited', entry }); h.emit({ type: 'grant.audited', entry });
    expect(store.getState().audit).toEqual([entry]);
    h.emit({ type: 'memory.updated', botId: 'bot-1', memory: [{ id: 'm', botId: 'bot-1', content: 'x', source: 'owner', createdAt: T0 }] });
    expect(store.getState().memory['bot-1']).toHaveLength(1);
    const routine = { id: 'r1', botId: 'bot-1', name: 'R', prompt: 'p', schedule: { kind: 'interval' as const, everyMinutes: 5 }, missedRunPolicy: 'skip' as const, enabled: true, sessionMode: 'new' as const, createdAt: T0, updatedAt: T0 };
    h.emit({ type: 'routine.updated', routine });
    h.emit({ type: 'routine.run', run: { id: 'u1', routineId: 'r1', botId: 'bot-1', trigger: 'manual', scheduledFor: T0, status: 'blocked', blockedOn: ['req'] } });
    expect(store.getState().snapshot.routines).toHaveLength(1);
    expect(store.getState().snapshot.routineRuns[0].status).toBe('blocked');
    h.emit({ type: 'notification', notification: { id: 'n', kind: 'approval.required', title: 't', body: 'b', createdAt: T0 } });
    expect(store.getState().snapshot.notifications).toHaveLength(1);
    h.emit({ type: 'device.updated', device: { id: 'd', name: 'Phone', capabilities: [], pairedAt: T0 } });
    h.emit({ type: 'skills.updated', skills: [{ id: 'summarize', name: 'S', description: 'd', source: 'global', folder: '/s' }] });
    expect(store.getState().snapshot.devices).toHaveLength(1); expect(store.getState().snapshot.skills).toHaveLength(1);
    h.emit({ type: 'routine.deleted', routineId: 'r1' });
    expect(store.getState().snapshot.routines).toHaveLength(0); expect(store.getState().snapshot.routineRuns).toHaveLength(0);
    h.emit({ type: 'bot.deleted', botId: 'bot-1' });
    expect(store.getState().snapshot.bots.map(b => b.id)).toEqual(['bot-2']);
  });
  it('resynchronizes after a gap and again, with afterSequence, on reconnect', async () => {
    const h = harness({ bots: [coder] });
    const store = new DesktopStore(h.transport); await connected(store);
    const gap: EventPayloadV2 = { type: 'skills.updated', skills: [] };
    h.emit(gap); // sequence 1: contiguous
    h.snapshot.lastSequence = 5; h.snapshot.bots = [{ ...coder, name: 'After gap' }];
    (store as unknown as { event(e: DesktopEventV2): void }).event({ ...gap, version: 2, sequence: 5, timestamp: T0, principalId: 'p' } as DesktopEventV2);
    await vi.waitFor(() => expect(store.getState().snapshot.lastSequence).toBe(5));
    expect(store.getState().snapshot.bots[0].name).toBe('After gap');
    store.reconnect();
    await vi.waitFor(() => expect(h.commands('state.sync').at(-1)).toMatchObject({ afterSequence: 5 }));
    await vi.waitFor(() => expect(store.getState().connection).toBe('connected'));
  });
  it('keeps v1-shaped snapshots usable and sends null (clear) untouched', async () => {
    const v1 = { sessions: [], agents: [], settings: { providers: [] }, activeTasks: [], pendingPermissions: [], lastSequence: 3 };
    expect(normalizeSnapshot(v1).bots).toEqual([]); expect(normalizeSnapshot(v1).devices).toEqual([]);
    expect(emptySnapshot().host).toEqual({ id: '', name: '' });
    const h = harness({ bots: [coder] });
    const store = new DesktopStore(h.transport); await connected(store);
    await store.command({ type: 'bot.update', botId: 'bot-1', patch: { modelId: null, workspace: null, compaction: null } });
    expect(h.commands('bot.update')[0].patch).toEqual({ modelId: null, workspace: null, compaction: null });
  });
  it('merges command results: bot, grant revoke, audit paging, memory, notification ack', async () => {
    const entries = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${from + i}`, at: T0, botId: 'bot-1', taskId: 't', sessionId: 's', requestId: 'r', capability: 'file.read' as const, subject: 's', outcome: 'allow' as const, via: 'interactive' as const }));
    const h = harness({ bots: [coder], grants: [{ id: 'g', botId: 'bot-1', capability: 'file.read', scope: { folder: '/w' }, createdAt: T0, createdBy: 'me' }], notifications: [{ id: 'n', kind: 'device.paired', title: 't', body: 'b', createdAt: T0 }] }, command => {
      if (command.type === 'audit.list') return { audit: command.beforeId ? entries(3, 2) : entries(1, 2) };
      if (command.type === 'memory.add') return { memory: [{ id: 'm', botId: command.botId, content: command.content, source: 'owner' as const, createdAt: T0 }] };
    });
    const store = new DesktopStore(h.transport); await connected(store);
    await store.command({ type: 'audit.list', limit: 2 });
    await store.command({ type: 'audit.list', limit: 2, beforeId: 'a2' });
    expect(store.getState().audit.map(e => e.id)).toEqual(['a1', 'a2', 'a3', 'a4']);
    await store.command({ type: 'audit.list', limit: 10, beforeId: 'a4' });
    expect(store.getState().auditComplete).toBe(true);
    await store.command({ type: 'memory.add', botId: 'bot-1', content: 'hello' });
    expect(store.getState().memory['bot-1'][0].content).toBe('hello');
    await store.command({ type: 'grant.revoke', grantId: 'g' });
    expect(store.getState().snapshot.grants).toHaveLength(0);
    await store.command({ type: 'notification.ack', notificationId: 'n' });
    expect(store.getState().snapshot.notifications[0].acknowledgedAt).toBeTruthy();
  });
});
