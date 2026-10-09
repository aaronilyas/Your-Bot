import { describe, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(async () => ({ ok: true, commandId: 'c' })), on: vi.fn(), remove: vi.fn() }));
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: fake.expose }, ipcRenderer: { invoke: fake.invoke, on: fake.on, removeListener: fake.remove } }));
import '../src/preload/index';
describe('sandbox preload', () => {
  it('exposes only fixed dispatch and subscription functions, excluding IPC event objects', async () => {
    expect(fake.expose).toHaveBeenCalledOnce();
    const [name, transport] = fake.expose.mock.calls[0];
    expect(name).toBe('yourBot'); expect(Object.keys(transport).sort()).toEqual(['dispatch', 'subscribe']); expect(Object.isFrozen(transport)).toBe(true);
    const command = { version: 1, id: 'c', type: 'state.sync' };
    await transport.dispatch(command); expect(fake.invoke).toHaveBeenCalledWith('your-bot:dispatch', command);
    const listener = vi.fn(); const unsubscribe = transport.subscribe(listener);
    const handler = fake.on.mock.calls[0][1]; handler({ sender: 'privileged' }, { type: 'task.completed' });
    expect(listener).toHaveBeenCalledWith({ type: 'task.completed' });
    unsubscribe(); expect(fake.remove).toHaveBeenCalledWith('your-bot:event', handler);
    expect(() => transport.subscribe('invalid')).toThrow();
  });
});
