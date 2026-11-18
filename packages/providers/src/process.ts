import { spawn } from 'node:child_process';
import path from 'node:path';

export interface RunResult { stdout: string; stderr: string; code: number | null; timedOut: boolean; error?: string }

export interface RunOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  cwd?: string;
  /** Streams output lines as they arrive (updates can take minutes). */
  onOutput?(stream: 'stdout' | 'stderr', text: string): void;
  signal?: AbortSignal;
  maxBytes?: number;
}

/**
 * Probing a mise shim for a tool that is configured but not installed makes mise install it.
 * Detection must never install anything, so probes run with auto-install off.
 */
export function probeEnvironment(searchPath: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, MISE_AUTO_INSTALL: '0', MISE_NOT_FOUND_AUTO_INSTALL: '0', MISE_EXEC_AUTO_INSTALL: '0', NO_COLOR: '1', CI: '1' };
  if (process.platform === 'win32') {
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    env.Path = searchPath;
  } else env.PATH = searchPath;
  return env;
}

/** Windows `.cmd`/`.bat` shims (npm installs) cannot be spawned directly. */
function spawnPlan(command: string, args: readonly string[]): { file: string; args: string[]; shell: boolean } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(path.extname(command))) {
    if (args.some(arg => /["%^&|<>\r\n]/.test(arg)) || /["%^&|<>]/.test(command)) throw new Error('Arguments cannot be passed safely to a Windows batch file');
    return { file: `"${command}"`, args: args.map(arg => /\s/.test(arg) ? `"${arg}"` : arg), shell: true };
  }
  return { file: command, args: [...args], shell: false };
}

/** Runs a command with no shell (except Windows batch shims), a timeout and bounded output. */
export function run(command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  const max = options.maxBytes ?? 256 * 1024;
  return new Promise(resolve => {
    let stdout = ''; let stderr = ''; let timedOut = false; let settled = false;
    let plan: ReturnType<typeof spawnPlan>;
    try { plan = spawnPlan(command, args); }
    catch (error) { resolve({ stdout, stderr, code: null, timedOut, error: (error as Error).message }); return; }
    const child = spawn(plan.file, plan.args, {
      env: options.env, cwd: options.cwd, shell: plan.shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const kill = () => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs);
    const onAbort = () => kill();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (result: Omit<RunResult, 'stdout' | 'stderr' | 'timedOut'>) => {
      if (settled) return; settled = true;
      clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, timedOut, ...result });
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (stdout.length < max) stdout += chunk; options.onOutput?.('stdout', chunk); });
    child.stderr.on('data', (chunk: string) => { if (stderr.length < max) stderr += chunk; options.onOutput?.('stderr', chunk); });
    child.once('error', error => finish({ code: null, error: error.message }));
    child.once('close', code => finish({ code }));
  });
}

/** First `x.y.z` style version in the text. */
export function parseVersion(text: string): string | undefined {
  return /\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(text)?.[1] ?? /\b(\d{4}\.\d{1,2}\.\d{1,2}(?:-[0-9a-f]+)?)\b/.exec(text)?.[1];
}

/** Numeric comparison of dotted versions; prerelease suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) => value.split(/[-+]/)[0]!.split('.').map(part => Number.parseInt(part, 10) || 0);
  const left = parts(a); const right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}
