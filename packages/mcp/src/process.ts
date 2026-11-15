import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** Environment variables inherited by stdio upstreams (everything else must be configured explicitly). */
const POSIX_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'PLAYWRIGHT_BROWSERS_PATH'
];
const WINDOWS_ENV_ALLOWLIST = [
  'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
  'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERNAME', 'USERPROFILE', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PROGRAMDATA', 'WINDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
  'PLAYWRIGHT_BROWSERS_PATH'
];

export function buildChildEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> | undefined, platform: NodeJS.Platform): Record<string, string> {
  const allow = platform === 'win32' ? WINDOWS_ENV_ALLOWLIST : POSIX_ENV_ALLOWLIST;
  const allowed = new Set(allow.map(name => (platform === 'win32' ? name.toUpperCase() : name)));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || value.startsWith('()')) continue;
    const normalized = platform === 'win32' ? key.toUpperCase() : key;
    if (allowed.has(normalized) || /^npm_config_/i.test(key)) env[key] = value;
  }
  return { ...env, ...(extra ?? {}) };
}

export interface SpawnPlan { command: string; args: string[]; windowsVerbatimArguments: boolean }

export interface PlanOptions {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv | Record<string, string>;
  /** Injectable for tests. */
  isFile?: (candidate: string) => boolean;
}

const defaultIsFile = (candidate: string): boolean => {
  try { return existsSync(candidate) && statSync(candidate).isFile(); } catch { return false; }
};

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const key = Object.keys(env).find(candidate => candidate.toUpperCase() === name);
  return key ? env[key] : undefined;
}

function quoteForCmd(value: string): string {
  if (/["%\r\n\0]/.test(value)) throw new Error(`Argument not supported for Windows .cmd/.bat launchers: contains one of " % CR LF NUL`);
  return `"${value}"`;
}

/**
 * Decides what to hand to spawn() (never with a shell). On Windows resolves PATH + PATHEXT, runs
 * `.exe/.com` directly and wraps `.cmd/.bat` through `cmd.exe /d /s /c "..."` with strict quoting.
 */
export function planSpawn(command: string, args: string[], options: PlanOptions): SpawnPlan {
  if (!command || /[\0\r\n]/.test(command)) throw new Error('Invalid command');
  if (options.platform !== 'win32') return { command, args, windowsVerbatimArguments: false };
  const isFile = options.isFile ?? defaultIsFile;
  const env = options.env as Record<string, string | undefined>;
  const exts = (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(ext => ext.toLowerCase());
  const hasDir = /[\\/]/.test(command) || path.win32.isAbsolute(command);
  const dirs = hasDir ? [''] : (envValue(env, 'PATH') ?? '').split(';').filter(Boolean);
  const currentExt = path.win32.extname(command).toLowerCase();
  const names = currentExt && exts.includes(currentExt) ? [command, ...exts.map(ext => command + ext)] : exts.map(ext => command + ext);
  let found: string | undefined;
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = dir ? path.win32.join(dir, name) : name;
      if (isFile(candidate)) { found = candidate; break; }
    }
    if (found) break;
  }
  if (!found) throw Object.assign(new Error(`Command not found: ${command}`), { code: 'ENOENT' });
  const ext = path.win32.extname(found).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { command: found, args, windowsVerbatimArguments: false };
  if (ext === '.cmd' || ext === '.bat') {
    const comspec = envValue(env, 'COMSPEC') ?? 'cmd.exe';
    return { command: comspec, args: ['/d', '/s', '/c', `"${[found, ...args].map(quoteForCmd).join(' ')}"`], windowsVerbatimArguments: true };
  }
  throw new Error(`Unsupported executable type: ${ext}`);
}

export interface StdioOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  killGraceMs?: number;
}

const STDERR_TAIL_BYTES = 4096;

/**
 * Stdio client transport that owns its child so the whole process tree can be killed
 * (posix: process group; Windows: taskkill /T /F). Environment is allowlisted.
 */
export class StdioProcessTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcess;
  private readonly buffer = new ReadBuffer();
  private stderrTail = '';
  private exited?: Promise<void>;
  private closing?: Promise<void>;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: StdioOptions) {
    this.platform = options.platform ?? process.platform;
  }

  get pid(): number | undefined { return this.child?.pid; }
  get stderr(): string { return this.stderrTail; }

  async start(): Promise<void> {
    if (this.child) throw new Error('Transport already started');
    const env = buildChildEnv(this.options.baseEnv ?? process.env, this.options.env, this.platform);
    const plan = planSpawn(this.options.command, this.options.args ?? [], { platform: this.platform, env });
    const child = spawn(plan.command, plan.args, {
      env,
      cwd: this.options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: this.platform !== 'win32',
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments
    });
    this.child = child;
    this.exited = new Promise<void>(resolve => child.once('close', () => resolve()));
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => { child.off('error', reject); resolve(); });
    });
    child.on('error', error => this.onerror?.(error));
    child.stdin!.on('error', error => this.onerror?.(error));
    child.stdout!.on('data', (chunk: Buffer) => {
      this.buffer.append(chunk);
      try {
        for (let message = this.buffer.readMessage(); message; message = this.buffer.readMessage()) this.onmessage?.(message);
      } catch (error) { this.onerror?.(error instanceof Error ? error : new Error(String(error))); }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });
    child.once('close', () => { this.buffer.clear(); this.onclose?.(); });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) throw new Error('Upstream process is not running');
    await new Promise<void>((resolve, reject) => {
      stdin.write(serializeMessage(message), error => (error ? reject(error) : resolve()));
    });
  }

  close(): Promise<void> {
    this.closing ??= this.terminate();
    return this.closing;
  }

  private async terminate(): Promise<void> {
    const child = this.child;
    if (!child || child.pid === undefined) return;
    const pid = child.pid;
    const grace = this.options.killGraceMs ?? 2000;
    child.stdin?.end();
    if (this.platform === 'win32') {
      await taskkillTree(pid);
      await Promise.race([this.exited, delay(grace)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      return;
    }
    signalGroup(pid, 'SIGTERM');
    await Promise.race([this.exited, delay(grace)]);
    // Sweep the group even when the leader exited: grandchildren may linger.
    signalGroup(pid, 'SIGKILL');
    await Promise.race([this.exited, delay(grace)]);
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch { /* group gone */ }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms).unref(); });
}

function taskkillTree(pid: number): Promise<void> {
  return new Promise(resolve => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, shell: false });
    killer.once('error', () => resolve());
    killer.once('close', () => resolve());
  });
}
