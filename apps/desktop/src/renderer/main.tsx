import React from 'react';
import { createRoot } from 'react-dom/client';
import type { BackendTransport } from '@your-bot/contracts';
import { App } from './App';
import { createMockTransport } from '../mock/transport';
import './styles.css';
declare global { interface Window { yourBot?: BackendTransport; } }
const demo = !window.yourBot && new URLSearchParams(location.search).get('demo') === '1';
const disconnectedTransport: BackendTransport = {
  async dispatch(command) { return { ok: false, commandId: command.id, error: { code: 'DISCONNECTED', message: 'Open the Electron app to connect your backend, or add ?demo=1 to explore the browser demonstration.', retryable: true } }; },
  subscribe() { return () => {}; },
};
const transport = window.yourBot ?? (demo ? createMockTransport() : disconnectedTransport);
createRoot(document.getElementById('root')!).render(<React.StrictMode><App transport={transport} demo={demo} /></React.StrictMode>);
