import { contextBridge, ipcRenderer } from 'electron';
import type { AnyCommandResult, AnyDesktopCommand, DesktopEventV2 } from '@your-bot/contracts';
import { IPC } from '../shared/ipc';
import { parseAppearance, type AppearancePrefs } from '../shared/appearance';
/** Exactly five functions: dispatch, subscribe, a folder picker that returns a path string (or undefined if cancelled),
 * and load/save of display preferences (validated on both sides). */
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
  loadAppearance: async (): Promise<AppearancePrefs | undefined> => parseAppearance(await ipcRenderer.invoke(IPC.loadAppearance)),
  saveAppearance: async (prefs: AppearancePrefs): Promise<boolean> => {
    const valid = parseAppearance(prefs);
    return valid ? (await ipcRenderer.invoke(IPC.saveAppearance, valid)) === true : false;
  },
});
contextBridge.exposeInMainWorld('yourBot', bridge);
