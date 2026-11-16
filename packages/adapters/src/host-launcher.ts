import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { AdapterError } from './errors.js';

/** Uncontained launch of an installed agent CLI. The process has the user's rights. */
export interface HostLaunchRequest {
  command: string;
  args: readonly string[];
  /** Absolute host directory. The agent cwd; not a sandbox path. */
  cwd: string;
  /** Environment variable names copied from the host, in addition to the minimal allowlist. */
  envPassthrough?: readonly string[];
  signal: AbortSignal;
}

export interface HostedAgent {
  process: ChildProcessWithoutNullStreams;
  /** Kill the agent and every descendant, then resolve. */
  terminate(): Promise<void>;
}

const EXACT_KEYS = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'TMP', 'TEMP', 'TMPDIR', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'LANG',
]);

/** Minimal environment: the plan allowlist plus the named passthrough variables. */
export function hostEnvironment(passthrough: readonly string[] = [], source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const pass = new Set(passthrough);
  const windows = process.platform === 'win32';
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || key.includes('\0') || key.includes('=') || value.includes('\0')) continue;
    const upper = key.toUpperCase();
    const listed = windows ? EXACT_KEYS.has(upper) : EXACT_KEYS.has(key);
    const prefixed = windows
      ? upper.startsWith('XDG_') || upper.startsWith('LC_')
      : key.startsWith('XDG_') || key.startsWith('LC_');
    const extra = windows ? [...pass].some(name => name.toUpperCase() === upper) : pass.has(key);
    if (listed || prefixed || extra) env[key] = value;
  }
  return env;
}

function isFile(candidate: string): boolean {
  try { return statSync(candidate).isFile(); } catch { return false; }
}

/**
 * Windows PATHEXT search. `command` may be a bare name or a path.
 * Current directory is searched before PATH, matching cmd.exe.
 */
export function resolveWindowsCommand(command: string, cwd: string, env: NodeJS.ProcessEnv, exists: (candidate: string) => boolean = isFile): string {
  const win = path.win32;
  const pathExt = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';').map(ext => ext.trim()).filter(Boolean)
    .map(ext => ext.startsWith('.') ? ext : `.${ext}`);
  const hasDir = win.isAbsolute(command) || command.includes('\\') || command.includes('/');
  const givenExt = win.extname(command);
  const extensions = givenExt
    ? ['', ...pathExt.filter(ext => ext.toLowerCase() !== givenExt.toLowerCase())]
    : pathExt;
  const base = hasDir ? win.basename(command) : command;
  const dirs = hasDir
    ? [win.dirname(command) || cwd]
    : [cwd, ...(env.Path || env.PATH || '').split(';').filter(Boolean)];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const ext of extensions) {
      const name = ext && !base.toLowerCase().endsWith(ext.toLowerCase()) ? base + ext : base;
      const candidate = win.normalize(win.join(dir, name));
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (exists(candidate)) return candidate;
    }
  }
  return command;
}

function assertQuotable(value: string, what: string): void {
  if (value.includes('\0') || value.includes('\r') || value.includes('\n')) {
    throw new AdapterError('INVALID_CONFIG', `${what} must not contain newlines or NUL.`);
  }
}

/** cmd.exe metacharacters and whitespace force quotes. `%` is neutralized separately. */
function batArgNeedsQuotes(arg: string): boolean {
  if (arg.length === 0 || arg.endsWith('\\')) return true;
  for (const ch of arg) {
    const cp = ch.codePointAt(0)!;
    if (cp < 128) {
      if (!/[A-Za-z0-9#$*+\-./:?@_\\]/.test(ch)) return true;
    } else if (cp < 32 || (cp >= 0x7f && cp <= 0x9f)) return true;
  }
  return false;
}

/**
 * Quote one argv element for `cmd.exe /d /s /c`.
 * Backslash and quote follow CommandLineToArgvW; `%` uses cmd's zero-length
 * substring so the variable is not expanded. The outer `/s` quotes are separate.
 */
export function quoteWindowsBatchArg(arg: string): string {
  assertQuotable(arg, 'Command arguments');
  const quote = batArgNeedsQuotes(arg);
  let out = quote ? '"' : '';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1;
      out += ch;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes) + '"';
    } else if (ch === '%') {
      out += '%%cd:~,';
    }
    backslashes = 0;
    out += ch;
  }
  if (quote) {
    out += '\\'.repeat(backslashes) + '"';
  }
  return out;
}

/** Inner command line (no surrounding `/s` quotes) for a `.cmd`/`.bat` shim. */
export function quoteWindowsBatchCommand(script: string, args: readonly string[]): string {
  assertQuotable(script, 'Windows batch command');
  if (script.includes('"') || script.includes('^') || script.includes('%') || script.endsWith('\\')) {
    throw new AdapterError('INVALID_CONFIG', 'Windows batch command cannot be quoted safely.');
  }
  return [`"${script}"`, ...args.map(arg => quoteWindowsBatchArg(arg))].join(' ');
}

export interface SpawnPlan {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

/** Direct spawn, or `cmd.exe /d /s /c` when the resolved file is a batch shim. */
export function planSpawn(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): SpawnPlan {
  for (const arg of args) {
    if (typeof arg !== 'string') throw new AdapterError('INVALID_CONFIG', 'ACP arguments must be strings.');
    assertQuotable(arg, 'Command arguments');
  }
  if (process.platform !== 'win32') return { file: command, args: [...args], windowsVerbatimArguments: false };
  const resolved = resolveWindowsCommand(command, cwd, env);
  const ext = path.win32.extname(resolved).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return { file: resolved, args: [...args], windowsVerbatimArguments: false };
  const comspec = env.ComSpec || path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  const inner = quoteWindowsBatchCommand(resolved, args);
  return { file: comspec, args: ['/d', '/s', '/c', `"${inner}"`], windowsVerbatimArguments: true };
}

function onceEvent(child: ChildProcess, event: 'spawn' | 'error' | 'exit'): Promise<void> {
  return new Promise(resolve => child.once(event, () => resolve()));
}

function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, ms);
    const onExit = () => { clearTimeout(timer); resolve(true); };
    child.once('exit', onExit);
  });
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return;
    try { process.kill(pid, signal); }
    catch (again) {
      if ((again as NodeJS.ErrnoException).code !== 'ESRCH') throw again;
    }
  }
}

async function killPosixTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  signalGroup(pid, 'SIGTERM');
  if (await waitExit(child, 500)) return;
  signalGroup(pid, 'SIGKILL');
  await waitExit(child, 500);
}

async function killWindowsTree(child: ChildProcess, env: NodeJS.ProcessEnv): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const taskkill = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
  const killer = spawn(taskkill, ['/T', '/F', '/PID', String(pid)], { shell: false, windowsHide: true, stdio: 'ignore' });
  killer.once('error', () => {});
  const killed = await waitExit(killer, 5000);
  const gone = await waitExit(child, 1000);
  if (!killed || (!gone && child.exitCode === null && child.signalCode === null)) {
    throw new AdapterError('HARNESS_EXIT', 'Host agent process tree did not terminate.', true);
  }
}

/** Spawns an installed agent CLI with no shell, outside containment. */
export class HostLauncher {
  async launch(request: HostLaunchRequest): Promise<HostedAgent> {
    if (request.signal.aborted) throw new AdapterError('CANCELLED', 'Agent task was cancelled.');
    if (!request.command) throw new AdapterError('INVALID_CONFIG', 'ACP command is missing.');
    const env = hostEnvironment(request.envPassthrough ?? []);
    const plan = planSpawn(request.command, request.args, request.cwd, env);
    const child = spawn(plan.file, plan.args, {
      cwd: request.cwd,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      detached: process.platform !== 'win32',
    });
    const started = new Promise<void>((resolve, reject) => {
      const onSpawn = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new AdapterError('HARNESS_IO', 'Host agent process failed to start.', true)); };
      const cleanup = () => { child.off('spawn', onSpawn); child.off('error', onError); };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
    let killing: Promise<void> | undefined;
    const kill = (): Promise<void> => {
      killing ??= (async () => {
        try {
          if (!child.pid && child.exitCode === null && child.signalCode === null) {
            await Promise.race([
              onceEvent(child, 'spawn'),
              onceEvent(child, 'error'),
              onceEvent(child, 'exit'),
            ]);
          }
          if (process.platform === 'win32') await killWindowsTree(child, env);
          else await killPosixTree(child);
        } catch (error) {
          if (error instanceof AdapterError) throw error;
          throw new AdapterError('HARNESS_EXIT', 'Host agent process tree did not terminate.', true);
        }
      })();
      return killing;
    };
    const onAbort = () => { void kill().catch(() => {}); };
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener('abort', onAbort, { once: true });
    try { await started; }
    catch (error) {
      request.signal.removeEventListener('abort', onAbort);
      if (request.signal.aborted) {
        await kill().catch(() => {});
        throw new AdapterError('CANCELLED', 'Agent task was cancelled.');
      }
      throw error;
    }
    if (request.signal.aborted) {
      await kill();
      throw new AdapterError('CANCELLED', 'Agent task was cancelled.');
    }
    return {
      process: child as ChildProcessWithoutNullStreams,
      async terminate() {
        request.signal.removeEventListener('abort', onAbort);
        await kill();
      },
    };
  }
}
