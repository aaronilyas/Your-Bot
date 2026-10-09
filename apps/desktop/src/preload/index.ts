import { contextBridge, ipcRenderer } from 'electron';
import type { BackendTransport, DesktopEvent } from '@your-bot/contracts';
import { IPC } from '../shared/ipc';
const transport: BackendTransport = Object.freeze({
  dispatch: (command: Parameters<BackendTransport['dispatch']>[0]) => ipcRenderer.invoke(IPC.dispatch, command),
  subscribe: (listener: (event: DesktopEvent) => void) => {
    if (typeof listener !== 'function') throw new TypeError('A listener is required');
    const handler = (_event: unknown, payload: DesktopEvent) => listener(payload);
    ipcRenderer.on(IPC.event, handler);
    return () => { ipcRenderer.removeListener(IPC.event, handler); };
  },
});
contextBridge.exposeInMainWorld('yourBot', transport);
