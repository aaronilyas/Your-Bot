import { contextBridge, ipcRenderer } from 'electron';
import type { AnyCommandResult, AnyDesktopCommand, DesktopEventV2 } from '@your-bot/contracts';
import { IPC, type ProvidersApi } from '../shared/ipc';
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
/** Exactly six members: dispatch, subscribe, a folder picker that returns a path string (or undefined if cancelled),
 * load/save of display preferences (validated on both sides), and the frozen `providers` object (scan, link, update, login). */
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
  loadAppearance: async (): Promise<AppearancePrefs | undefined> => parseAppearance(await ipcRenderer.invoke(IPC.loadAppearance)),
  saveAppearance: async (prefs: AppearancePrefs): Promise<boolean> => {
    const valid = parseAppearance(prefs);
    return valid ? (await ipcRenderer.invoke(IPC.saveAppearance, valid)) === true : false;
  },
});
contextBridge.exposeInMainWorld('yourBot', bridge);
