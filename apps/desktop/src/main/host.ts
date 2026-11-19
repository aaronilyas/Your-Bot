import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, session, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AnyCommandResult, DesktopGateway, DesktopGatewayV2, OwnerNotification, PrincipalV2 } from '@your-bot/contracts';
import { AGENT_CLIS, LOCAL_SERVERS, agentSpec, linkProviders, linkedProvider, loginTarget, openInTerminal, scanProviders, updateAgentCli } from '@your-bot/providers';
import { IPC, type ProvidersLinkResult, type ProvidersLoginResult, type ProvidersScanResult, type ProvidersUpdateResult, type UpdateCheckResult, type UpdateInstallResult, type UpdateStatus } from '../shared/ipc';
import { TAG, type Updater } from './updater';
import { parseAppearance, type AppearancePrefs } from '../shared/appearance';
import { parseAnyCommand, trustedRendererURL, validateDevelopmentURL, rendererCSP, redactResult, rendererEvent } from './security';
export interface GatewayFactoryContext {
  /** Host-authenticated local identity. Never supplied by the renderer. */
  readonly principal: PrincipalV2;
  /** Host storage directory; factory owns storage and credential protection. */
  readonly userDataPath: string;
}
/** A v1 gateway is accepted for compatibility; v2 commands then fail inside it with its own validation error. */
export type GatewayFactory = (context: GatewayFactoryContext) => DesktopGatewayV2 | DesktopGateway | Promise<DesktopGatewayV2 | DesktopGateway>;
export interface DesktopHostOptions {
  gatewayFactory: GatewayFactory;
  /** Stable host-authenticated identity across restarts. Defaults to local-owner. */
  principalId?: string;
  /** Only supported in an unpackaged app; HTTP loopback only. */
  developmentURL?: string;
  rendererFile?: string;
  preloadFile?: string;
  /** In-app updates; without it the update channels are not registered and the renderer hides the panel. */
  updater?: Updater;
}
export interface DesktopHost {
  readonly window: BrowserWindow;
  readonly principal: PrincipalV2;
  close(): Promise<void>;
}
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const SECURE_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
  allowRunningInsecureContent: false, webviewTag: false,
});
const printable = (value: unknown, max: number): string => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
/** Native OS notification for the owner while the window is not focused. Text is length-bounded and control-stripped. */
function notifyOwner(window: BrowserWindow, notification: OwnerNotification): void {
  try {
    if (window.isFocused() || !Notification.isSupported()) return;
    const native = new Notification({ title: printable(notification.title, 120) || 'Your Bot', body: printable(notification.body, 300) });
    native.on('click', () => { if (window.isDestroyed()) return; if (window.isMinimized()) window.restore(); window.show(); window.focus(); });
    native.show();
  } catch { /* A notification failure must never disturb event delivery. */ }
}
/** Call once per Electron process. Parent supplies core/adapters through the factory. */
export async function createDesktopHost(options: DesktopHostOptions): Promise<DesktopHost> {
  await app.whenReady();
  if (app.isPackaged && options.developmentURL) throw new Error('Development URL is disabled in packaged builds');
  const developmentURL = options.developmentURL ? validateDevelopmentURL(options.developmentURL) : undefined;
  const rendererFile = resolve(options.rendererFile ?? resolve(moduleDirectory, '../renderer/index.html'));
  const expectedURL = developmentURL ?? pathToFileURL(rendererFile).href;
  const principal = Object.freeze<PrincipalV2>({ id: options.principalId ?? 'local-owner', kind: 'local', capabilities: ['conversation', 'settings', 'tool.execute', 'file.read', 'file.write', 'file.delete', 'library.install', 'network', 'process.spawn', 'mcp.call'] });
  Object.freeze(principal.capabilities);
  // The core gateway implements both contracts; v1 commands stay valid and v2 is selected per command.
  const gateway = await options.gatewayFactory({ principal, userDataPath: app.getPath('userData') }) as unknown as DesktopGatewayV2;
  // Dedicated ephemeral Chromium session: no inherited browser cookies or permissions.
  const browserSession = session.fromPartition(`your-bot-${randomUUID()}`);
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [rendererCSP(developmentURL)] } });
  });
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      const url = new URL(details.url);
      if (developmentURL) {
        const origin = new URL(developmentURL).origin;
        allowed = url.origin === origin || url.origin === origin.replace('http:', 'ws:');
      } else if (url.protocol === 'file:') {
        const asset = relative(dirname(rendererFile), fileURLToPath(url));
        allowed = !asset.startsWith('..') && !isAbsolute(asset);
      } else allowed = url.protocol === 'data:';
    } catch { /* Unknown schemes fail closed. */ }
    callback({ cancel: !allowed });
  });
  Menu.setApplicationMenu(null);
  const window = new BrowserWindow({
    title: 'Your Bot', width: 1280, height: 850, minWidth: 760, minHeight: 580,
    backgroundColor: '#111518', show: false,
    webPreferences: { ...SECURE_WEB_PREFERENCES, session: browserSession, preload: resolve(options.preloadFile ?? resolve(moduleDirectory, '../preload/index.cjs')) },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!trustedRendererURL(url, expectedURL)) event.preventDefault(); });
  window.webContents.on('will-redirect', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  const trusted = (event: IpcMainInvokeEvent) => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && trustedRendererURL(event.senderFrame.url, expectedURL);
  let closed = false;
  const pending = new Set<Promise<AnyCommandResult>>();
  ipcMain.handle(IPC.dispatch, async (event, value: unknown): Promise<AnyCommandResult> => {
    if (!trusted(event)) throw new Error('Untrusted IPC sender');
    const fallbackId = typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string' ? value.id.slice(0, 256) : 'invalid';
    if (closed) return { ok: false, commandId: fallbackId, error: { code: 'DISCONNECTED', message: 'The desktop host is closed', retryable: true } };
    let command;
    try { command = parseAnyCommand(value); } catch { return { ok: false, commandId: fallbackId, error: { code: 'INVALID_COMMAND', message: 'Command does not match contract v1 or v2' } }; }
    // Bound renderer-driven work without weakening gateway command deduplication.
    if (pending.size >= 64) return { ok: false, commandId: command.id, error: { code: 'BUSY', message: 'Too many pending commands', retryable: true } };
    const operation = Promise.resolve().then(() => gateway.dispatch(command, principal));
    pending.add(operation);
    try { return redactResult(await operation); }
    catch { return { ok: false, commandId: command.id, error: { code: 'BACKEND_ERROR', message: 'The backend could not complete this command', retryable: true } }; }
    finally { pending.delete(operation); }
  });
  // The only host capability beyond dispatch/subscribe: a native folder picker that returns a path string.
  // The renderer cannot pass options; the path is only ever sent back as an ordinary (validated) bot command.
  let choosing = false;
  ipcMain.handle(IPC.chooseDirectory, async (event): Promise<string | undefined> => {
    if (!trusted(event)) throw new Error('Untrusted IPC sender');
    if (closed || choosing || window.isDestroyed()) return undefined;
    choosing = true;
    try {
      const result = await dialog.showOpenDialog(window, { title: 'Choose a workspace folder', properties: ['openDirectory'] });
      const chosen = result.canceled ? undefined : result.filePaths[0];
      return typeof chosen === 'string' && chosen.length > 0 && chosen.length <= 4096 ? chosen : undefined;
    } finally { choosing = false; }
  });
  // Display preferences (colour mode, theme, background art). The renderer session is ephemeral, so they live in a
  // small file in the host's data folder. Only an exact, validated preferences object is ever read or written.
  const appearanceFile = join(app.getPath('userData'), 'appearance.json');
  let appearanceWrite: Promise<unknown> = Promise.resolve();
  ipcMain.handle(IPC.loadAppearance, async (event): Promise<AppearancePrefs | undefined> => {
    if (!trusted(event)) throw new Error('Untrusted IPC sender');
    try { return parseAppearance(JSON.parse(await readFile(appearanceFile, 'utf8'))); } catch { return undefined; }
  });
  ipcMain.handle(IPC.saveAppearance, async (event, value: unknown): Promise<boolean> => {
    if (!trusted(event)) throw new Error('Untrusted IPC sender');
    const prefs = parseAppearance(value);
    if (!prefs || closed) return false;
    const write = appearanceWrite.then(async () => {
      const temporary = `${appearanceFile}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(prefs), { mode: 0o600 });
      await rename(temporary, appearanceFile);
    });
    appearanceWrite = write.catch(() => {});
    try { await write; return true; } catch { return false; }
  });
  // Agent CLI / local model server detection. The renderer only supplies catalog ids; commands and paths never cross IPC.
  const knownTargets = new Set<string>([...AGENT_CLIS.map(spec => spec.id), ...LOCAL_SERVERS.map(server => server.id)]);
  const agentId = (value: unknown): string => { if (typeof value !== 'string' || !agentSpec(value)) throw new Error('Unknown agent'); return value; };
  const currentSettings = async () => {
    const result = await gateway.dispatch({ version: 2, id: randomUUID(), type: 'state.sync' }, principal);
    if (!result.ok || !('snapshot' in result) || !result.snapshot) throw new Error('Could not read the current settings');
    return result.snapshot.settings;
  };
  const failure = (error: unknown, fallback: string): string => error instanceof Error && error.message ? error.message.slice(0, 500) : fallback;
  /** Link targets into settings and save them. Returns the summary plus a friendly error when settings could not be saved. */
  const linkAndSave = async (targets: string[] | 'all'): Promise<ProvidersLinkResult> => {
    const settings = await currentSettings();
    const summary = await linkProviders(settings, targets);
    const outcome: ProvidersLinkResult = { linked: summary.linked, skipped: summary.skipped };
    if (summary.linked.length === 0) return outcome;
    const saved = await gateway.dispatch({ version: 2, id: randomUUID(), type: 'settings.update', settings: summary.settings }, principal);
    if (!saved.ok) {
      outcome.linked = [];
      outcome.error = /BUSY/i.test(saved.error.code) ? 'Settings cannot change while a task is running. Wait for it to finish, then try again.' : saved.error.message;
      return outcome;
    }
    await gateway.dispatch({ version: 2, id: randomUUID(), type: 'models.refresh' }, principal);
    return outcome;
  };
  ipcMain.handle(IPC.providersScan, async (event): Promise<ProvidersScanResult> => {
    if (!trusted(event)) throw new Error('Untrusted IPC sender');
    if (closed) throw new Error('The desktop host is closed');
    return JSON.parse(JSON.stringify(await scanProviders((await currentSettings()).providers)));
  });
  ipcMain.handle(IPC.providersLink, async (event, targets: unknown): Promise<ProvidersLinkResult> => {
    if (!trusted(event)) throw new Error('Untrusted IPC sender');
    if (closed) throw new Error('The desktop host is closed');
    if (targets !== 'all' && !(Array.isArray(targets) && targets.length <= 32 && targets.every(target => typeof target === 'string' && knownTargets.has(target)))) throw new Error('Unknown connection target');
    try { return JSON.parse(JSON.stringify(await linkAndSave(targets as string[] | 'all'))); }
    catch (error) { return { linked: [], skipped: [], error: failure(error, 'Could not connect.') }; }
  });
  ipcMain.handle(IPC.providersUpdate, async (event, value: unknown): Promise<ProvidersUpdateResult> => {
    if (!trusted(event)) throw new Error('Untrusted IPC sender');
    if (closed) throw new Error('The desktop host is closed');
    const id = agentId(value);
    const result = await updateAgentCli(id);
    const out: ProvidersUpdateResult = JSON.parse(JSON.stringify({ ...result, output: String(result.output ?? '').slice(-8192) }));
    const spec = agentSpec(id);
    if (result.ok && spec?.acp.via === 'npx') {
      try {
        const linked = linkedProvider((await currentSettings()).providers, spec) !== undefined;
        if (linked) { const relinked = await linkAndSave([id]); if (relinked.error) out.message = `${out.message} (${relinked.error})`; }
      } catch { /* The update itself succeeded; re-pinning can be retried with Reconnect. */ }
    }
    return out;
  });
  ipcMain.handle(IPC.providersLogin, async (event, value: unknown): Promise<ProvidersLoginResult> => {
    if (!trusted(event)) throw new Error('Untrusted IPC sender');
    if (closed) throw new Error('The desktop host is closed');
    const id = agentId(value);
    try { await openInTerminal(await loginTarget(id)); return { ok: true }; }
    catch (error) { return { ok: false, message: failure(error, 'Could not open a terminal.') }; }
  });
  // In-app updates. The renderer sends only a release tag or a boolean; URLs, files and commands stay in the host.
  const { updater } = options;
  const UPDATE_CHANNELS = [IPC.updatesStatus, IPC.updatesCheck, IPC.updatesInstall, IPC.updatesOpenRelease, IPC.updatesSetAutoCheck];
  if (updater) {
    const tag = (value: unknown): string => { if (typeof value !== 'string' || value.length > 80 || !TAG.test(value)) throw new Error('Unknown version'); return value; };
    const guard = (event: IpcMainInvokeEvent) => { if (!trusted(event)) throw new Error('Untrusted IPC sender'); if (closed) throw new Error('The desktop host is closed'); };
    const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
    ipcMain.handle(IPC.updatesStatus, async (event): Promise<UpdateStatus> => { guard(event); return plain(await updater.status()); });
    ipcMain.handle(IPC.updatesCheck, async (event, force: unknown): Promise<UpdateCheckResult> => { guard(event); return plain(await updater.check(force === true)); });
    ipcMain.handle(IPC.updatesInstall, async (event, value: unknown): Promise<UpdateInstallResult> => {
      guard(event);
      return plain(await updater.install(tag(value), progress => { if (!closed && !window.isDestroyed() && trustedRendererURL(window.webContents.getURL(), expectedURL)) window.webContents.send(IPC.updatesProgress, plain(progress)); }));
    });
    ipcMain.handle(IPC.updatesOpenRelease, async (event, value: unknown): Promise<boolean> => { guard(event); return updater.openRelease(value === undefined ? undefined : tag(value)); });
    ipcMain.handle(IPC.updatesSetAutoCheck, async (event, value: unknown): Promise<boolean> => { guard(event); if (typeof value !== 'boolean') throw new Error('A boolean is required'); return updater.setAutoCheck(value); });
  }
  let unsubscribe = () => {};
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    // Assign before destroy() can synchronously emit the closed event.
    closing = Promise.resolve().then(async () => {
      ipcMain.removeHandler(IPC.dispatch);
      ipcMain.removeHandler(IPC.chooseDirectory);
      ipcMain.removeHandler(IPC.loadAppearance);
      ipcMain.removeHandler(IPC.saveAppearance);
      for (const channel of [IPC.providersScan, IPC.providersLink, IPC.providersUpdate, IPC.providersLogin]) ipcMain.removeHandler(channel);
      if (updater) for (const channel of UPDATE_CHANNELS) ipcMain.removeHandler(channel);
      unsubscribe();
      if (!window.isDestroyed()) window.destroy();
      await gateway.close();
    }).finally(() => app.removeListener('before-quit', onBeforeQuit));
    return closing;
  };
  const onBeforeQuit = (event: { preventDefault(): void }): void => {
    event.preventDefault();
    void close().then(() => app.quit()).catch(error => {
      console.error('Desktop shutdown failed', error);
      app.exit(1);
    });
  };
  app.on('before-quit', onBeforeQuit);
  window.on('closed', () => { void close().catch(error => console.error('Desktop shutdown failed', error)); });
  window.once('ready-to-show', () => window.show());
  try {
    unsubscribe = gateway.subscribe(event => {
      const safe = rendererEvent(event, principal);
      if (!safe || closed || window.isDestroyed()) return;
      if (safe.type === 'notification') notifyOwner(window, safe.notification);
      if (trustedRendererURL(window.webContents.getURL(), expectedURL)) window.webContents.send(IPC.event, safe);
    }, principal, { contractVersion: 2 });
    await window.loadURL(expectedURL);
  }
  catch (error) { await close(); throw error; }
  return { window, principal, close };
}
