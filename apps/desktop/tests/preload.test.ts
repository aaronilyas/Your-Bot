import { describe, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(async () => ({ ok: true, commandId: 'c' })), on: vi.fn(), remove: vi.fn() }));
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: fake.expose }, ipcRenderer: { invoke: fake.invoke, on: fake.on, removeListener: fake.remove } }));
import '../src/preload/index';
describe('sandbox preload', () => {
  it('exposes only fixed dispatch, subscription, folder-picker and appearance functions, excluding IPC event objects', async () => {
    expect(fake.expose).toHaveBeenCalledOnce();
    const [name, transport] = fake.expose.mock.calls[0];
    expect(name).toBe('yourBot'); expect(Object.keys(transport).sort()).toEqual(['chooseDirectory', 'dispatch', 'loadAppearance', 'providers', 'saveAppearance', 'subscribe', 'updates']); expect(Object.isFrozen(transport)).toBe(true); expect(Object.keys(transport.providers).sort()).toEqual(['link', 'login', 'scan', 'update']); expect(Object.isFrozen(transport.providers)).toBe(true);
    expect(Object.keys(transport.updates).sort()).toEqual(['check', 'install', 'onProgress', 'openRelease', 'setAutoCheck', 'status']); expect(Object.isFrozen(transport.updates)).toBe(true);
    const command = { version: 1, id: 'c', type: 'state.sync' };
    await transport.dispatch(command); expect(fake.invoke).toHaveBeenCalledWith('your-bot:dispatch', command);
    const listener = vi.fn(); const unsubscribe = transport.subscribe(listener);
    const handler = fake.on.mock.calls[0][1]; handler({ sender: 'privileged' }, { type: 'task.completed' });
    expect(listener).toHaveBeenCalledWith({ type: 'task.completed' });
    unsubscribe(); expect(fake.remove).toHaveBeenCalledWith('your-bot:event', handler);
    expect(() => transport.subscribe('invalid')).toThrow();
  });
  it('chooseDirectory returns only a bounded path string and never forwards arguments', async () => {
    const transport = fake.expose.mock.calls[0][1];
    fake.invoke.mockClear();
    fake.invoke.mockResolvedValueOnce('/home/me/project' as never);
    expect(await transport.chooseDirectory('ignored', { properties: ['openFile'] })).toBe('/home/me/project');
    expect(fake.invoke).toHaveBeenCalledWith('your-bot:choose-directory');
    for (const odd of [undefined, 42, { path: '/x' }, '', 'x'.repeat(5000)]) { fake.invoke.mockResolvedValueOnce(odd as never); expect(await transport.chooseDirectory()).toBeUndefined(); }
  });
  it('passes only exact appearance preferences in either direction', async () => {
    const transport = fake.expose.mock.calls[0][1];
    const prefs = { colorMode: 'dark', theme: 'winter', backgroundArt: false };
    fake.invoke.mockClear();
    fake.invoke.mockResolvedValueOnce(prefs as never);
    expect(await transport.loadAppearance()).toEqual(prefs);
    expect(fake.invoke).toHaveBeenCalledWith('your-bot:appearance-load');
    for (const odd of [undefined, 42, '/etc/passwd', { ...prefs, extra: 1 }, { ...prefs, theme: 'neon' }]) { fake.invoke.mockResolvedValueOnce(odd as never); expect(await transport.loadAppearance()).toBeUndefined(); }
    fake.invoke.mockClear();
    fake.invoke.mockResolvedValueOnce(true as never);
    expect(await transport.saveAppearance(prefs)).toBe(true);
    expect(fake.invoke).toHaveBeenCalledWith('your-bot:appearance-save', prefs);
    fake.invoke.mockClear();
    expect(await transport.saveAppearance({ ...prefs, colorMode: 'neon' })).toBe(false);
    expect(await transport.saveAppearance({ ...prefs, path: '/tmp/x' })).toBe(false);
    expect(fake.invoke).not.toHaveBeenCalled();
  });
  it('providers bridge sends only id strings on fixed channels', async () => {
    const { providers } = fake.expose.mock.calls[0][1];
    fake.invoke.mockClear();
    await providers.scan(); expect(fake.invoke).toHaveBeenCalledWith('your-bot:providers-scan');
    await providers.link(['claude', 'ollama']); expect(fake.invoke).toHaveBeenCalledWith('your-bot:providers-link', ['claude', 'ollama']);
    await providers.link('all'); expect(fake.invoke).toHaveBeenCalledWith('your-bot:providers-link', 'all');
    await providers.update('claude'); expect(fake.invoke).toHaveBeenCalledWith('your-bot:providers-update', 'claude');
    await providers.login('codex'); expect(fake.invoke).toHaveBeenCalledWith('your-bot:providers-login', 'codex');
    fake.invoke.mockClear();
    expect(() => providers.link('everything')).toThrow(); expect(() => providers.link([{ command: 'rm' }])).toThrow(); expect(() => providers.link(Array(33).fill('claude'))).toThrow();
    expect(() => providers.update({ id: 'claude' })).toThrow(); expect(() => providers.login(undefined)).toThrow(); expect(() => providers.update('')).toThrow();
    expect(fake.invoke).not.toHaveBeenCalled();
  });
  it('updates bridge sends only a release tag or a boolean on fixed channels and filters progress events', async () => {
    const { updates } = fake.expose.mock.calls[0][1];
    fake.invoke.mockClear();
    await updates.status(); expect(fake.invoke).toHaveBeenCalledWith('your-bot:updates-status');
    await updates.check(); expect(fake.invoke).toHaveBeenCalledWith('your-bot:updates-check', false);
    await updates.check(true); expect(fake.invoke).toHaveBeenCalledWith('your-bot:updates-check', true);
    await updates.check('yes'); expect(fake.invoke).toHaveBeenLastCalledWith('your-bot:updates-check', false);
    await updates.install('v0.2.0'); expect(fake.invoke).toHaveBeenCalledWith('your-bot:updates-install', 'v0.2.0');
    await updates.install('1.0.0-beta.1'); expect(fake.invoke).toHaveBeenCalledWith('your-bot:updates-install', '1.0.0-beta.1');
    await updates.openRelease('v0.1.0'); expect(fake.invoke).toHaveBeenCalledWith('your-bot:updates-open-release', 'v0.1.0');
    await updates.openRelease(); expect(fake.invoke).toHaveBeenCalledWith('your-bot:updates-open-release', undefined);
    await updates.setAutoCheck(false); expect(fake.invoke).toHaveBeenCalledWith('your-bot:updates-auto-check', false);
    fake.invoke.mockClear();
    for (const odd of ['latest', '../v1.0.0', 'v1', 'https://evil.example/x.AppImage', { tag: 'v1.0.0' }, undefined]) expect(() => updates.install(odd)).toThrow();
    expect(() => updates.openRelease('javascript:alert(1)')).toThrow(); expect(() => updates.setAutoCheck('false')).toThrow();
    expect(fake.invoke).not.toHaveBeenCalled();
    fake.on.mockClear(); fake.remove.mockClear();
    const listener = vi.fn(); const stop = updates.onProgress(listener);
    const [channel, handler] = fake.on.mock.calls[0];
    expect(channel).toBe('your-bot:updates-progress');
    handler({ sender: 'x' }, { tag: 'v0.2.0', phase: 'downloading', received: 5, total: 10, extra: 'dropped' });
    handler({}, { tag: 'v0.2.0', phase: 'exploding' }); handler({}, null);
    expect(listener).toHaveBeenCalledTimes(1); expect(listener).toHaveBeenCalledWith({ tag: 'v0.2.0', phase: 'downloading', received: 5, total: 10 });
    stop(); expect(fake.remove).toHaveBeenCalledWith('your-bot:updates-progress', handler);
    expect(() => updates.onProgress('nope')).toThrow();
  });
});
