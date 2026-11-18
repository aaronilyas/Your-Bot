import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, session, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AnyCommandResult, DesktopGateway, DesktopGatewayV2, OwnerNotification, PrincipalV2 } from '@your-bot/contracts';
import { IPC } from '../shared/ipc';
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
