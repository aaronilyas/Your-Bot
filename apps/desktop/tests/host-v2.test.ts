import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnyDesktopCommand, DesktopEventV2, DesktopGatewayV2, PrincipalV2 } from '@your-bot/contracts';
import { emptySnapshot } from '../src/renderer/store';
const fake = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, value?: unknown) => Promise<unknown>>(),
  latestWindow: undefined as any,
  focused: false,
  notifications: [] as { options: any; show: ReturnType<typeof vi.fn>; click?: () => void }[],
  openDialog: vi.fn(),
  appListeners: new Map<string, (...args: any[]) => void>(),
  userData: '/host/data',
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
    isFocused() { return fake.focused; }
    isMinimized() { return false; }
    restore() {} focus() {}
    destroy() { this.destroyed = true; this.listeners.get('closed')?.(); }
    show() {}
  }
  class Notification {
    static isSupported() { return true; }
    show = vi.fn(); handlers: Record<string, () => void> = {};
    constructor(public options: any) { fake.notifications.push(this as any); }
    on(name: string, fn: () => void) { this.handlers[name] = fn; if (name === 'click') (this as any).click = fn; }
  }
  return {
    app: { whenReady: async () => {}, isPackaged: false, getPath: () => fake.userData, on: (name: string, fn: any) => fake.appListeners.set(name, fn), removeListener: (name: string) => fake.appListeners.delete(name), quit: vi.fn(), exit: vi.fn() },
    BrowserWindow: Window, Notification, dialog: { showOpenDialog: fake.openDialog }, Menu: { setApplicationMenu: vi.fn() },
    ipcMain: { handle: (channel: string, handler: any) => fake.handlers.set(channel, handler), removeHandler: (channel: string) => fake.handlers.delete(channel) },
    session: { fromPartition: () => ({ setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), webRequest: { onHeadersReceived: vi.fn(), onBeforeRequest: vi.fn() } }) },
  };
});
const prov = vi.hoisted(() => ({
  scanProviders: vi.fn(async (_providers: unknown) => ({ agents: [], servers: [] })),
  linkProviders: vi.fn(async (settings: any, _targets: unknown) => ({ settings, linked: [] as any[], skipped: [] as any[] })),
  updateAgentCli: vi.fn(async (_id: string) => ({ ok: true, message: 'updated', output: '' })),
  loginTarget: vi.fn(async (id: string) => ({ plan: { command: id }, name: id })),
  openInTerminal: vi.fn(async (_target: unknown) => {}),
}));
vi.mock('@your-bot/providers', () => ({
  ...prov,
  AGENT_CLIS: [{ id: 'claude' }, { id: 'grok' }], LOCAL_SERVERS: [{ id: 'ollama' }],
  agentSpec: (id: string) => ({ claude: { acp: { via: 'npx' } }, grok: { acp: { via: 'self' } } } as Record<string, unknown>)[id],
  linkedProvider: (providers: { id: string }[], _spec: unknown) => providers.find(provider => provider.id === 'agent-claude'),
}));
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopHost } from '../src/main/host';
import { IPC } from '../src/shared/ipc';
beforeEach(() => { fake.handlers.clear(); fake.appListeners.clear(); fake.notifications.length = 0; fake.focused = false; fake.openDialog.mockReset(); });

function setup() {
  let listener: ((event: DesktopEventV2) => void) | undefined;
  const dispatch = vi.fn(async (command: AnyDesktopCommand, _principal: unknown) => ({ ok: true as const, commandId: command.id, snapshot: emptySnapshot() }));
  const subscribe = vi.fn((fn: (event: DesktopEventV2) => void, _principal: unknown, _options?: unknown) => { listener = fn; return vi.fn(); });
  const gateway = { dispatch, subscribe, cancelTask: vi.fn(), requestPermission: vi.fn(), close: vi.fn(async () => {}) } as unknown as DesktopGatewayV2;
  return { gateway, dispatch, subscribe, emit: (event: DesktopEventV2) => listener?.(event) };
}
const valid = () => { const contents = fake.latestWindow.webContents; return { sender: contents, senderFrame: contents.mainFrame }; };
const sendVia = (event: unknown, value: unknown) => fake.handlers.get(IPC.dispatch)!(event, value);

describe('v2 IPC host', () => {
  it('forwards validated v2 frames with the principal supplied by main, and subscribes as a v2 client', async () => {
    const { gateway, dispatch, subscribe } = setup(); let principal: PrincipalV2 | undefined;
    const host = await createDesktopHost({ gatewayFactory: context => { principal = context.principal; return gateway; } });
    expect(subscribe).toHaveBeenCalledWith(expect.any(Function), principal, { contractVersion: 2 });
    expect(principal?.capabilities).toContain('mcp.call');
    const command = { version: 2, id: 'c1', type: 'bot.update', botId: 'b1', patch: { workspace: null } };
    expect(await sendVia(valid(), command)).toMatchObject({ ok: true });
    expect(dispatch).toHaveBeenCalledWith(command, principal);
    expect(dispatch.mock.calls[0][1]).toBe(host.principal);
    await host.close();
  });
  it('rejects malformed, oversized and forged-principal v2 frames without reaching the gateway', async () => {
    const { gateway, dispatch } = setup();
    const host = await createDesktopHost({ gatewayFactory: () => gateway });
    const frames: unknown[] = [
      { version: 2, id: 'a', type: 'bot.create' },
      { version: 2, id: 'b', type: 'state.sync', principalId: 'admin' },
      { version: 2, id: 'c', type: 'state.sync', principal: { id: 'local-owner', kind: 'local', capabilities: ['settings'] } },
      { version: 2, id: 'd', type: 'memory.add', botId: 'b', content: 'x'.repeat(1048577) },
      { version: 2, id: 'e', type: 'permission.decide', decision: { requestId: 'r', outcome: 'allow', scope: 'standing' } },
      { version: 3, id: 'f', type: 'state.sync' }, 'not an object', null,
    ];
    for (const frame of frames) expect(await sendVia(valid(), frame)).toMatchObject({ ok: false, error: { code: 'INVALID_COMMAND' } });
    expect(dispatch).not.toHaveBeenCalled();
    await host.close();
  });
  it('rejects v2 frames from a foreign sender, subframe or URL', async () => {
    const { gateway, dispatch } = setup();
    const host = await createDesktopHost({ gatewayFactory: () => gateway });
    const frame = { version: 2, id: 'c', type: 'device.list' };
    const contents = fake.latestWindow.webContents;
    await expect(sendVia({ ...valid(), sender: {} }, frame)).rejects.toThrow('Untrusted');
    await expect(sendVia({ ...valid(), senderFrame: { url: contents.mainFrame.url } }, frame)).rejects.toThrow('Untrusted');
    const original = contents.mainFrame.url; contents.mainFrame.url = 'https://evil.test';
    await expect(sendVia(valid(), frame)).rejects.toThrow('Untrusted');
    contents.mainFrame.url = original;
    expect(dispatch).not.toHaveBeenCalled();
    await host.close();
  });
  it('scrubs MCP secrets from v2 results and events on their way to the renderer', async () => {
    const { gateway, dispatch, emit } = setup();
    const bot = { id: 'b', name: 'b', instructions: '', agentId: 'a', profile: 'strict' as const, skills: [], memoryEnabled: true, createdAt: '', updatedAt: '', mcpServers: [{ id: 's', name: 's', enabled: true, transport: 'stdio' as const, command: 'c', env: { K: 'leaky-secret' } }] };
    dispatch.mockResolvedValueOnce({ ok: true, commandId: 'x', bot } as never);
    const host = await createDesktopHost({ gatewayFactory: () => gateway });
    expect(JSON.stringify(await sendVia(valid(), { version: 2, id: 'x', type: 'bot.delete', botId: 'b' }))).not.toContain('leaky-secret');
    emit({ version: 2, sequence: 1, timestamp: '', principalId: host.principal.id, type: 'bot.updated', bot });
    expect(JSON.stringify(fake.latestWindow.webContents.send.mock.calls)).not.toContain('leaky-secret');
    await host.close();
  });
  it('shows a native notification only while the window is unfocused, with bounded plain text', async () => {
    const { gateway, emit } = setup();
    const host = await createDesktopHost({ gatewayFactory: () => gateway });
    const notification = { id: 'n', kind: 'approval.required' as const, title: `Approve\n${'t'.repeat(500)}`, body: `run\u0007 this ${'b'.repeat(900)}`, createdAt: '' };
    const event = { version: 2 as const, sequence: 1, timestamp: '', principalId: host.principal.id, type: 'notification' as const, notification };
    fake.focused = true; emit(event);
    expect(fake.notifications).toHaveLength(0);
    expect(fake.latestWindow.webContents.send).toHaveBeenCalledWith(IPC.event, expect.objectContaining({ type: 'notification' }));
    fake.focused = false; emit({ ...event, sequence: 2 });
    expect(fake.notifications).toHaveLength(1);
    const { options, show } = fake.notifications[0];
    expect(show).toHaveBeenCalledOnce();
    expect(options.title.length).toBeLessThanOrEqual(120); expect(options.body.length).toBeLessThanOrEqual(300);
    expect(options.title).not.toMatch(/[\u0000-\u001f]/); expect(options.body).not.toMatch(/[\u0000-\u001f]/);
    emit({ ...event, sequence: 3, principalId: 'someone-else' });
    expect(fake.notifications).toHaveLength(1);
    await host.close();
  });
});

describe('appearance preferences', () => {
  it('stores only exact preferences in the data folder and refuses untrusted frames', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'your-bot-appearance-'));
    fake.userData = folder;
    try {
      const { gateway } = setup();
      const host = await createDesktopHost({ gatewayFactory: () => gateway });
      const load = fake.handlers.get(IPC.loadAppearance)!, save = fake.handlers.get(IPC.saveAppearance)!;
      expect(await load(valid())).toBeUndefined();
      const prefs = { colorMode: 'light', theme: 'autumn', backgroundArt: false };
      expect(await save(valid(), prefs)).toBe(true);
      expect(JSON.parse(await readFile(join(folder, 'appearance.json'), 'utf8'))).toEqual(prefs);
      expect(await load(valid())).toEqual(prefs);
      for (const odd of [undefined, 'x', { ...prefs, theme: 'neon' }, { ...prefs, extra: true }]) expect(await save(valid(), odd)).toBe(false);
      expect(await load(valid())).toEqual(prefs);
      await expect(save({ ...valid(), sender: {} }, prefs)).rejects.toThrow('Untrusted');
      await expect(load({ ...valid(), sender: {} })).rejects.toThrow('Untrusted');
      await writeFile(join(folder, 'appearance.json'), '{"colorMode":"dark","theme":"winter","backgroundArt":true,"x":1}');
      expect(await load(valid())).toBeUndefined();
      await host.close();
      expect(fake.handlers.has(IPC.loadAppearance)).toBe(false);
      expect(fake.handlers.has(IPC.saveAppearance)).toBe(false);
    } finally { fake.userData = '/host/data'; await rm(folder, { recursive: true, force: true }); }
  });
});

describe('chooseDirectory', () => {
  it('opens a folder-only dialog from the trusted frame and returns just the chosen path', async () => {
    const { gateway } = setup();
    const host = await createDesktopHost({ gatewayFactory: () => gateway });
    const choose = fake.handlers.get(IPC.chooseDirectory)!;
    fake.openDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/home/me/project', '/other'] });
    expect(await choose(valid(), { properties: ['openFile'], defaultPath: '/etc' })).toBe('/home/me/project');
    expect(fake.openDialog).toHaveBeenCalledWith(fake.latestWindow, { title: 'Choose a workspace folder', properties: ['openDirectory'] });
    fake.openDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await choose(valid())).toBeUndefined();
    await expect(choose({ ...valid(), sender: {} })).rejects.toThrow('Untrusted');
    expect(fake.openDialog).toHaveBeenCalledTimes(2);
    await host.close();
    expect(fake.handlers.has(IPC.chooseDirectory)).toBe(false);
  });
  it('allows only one dialog at a time', async () => {
    const { gateway } = setup();
    const host = await createDesktopHost({ gatewayFactory: () => gateway });
    const choose = fake.handlers.get(IPC.chooseDirectory)!;
    let finish!: (value: unknown) => void;
    fake.openDialog.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = choose(valid());
    expect(await choose(valid())).toBeUndefined();
    finish({ canceled: false, filePaths: ['/a'] });
    expect(await first).toBe('/a');
    await host.close();
  });
});

describe('provider detection IPC', () => {
  const call = (channel: string, value?: unknown, event: unknown = valid()) => fake.handlers.get(channel)!(event, value) as Promise<any>;
  const withSettings = (setup_: ReturnType<typeof setup>, providers: unknown[] = []) => setup_.dispatch.mockImplementation(async (command: AnyDesktopCommand) => ({ ok: true as const, commandId: command.id, snapshot: { ...emptySnapshot(), settings: { providers: providers as never } } }));
  beforeEach(() => Object.values(prov).forEach(fn => fn.mockClear()));
  it('rejects untrusted senders and removes the handlers on close', async () => {
    const s = setup(); const host = await createDesktopHost({ gatewayFactory: () => s.gateway });
    for (const channel of [IPC.providersScan, IPC.providersLink, IPC.providersUpdate, IPC.providersLogin]) await expect(call(channel, 'claude', { sender: {} })).rejects.toThrow('Untrusted');
    await host.close();
    for (const channel of [IPC.providersScan, IPC.providersLink, IPC.providersUpdate, IPC.providersLogin]) expect(fake.handlers.has(channel)).toBe(false);
  });
  it('scans with the providers from the current settings', async () => {
    const s = setup(); withSettings(s, [{ id: 'p' }]); const host = await createDesktopHost({ gatewayFactory: () => s.gateway });
    expect(await call(IPC.providersScan)).toEqual({ agents: [], servers: [] });
    expect(prov.scanProviders).toHaveBeenCalledWith([{ id: 'p' }]);
    await host.close();
  });
  it('links only known ids, saves settings and refreshes models; surfaces busy settings', async () => {
    const s = setup(); withSettings(s); const host = await createDesktopHost({ gatewayFactory: () => s.gateway });
    for (const bad of ['claude', ['claude', '/bin/sh'], ['x'.repeat(10)], Array(33).fill('claude'), { command: 'x' }, undefined]) await expect(call(IPC.providersLink, bad)).rejects.toThrow('Unknown');
    expect(prov.linkProviders).not.toHaveBeenCalled();
    prov.linkProviders.mockResolvedValueOnce({ settings: { providers: [{ id: 'agent-claude' }] } as never, linked: [{ id: 'claude', name: 'Claude Code', providerId: 'agent-claude', created: true }], skipped: [] });
    expect(await call(IPC.providersLink, ['claude'])).toMatchObject({ linked: [{ id: 'claude' }] });
    const types = s.dispatch.mock.calls.map(([command]) => command.type);
    expect(types).toEqual(['state.sync', 'settings.update', 'models.refresh']);
    expect(s.dispatch.mock.calls[1][0]).toMatchObject({ settings: { providers: [{ id: 'agent-claude' }] } });
    prov.linkProviders.mockResolvedValueOnce({ settings: { providers: [] } as never, linked: [{ id: 'grok', name: 'Grok', providerId: 'agent-grok', created: true }], skipped: [] });
    s.dispatch.mockImplementation(async (command: AnyDesktopCommand) => command.type === 'settings.update' ? { ok: false as const, commandId: command.id, error: { code: 'SETTINGS_BUSY', message: 'busy' } } : { ok: true as const, commandId: command.id, snapshot: emptySnapshot() });
    const busy = await call(IPC.providersLink, 'all');
    expect(busy.linked).toEqual([]); expect(busy.error).toMatch(/while a task is running/);
    await host.close();
  });
  it('updates by id, truncates output, and re-links npx adapters that are already connected', async () => {
    const s = setup(); withSettings(s, [{ id: 'agent-claude' }]); const host = await createDesktopHost({ gatewayFactory: () => s.gateway });
    await expect(call(IPC.providersUpdate, 'rm -rf')).rejects.toThrow('Unknown agent');
    prov.updateAgentCli.mockResolvedValueOnce({ ok: true, message: 'ok', output: 'a'.repeat(20000) + 'END' });
    const result = await call(IPC.providersUpdate, 'claude');
    expect(result.output).toHaveLength(8192); expect(result.output.endsWith('END')).toBe(true);
    expect(prov.linkProviders).toHaveBeenCalledWith(expect.anything(), ['claude']);
    prov.linkProviders.mockClear();
    await call(IPC.providersUpdate, 'grok');
    expect(prov.linkProviders).not.toHaveBeenCalled();
    await host.close();
  });
  it('opens sign-in in a terminal and reports failures as a message', async () => {
    const s = setup(); const host = await createDesktopHost({ gatewayFactory: () => s.gateway });
    await expect(call(IPC.providersLogin, { id: 'claude' })).rejects.toThrow('Unknown agent');
    expect(await call(IPC.providersLogin, 'claude')).toEqual({ ok: true });
    expect(prov.openInTerminal).toHaveBeenCalledWith({ plan: { command: 'claude' }, name: 'claude' });
    prov.openInTerminal.mockRejectedValueOnce(new Error('No terminal. Run: claude login'));
    expect(await call(IPC.providersLogin, 'claude')).toEqual({ ok: false, message: 'No terminal. Run: claude login' });
    await host.close();
  });
});

describe('app update IPC', () => {
  const CHANNELS = [IPC.updatesStatus, IPC.updatesCheck, IPC.updatesInstall, IPC.updatesOpenRelease, IPC.updatesSetAutoCheck];
  const call = (channel: string, value?: unknown, event: unknown = valid()) => fake.handlers.get(channel)!(event, value) as Promise<any>;
  const fakeUpdater = () => ({
    status: vi.fn(async () => ({ currentVersion: '0.1.0', install: { kind: 'appimage' as const, label: 'AppImage', canInstall: true }, autoCheck: true })),
    check: vi.fn(async (_force?: boolean) => ({ currentVersion: '0.1.0', install: { kind: 'appimage' as const, label: 'AppImage', canInstall: true }, autoCheck: true, checkedAt: 'now', releases: [], updateAvailable: false })),
    install: vi.fn(async (_tag: string, onProgress?: (progress: any) => void) => { onProgress?.({ tag: 'v0.2.0', phase: 'downloading', received: 1, total: 2 }); return { ok: true, message: 'done', restarting: true }; }),
    openRelease: vi.fn(async (_tag?: string) => true),
    setAutoCheck: vi.fn(async (_enabled: boolean) => true),
  });
  it('registers nothing without an updater', async () => {
    const s = setup(); const host = await createDesktopHost({ gatewayFactory: () => s.gateway });
    for (const channel of CHANNELS) expect(fake.handlers.has(channel)).toBe(false);
    await host.close();
  });
  it('passes only a validated tag or boolean, forwards progress to the window, and unregisters on close', async () => {
    const s = setup(); const updater = fakeUpdater();
    const host = await createDesktopHost({ gatewayFactory: () => s.gateway, updater });
    expect(await call(IPC.updatesStatus)).toMatchObject({ currentVersion: '0.1.0' });
    await call(IPC.updatesCheck, true); expect(updater.check).toHaveBeenLastCalledWith(true);
    await call(IPC.updatesCheck, 'yes'); expect(updater.check).toHaveBeenLastCalledWith(false);
    expect(await call(IPC.updatesInstall, 'v0.2.0')).toEqual({ ok: true, message: 'done', restarting: true });
    expect(updater.install).toHaveBeenCalledWith('v0.2.0', expect.any(Function));
    expect(fake.latestWindow.webContents.send).toHaveBeenCalledWith(IPC.updatesProgress, { tag: 'v0.2.0', phase: 'downloading', received: 1, total: 2 });
    for (const bad of ['latest', 'v1', '/tmp/x.AppImage', 'https://evil.example/', { tag: 'v1.0.0' }, undefined, `v1.0.0-${'x'.repeat(80)}`]) await expect(call(IPC.updatesInstall, bad)).rejects.toThrow('Unknown version');
    expect(updater.install).toHaveBeenCalledTimes(1);
    await call(IPC.updatesOpenRelease); expect(updater.openRelease).toHaveBeenLastCalledWith(undefined);
    await call(IPC.updatesOpenRelease, 'v0.1.0'); expect(updater.openRelease).toHaveBeenLastCalledWith('v0.1.0');
    await expect(call(IPC.updatesOpenRelease, 'https://evil.example/')).rejects.toThrow('Unknown version');
    await call(IPC.updatesSetAutoCheck, false); expect(updater.setAutoCheck).toHaveBeenCalledWith(false);
    await expect(call(IPC.updatesSetAutoCheck, 'false')).rejects.toThrow('boolean');
    for (const channel of CHANNELS) await expect(call(channel, 'v0.2.0', { sender: {} })).rejects.toThrow('Untrusted');
    await host.close();
    for (const channel of CHANNELS) expect(fake.handlers.has(channel)).toBe(false);
  });
});
