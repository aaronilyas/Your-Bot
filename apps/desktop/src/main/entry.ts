import { app, net, shell } from 'electron';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { run } from '@your-bot/providers';
import { createDesktopHost } from './host';
import { createApplicationGateway } from './backend';
import { installCliLauncher } from './cli-launcher';
import { createUpdater } from './updater';
// Windows ties notifications and taskbar grouping to the installer's shortcut AppUserModelID (= appId).
if (process.platform === 'win32') app.setAppUserModelId('dev.yourbot.desktop');
// Updates come only from this project's GitHub releases; release pages open in the default browser, never in the app.
const updater = createUpdater({
  currentVersion: app.getVersion(), packaged: app.isPackaged, platform: process.platform, arch: process.arch,
  execPath: process.execPath, env: process.env, dataDir: app.getPath('userData'),
  fetch: (url, init) => net.fetch(url, init),
  run: (file, args, options) => run(file, args, { env: process.env, timeoutMs: options?.timeoutMs ?? 60_000 }),
  spawnDetached: (file, args) => new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  }),
  openExternal: url => shell.openExternal(url),
  relaunch: options => app.relaunch(options),
  quit: () => app.quit(),
});
createDesktopHost({ gatewayFactory: createApplicationGateway, developmentURL: process.env.YOUR_BOT_RENDERER_URL, updater })
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
