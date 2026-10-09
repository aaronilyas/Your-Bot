import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopGateway, DesktopEvent, Principal } from '@your-bot/contracts';
import { emptySnapshot } from '../src/renderer/store';
const fake = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, value: unknown) => Promise<unknown>>(),
  requests: {} as Record<string, (...args: any[]) => void>,
  permissionRequest: undefined as undefined | ((...args: any[]) => void),
  permissionCheck: undefined as undefined | (() => boolean),
  latestWindow: undefined as any,
  appListeners: new Map<string, (...args: any[]) => void>(),
  quit: vi.fn(),
}));
vi.mock('electron', () => {
  class Window {
    options: any; url = ''; destroyed = false; listeners = new Map<string, (...args: any[]) => void>();
    webContents = { mainFrame: { url: '' }, getURL: () => this.url, send: vi.fn(), setWindowOpenHandler: vi.fn(), on: vi.fn((name, fn) => { this.listeners.set(name, fn); }) };
    constructor(options: unknown) { this.options = options; fake.latestWindow = this; }
    on(name: string, fn: (...args: any[]) => void) { this.listeners.set(name, fn); }
    once(name: string, fn: (...args: any[]) => void) { this.listeners.set(name, fn); }
    async loadURL(url: string) { this.url = url; this.webContents.mainFrame.url = url; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.listeners.get('closed')?.(); }
    show() {}
  }
  return {
    app: { whenReady: async () => {}, isPackaged: false, getPath: () => '/host/data', on: (name: string, fn: any) => fake.appListeners.set(name, fn), removeListener: (name: string) => fake.appListeners.delete(name), quit: fake.quit, exit: vi.fn() },
    BrowserWindow: Window, Menu: { setApplicationMenu: vi.fn() },
    ipcMain: { handle: (channel: string, handler: any) => fake.handlers.set(channel, handler), removeHandler: (channel: string) => fake.handlers.delete(channel) },
    session: { fromPartition: () => ({ setPermissionRequestHandler: (fn: any) => { fake.permissionRequest = fn; }, setPermissionCheckHandler: (fn: any) => { fake.permissionCheck = fn; }, webRequest: { onHeadersReceived: (fn: any) => { fake.requests.headers = fn; }, onBeforeRequest: (fn: any) => { fake.requests.before = fn; } } }) },
  };
});
import { createDesktopHost, SECURE_WEB_PREFERENCES } from '../src/main/host';
import { IPC } from '../src/shared/ipc';
beforeEach(() => { fake.handlers.clear(); fake.appListeners.clear(); fake.quit.mockClear(); });
function gatewayFixture() {
  let listener: ((event: DesktopEvent) => void) | undefined;
  const snapshot = emptySnapshot(); snapshot.settings.providers.push({ id: 'p', name: 'p', kind: 'lmstudio', enabled: true, apiKey: 'host-secret' });
  const gateway: DesktopGateway = { dispatch: vi.fn(async command => ({ ok: true, commandId: command.id, snapshot })), subscribe: vi.fn(fn => { listener = fn; return vi.fn(); }), requestPermission: vi.fn(), cancelTask: vi.fn(), close: vi.fn(async () => {}) };
  return { gateway, emit: (event: DesktopEvent) => listener?.(event) };
}
describe('Electron main integration boundary', () => {
  it('waits for asynchronous gateway shutdown before allowing Electron to quit', async () => {
    const { gateway } = gatewayFixture();
    let finish!: () => void;
    vi.mocked(gateway.close).mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const host = await createDesktopHost({ gatewayFactory: () => gateway });
    const preventDefault = vi.fn(); fake.appListeners.get('before-quit')?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(gateway.close).toHaveBeenCalledOnce());
    expect(fake.quit).not.toHaveBeenCalled();
    finish(); await host.close();
    await vi.waitFor(() => expect(fake.quit).toHaveBeenCalledOnce());
    expect(fake.appListeners.has('before-quit')).toBe(false);
  });
  it('injects host identity and rejects foreign windows, frames, URLs and identities', async () => {
    const { gateway } = gatewayFixture(); let principal: Principal | undefined;
    const host = await createDesktopHost({ developmentURL: 'http://127.0.0.1:5173', gatewayFactory: context => { principal = context.principal; expect(context.userDataPath).toBe('/host/data'); return gateway; } });
    expect(fake.latestWindow.options.webPreferences).toMatchObject(SECURE_WEB_PREFERENCES);
    const handler = fake.handlers.get(IPC.dispatch)!;
    const contents = fake.latestWindow.webContents;
    const valid = { sender: contents, senderFrame: contents.mainFrame };
    const command = { version: 1, id: 'c', type: 'state.sync' };
    const result = await handler(valid, command);
    expect(gateway.dispatch).toHaveBeenCalledWith(command, principal);
    expect(JSON.stringify(result)).not.toContain('host-secret');
    await expect(handler({ ...valid, sender: {} }, command)).rejects.toThrow('Untrusted');
    await expect(handler({ ...valid, senderFrame: { url: contents.mainFrame.url } }, command)).rejects.toThrow('Untrusted');
    contents.mainFrame.url = 'https://evil.test'; await expect(handler(valid, command)).rejects.toThrow('Untrusted');
    contents.mainFrame.url = fake.latestWindow.url;
    expect(await handler(valid, { ...command, principalId: 'admin' })).toMatchObject({ ok: false, error: { code: 'INVALID_COMMAND' } });
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    await host.close(); expect(fake.handlers.has(IPC.dispatch)).toBe(false); expect(gateway.close).toHaveBeenCalledOnce();
  });
  it('filters owner events, denies browser permissions and blocks unexpected assets', async () => {
    const { gateway, emit } = gatewayFixture();
    const host = await createDesktopHost({ gatewayFactory: () => gateway, rendererFile: '/app/renderer/index.html' });
    const contents = fake.latestWindow.webContents;
    const event: DesktopEvent = { version: 1, sequence: 1, timestamp: '', principalId: host.principal.id, type: 'agents.updated', agents: [] };
    emit({ ...event, principalId: 'remote' }); expect(contents.send).not.toHaveBeenCalled();
    emit(event); expect(contents.send).toHaveBeenCalledWith(IPC.event, event);
    const callback = vi.fn(); fake.permissionRequest?.(contents, 'media', callback); expect(callback).toHaveBeenCalledWith(false); expect(fake.permissionCheck?.()).toBe(false);
    for (const url of ['file:///etc/passwd', 'file:///app/renderer/../secret', 'https://example.test']) { callback.mockClear(); fake.requests.before({ url }, callback); expect(callback).toHaveBeenCalledWith({ cancel: true }); }
    callback.mockClear(); fake.requests.before({ url: 'file:///app/renderer/assets/main.js' }, callback); expect(callback).toHaveBeenCalledWith({ cancel: false });
    const preventDefault = vi.fn(); fake.latestWindow.listeners.get('will-navigate')({ preventDefault }, 'https://example.test'); expect(preventDefault).toHaveBeenCalledOnce();
    expect(contents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' });
    await host.close(); await host.close(); expect(gateway.close).toHaveBeenCalledOnce();
  });
});
