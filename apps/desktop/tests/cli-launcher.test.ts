import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { CLI_MARKER, installCliLauncher, launcherScript, shQuote, shimPath, type LauncherFs } from '../src/main/cli-launcher';

const exec = promisify(execFile);

async function directory(): Promise<{ root: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), 'your-bot-cli-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function countingFs(writes: { n: number }): LauncherFs {
  return {
    readFile: (file, encoding) => readFile(file, encoding),
    writeFile: async (file, data, options) => { writes.n += 1; await writeFile(file, data, options); },
    rename,
    mkdir: async (dir, options) => { await mkdir(dir, options); },
    lstat,
    readlink,
    symlink,
    unlink: file => rm(file),
    chmod,
  };
}

describe('cli launcher', () => {
  it('quotes paths and builds a POSIX shim, an AppImage shim and a Windows shim', () => {
    expect(shQuote("/Users/o'brien/Your Bot")).toBe(`'/Users/o'\\''brien/Your Bot'`);
    const script = launcherScript({
      platform: 'linux',
      execPath: "/opt/Your Bot/your-bot",
      entry: '/opt/Your Bot/resources/app.asar/dist/cli/your-bot.mjs',
      dataDir: "/home/o'brien/.config/your-bot",
    });
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script.split('\n')[1]).toBe(`# ${CLI_MARKER}`);
    expect(script).toContain(`app='/opt/Your Bot/your-bot'`);
    expect(script).toContain(`export YOUR_BOT_DATA='/home/o'\\''brien/.config/your-bot'`);
    expect(script).toContain('export ELECTRON_RUN_AS_NODE=1');
    expect(script).toContain('Your Bot has moved or been removed. Open the app once to update this command.');
    expect(script).toContain(`exec "$app" '/opt/Your Bot/resources/app.asar/dist/cli/your-bot.mjs' "$@"`);

    const image = launcherScript({
      platform: 'linux',
      execPath: '/tmp/.mount_YourBot/your-bot',
      entry: '/tmp/.mount_YourBot/resources/app.asar/dist/cli/your-bot.mjs',
      dataDir: '/home/aaron/.config/your-bot',
      appImage: '/home/aaron/Applications/Your-Bot.AppImage',
    });
    expect(image).toContain('"$app" --appimage-mount');
    expect(image).toContain('--appimage-extract');
    expect(image).toContain('squashfs-root');
    expect(image).toContain('trap \'kill "$mounter" 2>/dev/null; rm -rf "$work"\' EXIT');
    expect(image).toContain('"$mount/your-bot" "$mount/resources/app.asar/dist/cli/your-bot.mjs" "$@"');

    const windows = launcherScript({
      platform: 'win32',
      execPath: 'C:\\Program Files\\Your Bot\\your-bot.exe',
      entry: 'C:\\Program Files\\Your Bot\\resources\\app.asar\\dist\\cli\\your-bot.mjs',
      dataDir: 'C:\\Users\\aaron\\AppData\\Roaming\\Your Bot',
    });
    expect(windows.split('\r\n').slice(0, 3)).toEqual(['@echo off', 'setlocal', `rem ${CLI_MARKER}`]);
    expect(windows).toContain('if "%~1"=="" (start "" "C:\\Program Files\\Your Bot\\your-bot.exe" & exit /b 0)');
    expect(windows).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(windows).toContain('if not defined YOUR_BOT_DATA set "YOUR_BOT_DATA=C:\\Users\\aaron\\AppData\\Roaming\\Your Bot"');
    expect(windows).toContain('"C:\\Program Files\\Your Bot\\your-bot.exe" "C:\\Program Files\\Your Bot\\resources\\app.asar\\dist\\cli\\your-bot.mjs" %*');
  });

  it('installs the shim once, refuses a foreign file, and refuses a foreign PATH entry', async () => {
    const dir = await directory();
    try {
      const home = path.join(dir.root, 'home');
      const data = path.join(dir.root, 'data');
      const input = { platform: 'linux' as const, execPath: '/opt/your-bot', entry: '/opt/resources/app.asar/dist/cli/your-bot.mjs', dataDir: data, home };
      const writes = { n: 0 };
      await installCliLauncher({ ...input, fs: countingFs(writes) });
      const shim = shimPath(data, 'linux');
      const link = path.join(home, '.local', 'bin', 'your-bot');
      expect(await readFile(shim, 'utf8')).toContain(CLI_MARKER);
      expect((await stat(shim)).mode & 0o777).toBe(0o755);
      expect(await readlink(link)).toBe(shim);
      const written = writes.n;
      await installCliLauncher({ ...input, fs: countingFs(writes) });
      expect(writes.n).toBe(written);

      const foreign = await directory();
      try {
        const foreignData = path.join(foreign.root, 'data');
        const foreignHome = path.join(foreign.root, 'home');
        const dest = shimPath(foreignData, 'linux');
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, '#!/bin/sh\necho someone else\n');
        const notes: string[] = [];
        await installCliLauncher({ ...input, dataDir: foreignData, home: foreignHome, log: message => notes.push(message) });
        expect(await readFile(dest, 'utf8')).toBe('#!/bin/sh\necho someone else\n');
        expect(notes.some(message => message.includes('Left') && message.includes(dest))).toBe(true);
        await expect(lstat(path.join(foreignHome, '.local', 'bin', 'your-bot'))).rejects.toThrow();
      } finally { await foreign.cleanup(); }

      const taken = await directory();
      try {
        const takenHome = path.join(taken.root, 'home');
        const takenData = path.join(taken.root, 'data');
        const linkPath = path.join(takenHome, '.local', 'bin', 'your-bot');
        await mkdir(path.dirname(linkPath), { recursive: true });
        await writeFile(linkPath, '#!/bin/sh\necho other command\n');
        const notes: string[] = [];
        await installCliLauncher({ ...input, dataDir: takenData, home: takenHome, log: message => notes.push(message) });
        expect(await readFile(linkPath, 'utf8')).toBe('#!/bin/sh\necho other command\n');
        expect(notes.some(message => message.includes('Left') && message.includes(linkPath))).toBe(true);
        expect(await readFile(shimPath(takenData, 'linux'), 'utf8')).toContain(CLI_MARKER);
      } finally { await taken.cleanup(); }
    } finally { await dir.cleanup(); }
  });

  it('runs the generated shim for a missing app and for a CLI invocation', async () => {
    const dir = await directory();
    try {
      const missing = path.join(dir.root, 'missing.sh');
      await writeFile(missing, launcherScript({ platform: 'linux', execPath: path.join(dir.root, 'gone'), entry: path.join(dir.root, 'cli.mjs'), dataDir: path.join(dir.root, 'data') }));
      await chmod(missing, 0o755);
      const failed = await exec(missing, [], { env: {} }).then(() => ({ code: 0, stderr: '' }), (error: { code?: number; stderr?: string }) => ({ code: error.code ?? 1, stderr: String(error.stderr ?? '') }));
      expect(failed.code).toBe(127);
      expect(failed.stderr).toContain('Your Bot has moved or been removed.');

      const record = path.join(dir.root, 'record.txt');
      const app = path.join(dir.root, 'your-bot');
      await writeFile(app, `#!/bin/sh\nprintf '%s\\n' "$ELECTRON_RUN_AS_NODE" "$YOUR_BOT_DATA" "$@" > ${shQuote(record)}\n`);
      await chmod(app, 0o755);
      const entry = path.join(dir.root, 'resources', 'app.asar', 'dist', 'cli', 'your-bot.mjs');
      const data = path.join(dir.root, 'user-data');
      const shim = path.join(dir.root, 'shim.sh');
      await writeFile(shim, launcherScript({ platform: 'linux', execPath: app, entry, dataDir: data }));
      await chmod(shim, 0o755);
      await exec(shim, ['providers', 'list']);
      expect((await readFile(record, 'utf8')).trim().split('\n')).toEqual(['1', data, entry, 'providers', 'list']);
    } finally { await dir.cleanup(); }
  });
});
