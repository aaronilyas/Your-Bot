import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackendTransport, DesktopCommand, DesktopEvent, EventPayload, Session } from '@your-bot/contracts';
import { DesktopStore, emptySnapshot } from '../src/renderer/store';
const session: Session = { id: 's', title: 'Session', agentId: 'a', createdAt: '2026-01-01', updatedAt: '2026-01-01', messages: [] };
function fixture() {
  const snapshot = { ...emptySnapshot(), sessions: [session] };
  let listener: ((event: DesktopEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const transport: BackendTransport = { dispatch: vi.fn(async command => ({ ok: true, commandId: command.id, snapshot: structuredClone(snapshot) })), subscribe: vi.fn(fn => { listener = fn; return unsubscribe; }) };
  const store = new DesktopStore(transport);
  const emit = (sequence: number, payload: EventPayload) => listener?.({ ...payload, version: 1, principalId: 'local-owner', timestamp: '', sequence });
  return { store, transport, emit, unsubscribe };
}
afterEach(() => vi.restoreAllMocks());
describe('desktop state', () => {
  it('syncs, streams once, reconciles final messages, and cancels pending approvals', async () => {
    const { store, emit, unsubscribe } = fixture(); const stop = store.start();
    await vi.waitFor(() => expect(store.getState().connection).toBe('connected'));
    emit(1, { type: 'task.started', taskId: 't', sessionId: 's' });
    emit(2, { type: 'message.delta', taskId: 't', sessionId: 's', text: 'Hello' });
    emit(2, { type: 'message.delta', taskId: 't', sessionId: 's', text: 'duplicate' });
    expect(store.getState().tasks.t.text).toBe('Hello');
    emit(3, { type: 'permission.requested', request: { id: 'p', taskId: 't', sessionId: 's', principalId: 'local-owner', capability: 'file.read', reason: 'Read one file' } });
    emit(4, { type: 'tool.output', taskId: 't', sessionId: 's', toolCallId: 'tool', stream: 'stdout', text: 'output' });
    emit(5, { type: 'session.updated', session: { ...session, messages: [{ id: 'm', role: 'assistant', taskId: 't', content: 'Hello', createdAt: '' }] } });
    expect(store.getState().tasks.t.text).toBe('');
    emit(6, { type: 'task.cancelled', taskId: 't', sessionId: 's' });
    expect(store.getState().tasks.t.output[0].text).toBe('output');
    expect(store.getState().snapshot.pendingPermissions).toHaveLength(0);
    expect(store.getState().snapshot.activeTasks).toHaveLength(0);
    stop(); expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it('resynchronizes on sequence gaps and keeps newer state over stale snapshots', async () => {
    const { store, emit, transport } = fixture(); store.start();
    await vi.waitFor(() => expect(store.getState().connection).toBe('connected'));
    emit(9, { type: 'task.status', taskId: 't', sessionId: 's', status: 'Thinking' });
    await vi.waitFor(() => expect(transport.dispatch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(store.getState().snapshot.lastSequence).toBe(9));
    expect(store.getState().tasks.t.status).toBe('Thinking');
  });
  it('reports failed tasks and removes deleted sessions and activity', async () => {
    const { store, emit } = fixture(); store.start();
    await vi.waitFor(() => expect(store.getState().selectedSessionId).toBe('s'));
    emit(1, { type: 'task.failed', taskId: 't', sessionId: 's', error: { code: 'ADAPTER_ERROR', message: 'Provider unavailable' } });
    expect(store.getState().error).toBe('Provider unavailable');
    expect(store.getState().tasks.t.running).toBe(false);
    emit(2, { type: 'session.deleted', sessionId: 's' });
    expect(store.getState().selectedSessionId).toBeUndefined();
    expect(Object.keys(store.getState().tasks)).toHaveLength(0);
  });
  it('marks transport rejection disconnected, preserving command IDs and no identity field', async () => {
    const transport: BackendTransport = { dispatch: vi.fn(async (_command: DesktopCommand) => { throw new Error('Connection lost'); }), subscribe: () => () => {} };
    const store = new DesktopStore(transport); store.start();
    await vi.waitFor(() => expect(store.getState().connection).toBe('disconnected'));
    expect(store.getState().error).toBe('Connection lost');
    const command = vi.mocked(transport.dispatch).mock.calls[0][0];
    expect(command.version).toBe(1); expect(command.id).toMatch(/^[\da-f-]{36}$/); expect(command).not.toHaveProperty('principal');
  });
  it('times out a stalled backend and releases command busy state', async () => {
    const store = new DesktopStore({ dispatch: () => new Promise(() => {}), subscribe: () => () => {} }, 10);
    store.start(); await vi.waitFor(() => expect(store.getState().connection).toBe('disconnected'));
    expect(store.getState().pendingCommands).toBe(0);
    expect(store.getState().error).toContain('did not respond');
  });
});

describe('snapshot races', () => {
  it('replays events received during initial synchronization after applying its snapshot', async () => {
    let listener: ((event: DesktopEvent) => void) | undefined;
    let resolve!: (value: any) => void;
    const store = new DesktopStore({ subscribe(fn) { listener = fn; return () => {}; }, dispatch: () => new Promise(done => { resolve = done; }) });
    store.start();
    listener?.({ type: 'task.started', taskId: 't', sessionId: 's', version: 1, principalId: 'local-owner', timestamp: '', sequence: 1 });
    listener?.({ type: 'message.delta', taskId: 't', sessionId: 's', text: 'Hello', version: 1, principalId: 'local-owner', timestamp: '', sequence: 2 });
    resolve({ ok: true, commandId: 'sync', snapshot: { ...emptySnapshot(), sessions: [session] } });
    await vi.waitFor(() => expect(store.getState().tasks.t?.text).toBe('Hello'));
    expect(store.getState().snapshot.sessions[0].id).toBe('s');
    expect(store.getState().snapshot.lastSequence).toBe(2);
  });
});
