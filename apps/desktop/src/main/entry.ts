import { app } from 'electron';
import { createDesktopHost } from './host';
import { createApplicationGateway } from './backend';
createDesktopHost({ gatewayFactory: createApplicationGateway, developmentURL: process.env.YOUR_BOT_RENDERER_URL }).catch(() => { console.error('Desktop startup failed; check private state directory and runtime prerequisites'); app.exit(1); });
app.on('window-all-closed', () => app.quit());
