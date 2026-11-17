import { app } from 'electron';
import { createDesktopHost } from './host';
import { createApplicationGateway } from './backend';
// Windows ties notifications and taskbar grouping to the installer's shortcut AppUserModelID (= appId).
if (process.platform === 'win32') app.setAppUserModelId('dev.yourbot.desktop');
createDesktopHost({ gatewayFactory: createApplicationGateway, developmentURL: process.env.YOUR_BOT_RENDERER_URL }).catch(() => { console.error('Desktop startup failed; check private state directory and runtime prerequisites'); app.exit(1); });
app.on('window-all-closed', () => app.quit());
