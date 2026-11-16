import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createMockTransport } from '../mock/transport';
import type { DesktopTransport } from './store';
import './styles.css';
declare global { interface Window { yourBot?: DesktopTransport; } }
const demo = !window.yourBot && new URLSearchParams(location.search).get('demo') === '1';
const disconnectedTransport: DesktopTransport = {
  async dispatch(command) { return { ok: false, commandId: command.id, error: { code: 'DISCONNECTED', message: 'Open the Electron app to connect your backend, or add ?demo=1 to explore the browser demonstration.', retryable: true } }; },
  subscribe() { return () => {}; },
};
const transport = window.yourBot ?? (demo ? createMockTransport() : disconnectedTransport);
createRoot(document.getElementById('root')!).render(<React.StrictMode><App transport={transport} demo={demo} /></React.StrictMode>);
