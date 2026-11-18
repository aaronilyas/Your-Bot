import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Apps started from a desktop launcher (Finder, a .desktop file, the Start menu) inherit a short PATH that
 * misses version managers and user installs, so agent CLIs found in a terminal look "not installed".
 * Like T3 Code, read the PATH the user's login shell builds and add the usual per-user install folders.
 */

const SHELL_TIMEOUT_MS = 5_000;
const MARK = '__YOUR_BOT_PATH__';

function delimiter(platform: NodeJS.Platform): string { return platform === 'win32' ? ';' : ':'; }

/** Per-user install folders that agent installers and version managers use, in priority order. */
export function wellKnownDirs(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string[] {
  if (platform === 'win32') {
    const appData = env.APPDATA ?? path.win32.join(home, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA ?? path.win32.join(home, 'AppData', 'Local');
    return [
      path.win32.join(home, '.local', 'bin'),
      path.win32.join(appData, 'npm'),
      path.win32.join(local, 'mise', 'shims'),
      path.win32.join(home, '.bun', 'bin'),
      path.win32.join(local, 'pnpm'),
      path.win32.join(local, 'Volta', 'bin'),
      path.win32.join(home, 'scoop', 'shims'),
      path.win32.join(local, 'Microsoft', 'WinGet', 'Links'),
      path.win32.join(local, 'Programs', 'cursor-agent'),
    ];
  }
  const dataHome = env.XDG_DATA_HOME ?? path.posix.join(home, '.local', 'share');
  return [
    path.posix.join(home, '.local', 'bin'),
    path.posix.join(dataHome, 'mise', 'shims'),
    path.posix.join(home, '.asdf', 'shims'),
    path.posix.join(home, '.bun', 'bin'),
    path.posix.join(home, '.volta', 'bin'),
    path.posix.join(home, '.npm-global', 'bin'),
    path.posix.join(dataHome, 'pnpm'),
    path.posix.join(home, 'Library', 'pnpm'),
    path.posix.join(home, '.cargo', 'bin'),
    path.posix.join(home, '.opencode', 'bin'),
    path.posix.join(home, '.grok', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
}

/** Ordered, de-duplicated PATH. Earlier entries win. */
export function mergePath(platform: NodeJS.Platform, ...parts: (string | undefined)[]): string {
  const sep = delimiter(platform);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    for (const entry of (part ?? '').split(sep)) {
      const trimmed = entry.trim();
      if (!trimmed || !(platform === 'win32' ? path.win32 : path.posix).isAbsolute(trimmed)) continue;
      const key = platform === 'win32' ? trimmed.toLowerCase() : trimmed;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out.join(sep);
}

/** PATH printed by `$SHELL -ilc`. Undefined on Windows, without a usable shell, or on timeout. */
export function loginShellPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  if (platform === 'win32') return Promise.resolve(undefined);
  const shell = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
  // Interactive login shells print banners and can prompt; markers isolate the value and stdin is closed.
  const script = `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`;
  return new Promise(resolve => {
    try {
      const child = execFile(shell, ['-ilc', script], {
        timeout: SHELL_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { ...env, TERM: 'dumb' }, windowsHide: true,
      }, (error, stdout) => {
        const match = new RegExp(`${MARK}(.*?)${MARK}`, 's').exec(String(stdout ?? ''));
        resolve(match?.[1] && !error ? match[1] : match?.[1] || undefined);
      });
      child.stdin?.end();
    } catch { resolve(undefined); }
  });
}

let hydrated: Promise<string> | undefined;

/**
 * The PATH used to find and launch agent CLIs: the login shell's PATH, then the current one, then the
 * well-known folders. Computed once per process.
 */
export function agentSearchPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string> {
  if (env !== process.env) return loginShellPath(env, platform).then(shell => mergePath(platform, shell, env.PATH ?? env.Path, wellKnownDirs(env, platform).join(delimiter(platform))));
  return hydrated ??= loginShellPath(env, platform).then(shell => mergePath(platform, shell, env.PATH ?? env.Path, wellKnownDirs(env, platform).join(delimiter(platform))));
}

/**
 * Put the agent search PATH into `process.env` so host-launched agents (and the `#!/usr/bin/env node`
 * scripts they start) resolve the same tools as in a terminal. Call once at startup of a GUI process.
 */
export async function hydrateProcessPath(): Promise<string> {
  const value = await agentSearchPath();
  if (process.platform === 'win32') {
    const key = Object.keys(process.env).find(name => name.toUpperCase() === 'PATH') ?? 'Path';
    process.env[key] = value;
  } else process.env.PATH = value;
  return value;
}

function executable(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (platform !== 'win32') accessSync(candidate, constants.X_OK);
    return true;
  } catch { return false; }
}

/** First executable named `name` on `searchPath` (PATHEXT-aware on Windows). */
export function which(name: string, searchPath: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const lib = platform === 'win32' ? path.win32 : path.posix;
  const exts = platform === 'win32'
    ? ['', ...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(ext => ext.toLowerCase())]
    : [''];
  for (const dir of searchPath.split(delimiter(platform))) {
    if (!dir) continue;
    for (const ext of exts) {
      if (platform === 'win32' && ext === '' && !lib.extname(name)) continue;
      const candidate = lib.join(dir, name + ext);
      if (executable(candidate, platform)) return candidate;
    }
  }
  return undefined;
}
