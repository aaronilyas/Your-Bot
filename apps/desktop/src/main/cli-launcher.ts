import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** First line after the shebang (POSIX) or the `rem` line (Windows). A file without it is left alone. */
export const CLI_MARKER = 'Written by Your Bot: runs the desktop app\'s bundled your-bot CLI.';

export interface LauncherScriptInput {
  platform: NodeJS.Platform;
  /** Packaged Electron executable. Inside an AppImage this path is on the transient mount. */
  execPath: string;
  /** Bundled CLI, typically `<resources>/app.asar/dist/cli/your-bot.mjs`. */
  entry: string;
  /** Electron `userData`. The shim defaults `YOUR_BOT_DATA` to this directory. */
  dataDir: string;
  /** `process.env.APPIMAGE` when the running build is an AppImage. */
  appImage?: string;
}

export interface LauncherFs {
  readFile(file: string, encoding: 'utf8'): Promise<string>;
  writeFile(file: string, data: string, options?: { mode?: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(directory: string, options?: { recursive?: boolean }): Promise<void>;
  lstat(file: string): Promise<{ isSymbolicLink(): boolean; isFile(): boolean }>;
  readlink(file: string): Promise<string>;
  symlink(target: string, file: string): Promise<void>;
  unlink(file: string): Promise<void>;
  chmod(file: string, mode: number): Promise<void>;
}

export interface InstallCliLauncherOptions extends LauncherScriptInput {
  /** Directory that contains `.local/bin` on POSIX. Defaults to the current user's home. */
  home?: string;
  fs?: LauncherFs;
  log?(message: string): void;
  /** Windows user Path. When omitted, PowerShell updates HKCU\\Environment. */
  readUserPath?(): Promise<string>;
  writeUserPath?(value: string): Promise<void>;
}

const nodeFs: LauncherFs = {
  readFile: (file, encoding) => readFile(file, encoding),
  writeFile: (file, data, options) => writeFile(file, data, options),
  rename,
  mkdir: (directory, options) => mkdir(directory, options).then(() => undefined),
  lstat,
  readlink,
  symlink,
  unlink,
  chmod,
};

const codeOf = (error: unknown): string | undefined => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;

/** Single-quote a string for a POSIX shell. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function mountRelative(entry: string): string {
  const normalized = entry.replace(/\\/g, '/');
  const at = normalized.lastIndexOf('/resources/');
  return at >= 0 ? normalized.slice(at + 1) : normalized.replace(/^\/+/, '');
}

function posixScript(input: LauncherScriptInput): string {
  const app = shQuote(input.appImage || input.execPath);
  const data = shQuote(input.dataDir);
  const lines = [
    '#!/bin/sh',
    `# ${CLI_MARKER}`,
    `app=${app}`,
    'if [ ! -x "$app" ]; then',
    '  echo "Your Bot has moved or been removed. Open the app once to update this command." >&2',
    '  exit 127',
    'fi',
    'if [ $# -eq 0 ]; then',
    '  nohup "$app" >/dev/null 2>&1 &',
    '  exit 0',
    'fi',
    'if [ -z "${YOUR_BOT_DATA:-}" ]; then',
    `  export YOUR_BOT_DATA=${data}`,
    'else',
    '  export YOUR_BOT_DATA',
    'fi',
    'export ELECTRON_RUN_AS_NODE=1',
  ];
  if (input.appImage) {
    const binName = path.basename(input.execPath).replace(/[^A-Za-z0-9._-]/g, '');
    const relative = mountRelative(input.entry);
    lines.push(
      'unset APPIMAGE_EXTRACT_AND_RUN',
      'work=$(mktemp -d) || exit 1',
      'setsid "$app" --appimage-mount >"$work/mount" 2>/dev/null &',
      'mounter=$!',
      'trap \'kill "$mounter" 2>/dev/null; rm -rf "$work"\' EXIT',
      'trap \'exit 130\' INT TERM HUP',
      'mount=',
      'while kill -0 "$mounter" 2>/dev/null; do',
      '  mount=$(head -n 1 "$work/mount")',
      '  [ -d "$mount" ] && break',
      '  mount=',
      '  sleep 0.05',
      'done',
      'if [ -z "$mount" ]; then',
      '  (cd "$work" && "$app" --appimage-extract >/dev/null) || { echo "Could not open $app." >&2; exit 1; }',
      '  mount="$work/squashfs-root"',
      'fi',
      'export APPIMAGE="$app"',
      `"$mount/${binName || 'your-bot'}" "$mount/${relative}" "$@"`,
      'status=$?',
      'exit "$status"',
    );
  } else {
    lines.push(`exec "$app" ${shQuote(input.entry)} "$@"`);
  }
  return `${lines.join('\n')}\n`;
}

function cmdValue(value: string): string {
  return value.replace(/%/g, '%%');
}

function windowsScript(input: LauncherScriptInput): string {
  const exe = cmdValue(input.execPath);
  const entry = cmdValue(input.entry);
  const data = cmdValue(input.dataDir);
  return [
    '@echo off',
    'setlocal',
    `rem ${CLI_MARKER}`,
    `if "%~1"=="" (start "" "${exe}" & exit /b 0)`,
    'set "ELECTRON_RUN_AS_NODE=1"',
    `if not defined YOUR_BOT_DATA set "YOUR_BOT_DATA=${data}"`,
    `"${exe}" "${entry}" %*`,
    '',
  ].join('\r\n');
}

/** Shell shim that launches the app, or runs its bundled CLI under `ELECTRON_RUN_AS_NODE=1`. */
export function launcherScript(input: LauncherScriptInput): string {
  return input.platform === 'win32' ? windowsScript(input) : posixScript(input);
}

export function shimPath(dataDir: string, platform: NodeJS.Platform): string {
  return path.join(dataDir, 'bin', platform === 'win32' ? 'your-bot.cmd' : 'your-bot');
}

async function writeIfChanged(fs: LauncherFs, dest: string, script: string, mode: number | undefined, log: (message: string) => void): Promise<boolean> {
  try {
    const listed = await fs.lstat(dest);
    if (listed.isSymbolicLink() || !listed.isFile()) {
      log(`Left ${dest} alone; it was not written by Your Bot.`);
      return false;
    }
    const current = await fs.readFile(dest, 'utf8');
    if (!current.includes(CLI_MARKER)) {
      log(`Left ${dest} alone; it was not written by Your Bot.`);
      return false;
    }
    if (current === script) return true;
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error;
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const temporary = `${dest}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, script, mode !== undefined ? { mode } : undefined);
  if (mode !== undefined) await fs.chmod(temporary, mode);
  await fs.rename(temporary, dest);
  return true;
}

function pathKey(value: string): string {
  return value.trim().replace(/[\\/]+$/, '').toLowerCase();
}

async function ensureWindowsPath(dir: string, options: InstallCliLauncherOptions): Promise<void> {
  if (options.readUserPath && options.writeUserPath) {
    const current = await options.readUserPath();
    const parts = current.split(';').map(part => part.trim()).filter(Boolean);
    if (parts.some(part => pathKey(part) === pathKey(dir))) return;
    const trimmed = current.trim().replace(/;+$/, '');
    await options.writeUserPath(trimmed ? `${trimmed};${dir}` : dir);
    return;
  }
  const script = [
    "$dir = $env:YOUR_BOT_BIN",
    "$current = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "if ($null -eq $current) { $current = '' }",
    "$want = $dir.TrimEnd('\\')",
    "foreach ($part in ($current -split ';')) {",
    "  if ($part.Trim().TrimEnd('\\') -ieq $want) { exit 0 }",
    '}',
    "if ($current.Trim() -eq '') { $next = $dir } else { $next = $current.TrimEnd(';') + ';' + $dir }",
    "[Environment]::SetEnvironmentVariable('Path', $next, 'User')",
  ].join('\n');
  await new Promise<void>((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, YOUR_BOT_BIN: dir },
      windowsHide: true,
    }, error => { if (error) reject(error); else resolve(); });
  });
}

/**
 * Install `<userData>/bin/your-bot` and put it on PATH.
 * Never overwrites a file that lacks {@link CLI_MARKER}. A foreign `~/.local/bin/your-bot` is left in place.
 */
export async function installCliLauncher(options: InstallCliLauncherOptions): Promise<void> {
  const fs = options.fs ?? nodeFs;
  const log = options.log ?? (message => console.error(message));
  const platform = options.platform;
  const dest = shimPath(options.dataDir, platform);
  const script = launcherScript(options);
  const wrote = await writeIfChanged(fs, dest, script, platform === 'win32' ? undefined : 0o755, log);
  if (!wrote) return;
  if (platform === 'win32') {
    await ensureWindowsPath(path.dirname(dest), options);
    return;
  }
  const home = options.home ?? homedir();
  const binDir = path.join(home, '.local', 'bin');
  const link = path.join(binDir, 'your-bot');
  await fs.mkdir(binDir, { recursive: true });
  try {
    const listed = await fs.lstat(link);
    if (listed.isSymbolicLink()) {
      const target = await fs.readlink(link);
      if (path.resolve(binDir, target) === path.resolve(dest)) return;
      log(`Left ${link} alone; it points somewhere else.`);
      return;
    }
    let text = '';
    try { text = await fs.readFile(link, 'utf8'); } catch { /* unreadable: treat as foreign */ }
    if (!text.includes(CLI_MARKER)) {
      log(`Left ${link} alone; it is not Your Bot's command.`);
      return;
    }
    await fs.unlink(link);
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error;
  }
  await fs.symlink(dest, link);
}
