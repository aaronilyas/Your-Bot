import { contextBridge, ipcRenderer } from 'electron';
import type { AnyCommandResult, AnyDesktopCommand, DesktopEventV2 } from '@your-bot/contracts';
import { IPC, type ProvidersApi, type UpdateProgress, type UpdatesApi } from '../shared/ipc';
import { parseAppearance, type AppearancePrefs } from '../shared/appearance';
const id = (value: unknown): string => { if (typeof value !== 'string' || value.length === 0 || value.length > 64) throw new TypeError('An agent id is required'); return value; };
/** Provider detection: only catalog id strings cross the bridge; the host validates them again and runs fixed commands. */
const providers: ProvidersApi = Object.freeze({
  scan: () => ipcRenderer.invoke(IPC.providersScan),
  link: (targets: string[] | 'all') => {
    if (targets !== 'all' && (!Array.isArray(targets) || targets.length > 32)) throw new TypeError('Targets must be ids or "all"');
    return ipcRenderer.invoke(IPC.providersLink, targets === 'all' ? 'all' : targets.map(id));
  },
  update: (agent: string) => ipcRenderer.invoke(IPC.providersUpdate, id(agent)),
  login: (agent: string) => ipcRenderer.invoke(IPC.providersLogin, id(agent)),
});
const TAG = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,64})?$/;
const tag = (value: unknown): string => { if (typeof value !== 'string' || !TAG.test(value)) throw new TypeError('A release tag is required'); return value; };
const PHASES = new Set(['downloading', 'verifying', 'installing', 'restarting']);
/** In-app updates: only a release tag or a boolean crosses the bridge; the host picks the file, verifies it and installs it. */
const updates: UpdatesApi = Object.freeze({
  status: () => ipcRenderer.invoke(IPC.updatesStatus),
  check: (force?: boolean) => ipcRenderer.invoke(IPC.updatesCheck, force === true),
  install: (release: string) => ipcRenderer.invoke(IPC.updatesInstall, tag(release)),
  openRelease: (release?: string) => ipcRenderer.invoke(IPC.updatesOpenRelease, release === undefined ? undefined : tag(release)),
  setAutoCheck: (enabled: boolean) => { if (typeof enabled !== 'boolean') throw new TypeError('A boolean is required'); return ipcRenderer.invoke(IPC.updatesSetAutoCheck, enabled); },
  onProgress: (listener: (progress: UpdateProgress) => void) => {
    if (typeof listener !== 'function') throw new TypeError('A listener is required');
    const handler = (_event: unknown, value: UpdateProgress) => {
      if (!value || typeof value !== 'object' || typeof value.tag !== 'string' || !PHASES.has(value.phase)) return;
      listener({ tag: value.tag, phase: value.phase, ...(typeof value.received === 'number' ? { received: value.received } : {}), ...(typeof value.total === 'number' ? { total: value.total } : {}) });
    };
    ipcRenderer.on(IPC.updatesProgress, handler);
    return () => { ipcRenderer.removeListener(IPC.updatesProgress, handler); };
  },
});
/** Exactly seven members: dispatch, subscribe, a folder picker that returns a path string (or undefined if cancelled),
 * load/save of display preferences (validated on both sides), the frozen `providers` object (scan, link, update, login)
 * and the frozen `updates` object (status, check, install, openRelease, setAutoCheck, onProgress). */
const bridge = Object.freeze({
  dispatch: (command: AnyDesktopCommand): Promise<AnyCommandResult> => ipcRenderer.invoke(IPC.dispatch, command),
  subscribe: (listener: (event: DesktopEventV2) => void) => {
    if (typeof listener !== 'function') throw new TypeError('A listener is required');
    const handler = (_event: unknown, payload: DesktopEventV2) => listener(payload);
    ipcRenderer.on(IPC.event, handler);
    return () => { ipcRenderer.removeListener(IPC.event, handler); };
  },
  chooseDirectory: async (): Promise<string | undefined> => {
    const chosen: unknown = await ipcRenderer.invoke(IPC.chooseDirectory);
    return typeof chosen === 'string' && chosen.length > 0 && chosen.length <= 4096 ? chosen : undefined;
  },
  providers,
  updates,
  loadAppearance: async (): Promise<AppearancePrefs | undefined> => parseAppearance(await ipcRenderer.invoke(IPC.loadAppearance)),
  saveAppearance: async (prefs: AppearancePrefs): Promise<boolean> => {
    const valid = parseAppearance(prefs);
    return valid ? (await ipcRenderer.invoke(IPC.saveAppearance, valid)) === true : false;
  },
});
contextBridge.exposeInMainWorld('yourBot', bridge);
