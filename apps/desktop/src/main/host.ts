import { app, BrowserWindow, ipcMain, Menu, session, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DesktopGateway, Principal, CommandResult } from '@your-bot/contracts';
import { IPC } from '../shared/ipc';
import { parseCommand, trustedRendererURL, validateDevelopmentURL, rendererCSP, redactResult, rendererEvent } from './security';
export interface GatewayFactoryContext {
  /** Host-authenticated local identity. Never supplied by the renderer. */
  readonly principal: Principal;
  /** Host storage directory; factory owns storage and credential protection. */
  readonly userDataPath: string;
}
export type GatewayFactory = (context: GatewayFactoryContext) => DesktopGateway | Promise<DesktopGateway>;
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
  readonly principal: Principal;
  close(): Promise<void>;
}
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const SECURE_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
  allowRunningInsecureContent: false, webviewTag: false,
});
/** Call once per Electron process. Parent supplies core/adapters through the factory. */
export async function createDesktopHost(options: DesktopHostOptions): Promise<DesktopHost> {
  await app.whenReady();
  if (app.isPackaged && options.developmentURL) throw new Error('Development URL is disabled in packaged builds');
  const developmentURL = options.developmentURL ? validateDevelopmentURL(options.developmentURL) : undefined;
  const rendererFile = resolve(options.rendererFile ?? resolve(moduleDirectory, '../renderer/index.html'));
  const expectedURL = developmentURL ?? pathToFileURL(rendererFile).href;
  const principal = Object.freeze<Principal>({ id: options.principalId ?? 'local-owner', kind: 'local', capabilities: ['conversation', 'settings', 'tool.execute', 'file.read', 'file.write', 'file.delete', 'library.install', 'network', 'process.spawn'] });
  Object.freeze(principal.capabilities);
  const gateway = await options.gatewayFactory({ principal, userDataPath: app.getPath('userData') });
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
  const pending = new Set<Promise<CommandResult>>();
  ipcMain.handle(IPC.dispatch, async (event, value: unknown): Promise<CommandResult> => {
    if (!trusted(event)) throw new Error('Untrusted IPC sender');
    const fallbackId = typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string' ? value.id.slice(0, 256) : 'invalid';
    if (closed) return { ok: false, commandId: fallbackId, error: { code: 'DISCONNECTED', message: 'The desktop host is closed', retryable: true } };
    let command;
    try { command = parseCommand(value); } catch { return { ok: false, commandId: fallbackId, error: { code: 'INVALID_COMMAND', message: 'Command does not match contract v1' } }; }
    // Bound renderer-driven work without weakening gateway command deduplication.
    if (pending.size >= 64) return { ok: false, commandId: command.id, error: { code: 'BUSY', message: 'Too many pending commands', retryable: true } };
    const operation = Promise.resolve().then(() => gateway.dispatch(command, principal));
    pending.add(operation);
    try { return redactResult(await operation); }
    catch { return { ok: false, commandId: command.id, error: { code: 'BACKEND_ERROR', message: 'The backend could not complete this command', retryable: true } }; }
    finally { pending.delete(operation); }
  });
  let unsubscribe = () => {};
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    // Assign before destroy() can synchronously emit the closed event.
    closing = Promise.resolve().then(async () => {
      ipcMain.removeHandler(IPC.dispatch);
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
      if (safe && !closed && !window.isDestroyed() && trustedRendererURL(window.webContents.getURL(), expectedURL)) window.webContents.send(IPC.event, safe);
    }, principal);
    await window.loadURL(expectedURL);
  }
  catch (error) { await close(); throw error; }
  return { window, principal, close };
}
