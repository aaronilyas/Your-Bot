import { app } from 'electron';
import { join } from 'node:path';
import { createDesktopHost } from './host';
import { createApplicationGateway } from './backend';
import { installCliLauncher } from './cli-launcher';
// Windows ties notifications and taskbar grouping to the installer's shortcut AppUserModelID (= appId).
if (process.platform === 'win32') app.setAppUserModelId('dev.yourbot.desktop');
createDesktopHost({ gatewayFactory: createApplicationGateway, developmentURL: process.env.YOUR_BOT_RENDERER_URL })
  .then(async () => {
    if (!app.isPackaged || process.env.YOUR_BOT_NO_CLI === '1') return;
    try {
      await installCliLauncher({
        platform: process.platform,
        execPath: process.execPath,
        entry: join(process.resourcesPath, 'app.asar', 'dist', 'cli', 'your-bot.mjs'),
        dataDir: app.getPath('userData'),
        home: app.getPath('home'),
        ...(process.env.APPIMAGE ? { appImage: process.env.APPIMAGE } : {}),
        log: message => console.error(message),
      });
    } catch (error) {
      console.error('Could not install the your-bot command:', error instanceof Error ? error.message : error);
    }
  })
  .catch(() => { console.error('Desktop startup failed; check private state directory and runtime prerequisites'); app.exit(1); });
app.on('window-all-closed', () => app.quit());
