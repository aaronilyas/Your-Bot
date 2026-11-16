import { contextBridge, ipcRenderer } from 'electron';
import type { AnyCommandResult, AnyDesktopCommand, DesktopEventV2 } from '@your-bot/contracts';
import { IPC } from '../shared/ipc';
/** Exactly three functions: dispatch, subscribe and a folder picker that returns a path string (or undefined if cancelled). */
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
});
contextBridge.exposeInMainWorld('yourBot', bridge);
