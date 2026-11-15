import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as nodePath from 'node:path';
import type { HostTerminalCreateRequest, TaskId, TerminalExitStatus, TerminalOutput } from '@your-bot/contracts';
import { WorkspaceError, errnoOf, mapFsError, throwIfAborted } from './errors.js';
import { resolveCommand } from './command.js';
import { cmdExeArguments } from './winquote.js';
import { hostPolicy, resolveInRoot, samePath } from './paths.js';
import { OutputBuffer } from './output.js';

export const DEFAULT_OUTPUT_BYTE_LIMIT = 1024 * 1024;
export const MAX_OUTPUT_BYTE_LIMIT = 32 * 1024 * 1024;
export const MAX_RUNNING_TERMINALS_PER_TASK = 16;
export const MAX_TERMINAL_HANDLES_PER_TASK = 64;
const EXIT_DRAIN_MS = 250;
const KILL_WAIT_MS = 5000;

const ENV_EXACT = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'SystemRoot', 'ComSpec', 'PATHEXT'];
const ENV_PREFIXES = ['XDG_', 'LC_'];

/** Minimal allowlisted environment derived from `base`, then overlaid with the request's variables. */
export function buildEnvironment(base: NodeJS.ProcessEnv, request: { name: string; value: string }[] | undefined, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const win = platform === 'win32'; // Windows variable names are case-insensitive
  const norm = (name: string) => (win ? name.toUpperCase() : name);
  const exact = new Set(ENV_EXACT.map(norm));
  const prefixes = ENV_PREFIXES.map(norm);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const key = norm(name);
    if (exact.has(key) || prefixes.some(prefix => key.startsWith(prefix))) out[name] = value;
  }
  for (const entry of request ?? []) {
    if (typeof entry?.name !== 'string' || typeof entry.value !== 'string' || entry.name === '' || /[=\0]/.test(entry.name) || entry.value.includes('\0')) {
      throw new WorkspaceError('INVALID_REQUEST', 'invalid environment variable');
    }
    for (const existing of Object.keys(out)) if (norm(existing) === norm(entry.name)) delete out[existing];
    out[entry.name] = entry.value;
  }
  return out;
}

interface TerminalState {
  id: string;
  taskId: TaskId;
  child: ChildProcess;
  pid: number;
  buffer: OutputBuffer;
  exit?: TerminalExitStatus;
  exited: Promise<void>;
  killRequested: boolean;
  groupGone: boolean;
  detachAbort: () => void;
}

const liveStates = new Set<TerminalState>();
let exitHookInstalled = false;

function systemTool(name: string): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return nodePath.win32.join(root, 'System32', name);
}

/** Last-resort cleanup when the host process itself exits: nothing may outlive it. */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const state of liveStates) {
      try {
        if (process.platform === 'win32') {
          if (!state.exit) spawnSync(systemTool('taskkill.exe'), ['/pid', String(state.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } else if (!state.groupGone) process.kill(-state.pid, 'SIGKILL');
      } catch { /* already gone */ }
    }
  });
}

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

export interface TerminalManagerOptions {
  /** Environment the allowlist is taken from. Default: process.env. */
  baseEnv?: NodeJS.ProcessEnv;
}

export class TerminalManager {
  private readonly terminals = new Map<string, TerminalState>();
  private readonly byTask = new Map<TaskId, Set<string>>();
  private closed = false;
  private readonly baseEnv: NodeJS.ProcessEnv;

  constructor(options: TerminalManagerOptions = {}) {
    this.baseEnv = options.baseEnv ?? process.env;
  }

  async create(root: string, request: HostTerminalCreateRequest & { cwd: string }, options: { taskId: TaskId; signal: AbortSignal }): Promise<string> {
    if (this.closed) throw new WorkspaceError('INVALID_REQUEST', 'workspace host is closed');
    throwIfAborted(options.signal);
    if (typeof request?.command !== 'string' || request.command === '') throw new WorkspaceError('INVALID_REQUEST', 'command is required');
    const args = request.args ?? [];
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new WorkspaceError('INVALID_REQUEST', 'args must be strings without NUL');
    if (typeof options.taskId !== 'string' || options.taskId === '') throw new WorkspaceError('INVALID_REQUEST', 'taskId is required');
    let limit = DEFAULT_OUTPUT_BYTE_LIMIT;
    if (request.outputByteLimit !== undefined) {
      if (!Number.isSafeInteger(request.outputByteLimit) || request.outputByteLimit < 0) throw new WorkspaceError('INVALID_REQUEST', 'outputByteLimit must be a non-negative integer');
      limit = Math.min(request.outputByteLimit, MAX_OUTPUT_BYTE_LIMIT);
    }

    // cwd: re-verified against the root right now (canonical, inside, a directory).
    if (typeof request.cwd !== 'string' || !nodePath.isAbsolute(request.cwd)) throw new WorkspaceError('INVALID_REQUEST', 'cwd must be an absolute path');
    const cwd = await resolveInRoot(root, request.cwd);
    if (!samePath(hostPolicy, cwd, nodePath.resolve(request.cwd))) throw new WorkspaceError('INVALID_REQUEST', 'cwd is not canonical');
    try { if (!(await stat(cwd)).isDirectory()) throw new WorkspaceError('INVALID_REQUEST', 'cwd is not a directory'); } catch (error) { throw mapFsError(error, 'cwd'); }

    const env = buildEnvironment(this.baseEnv, request.env);
    const resolved = await resolveCommand(request.command, env, cwd);
    let file = resolved.file;
    let spawnArgs = args;
    if (resolved.batch) {
      file = systemTool('cmd.exe');
      spawnArgs = cmdExeArguments(resolved.file, args);
    }
    throwIfAborted(options.signal);
    if (this.closed) throw new WorkspaceError('INVALID_REQUEST', 'workspace host is closed');

    // Limits are checked and the slot taken with no await in between.
    const taskSet = this.byTask.get(options.taskId) ?? new Set<string>();
    let running = 0;
    for (const id of taskSet) if (!this.terminals.get(id)!.exit) running++;
    if (running >= MAX_RUNNING_TERMINALS_PER_TASK || taskSet.size >= MAX_TERMINAL_HANDLES_PER_TASK) {
      throw new WorkspaceError('LIMIT_EXCEEDED', `too many terminals for this task (max ${MAX_RUNNING_TERMINALS_PER_TASK} running, ${MAX_TERMINAL_HANDLES_PER_TASK} unreleased)`);
    }

    const win = process.platform === 'win32';
    const child = spawn(file, spawnArgs, {
      cwd, env, shell: false, detached: !win, windowsHide: true, windowsVerbatimArguments: resolved.batch,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const spawned = new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.on('error', () => undefined); // later errors surface through the exit status
    try { await spawned; } catch (error) {
      throw errnoOf(error) === 'ENOENT' ? new WorkspaceError('NOT_FOUND', `command not found: ${request.command}`) : mapFsError(error, 'spawn');
    }
    const pid = child.pid;
    if (pid === undefined) throw new WorkspaceError('IO_ERROR', 'spawn failed');

    const id = randomUUID();
    const buffer = new OutputBuffer(limit);
    let resolveExited!: () => void;
    const exited = new Promise<void>(resolve => { resolveExited = resolve; });
    const state: TerminalState = { id, taskId: options.taskId, child, pid, buffer, exited, killRequested: false, groupGone: false, detachAbort: () => undefined };
    this.terminals.set(id, state);
    taskSet.add(id);
    this.byTask.set(options.taskId, taskSet);
    liveStates.add(state);
    installExitHook();

    let open = 2;
    const streamsClosed = new Promise<void>(resolve => {
      const done = () => { if (--open === 0) resolve(); };
      child.stdout!.once('close', done);
      child.stderr!.once('close', done);
    });
    child.stdout!.on('data', (chunk: Buffer) => buffer.append(chunk));
    child.stderr!.on('data', (chunk: Buffer) => buffer.append(chunk));
    child.once('exit', (code, signal) => {
      void (async () => {
        // The pipes may stay open if a background child inherited them: do not wait forever.
        await Promise.race([streamsClosed, sleep(EXIT_DRAIN_MS)]);
        let status: TerminalExitStatus = { exitCode: code, signal };
        if (win && state.killRequested && signal === null) status = { exitCode: null, signal: 'SIGKILL' };
        state.exit = status;
        if (!win) { try { process.kill(-pid, 0); } catch { state.groupGone = true; } }
        resolveExited();
      })();
    });

    const onAbort = () => { void this.killState(state).catch(() => undefined); };
    options.signal.addEventListener('abort', onAbort, { once: true });
    state.detachAbort = () => options.signal.removeEventListener('abort', onAbort);
    if (options.signal.aborted) onAbort();
    return id;
  }

  private get(terminalId: string): TerminalState {
    const state = typeof terminalId === 'string' ? this.terminals.get(terminalId) : undefined;
    if (!state) throw new WorkspaceError('TERMINAL_NOT_FOUND', 'unknown terminal');
    return state;
  }

  output(terminalId: string): TerminalOutput {
    const state = this.get(terminalId);
    const { output, truncated } = state.buffer.snapshot(state.exit !== undefined);
    return state.exit ? { output, truncated, exitStatus: state.exit } : { output, truncated };
  }

  async waitForExit(terminalId: string, signal: AbortSignal): Promise<TerminalExitStatus> {
    const state = this.get(terminalId);
    throwIfAborted(signal);
    if (!state.exit) {
      let onAbort!: () => void;
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new WorkspaceError('ABORTED', 'wait aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try { await Promise.race([state.exited, aborted]); } finally { signal.removeEventListener('abort', onAbort); }
    }
    return state.exit!;
  }

  /** SIGKILL the whole group / `taskkill /T /F` the tree, then wait (bounded) for the exit to be observed. */
  private async killState(state: TerminalState): Promise<void> {
    if (process.platform === 'win32') {
      if (!state.exit) {
        state.killRequested = true;
        await new Promise<void>(resolve => {
          const tool = spawn(systemTool('taskkill.exe'), ['/pid', String(state.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          const timer = setTimeout(() => { tool.kill(); resolve(); }, 10_000);
          tool.once('error', () => { clearTimeout(timer); resolve(); });
          tool.once('close', () => { clearTimeout(timer); resolve(); });
        });
        if (!state.exit) { try { state.child.kill('SIGKILL'); } catch { /* gone */ } }
      }
    } else {
      if (!state.exit) state.killRequested = true;
      if (!state.groupGone) {
        try { process.kill(-state.pid, 'SIGKILL'); } catch (error) { if (errnoOf(error) === 'ESRCH') { if (state.exit) state.groupGone = true; } }
      }
      if (!state.exit) { try { state.child.kill('SIGKILL'); } catch { /* gone */ } }
    }
    await Promise.race([state.exited, sleep(KILL_WAIT_MS)]);
  }

  async kill(terminalId: string): Promise<void> {
    await this.killState(this.get(terminalId));
  }

  async release(terminalId: string): Promise<void> {
    const state = this.get(terminalId);
    this.terminals.delete(terminalId);
    const set = this.byTask.get(state.taskId);
    set?.delete(terminalId);
    if (set?.size === 0) this.byTask.delete(state.taskId);
    state.detachAbort();
    try { await this.killState(state); } finally {
      liveStates.delete(state);
      state.child.stdout?.destroy();
      state.child.stderr?.destroy();
      state.buffer.clear();
    }
  }

  async releaseTask(taskId: TaskId): Promise<void> {
    const ids = [...(this.byTask.get(taskId) ?? [])];
    await Promise.allSettled(ids.map(id => this.release(id)));
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.terminals.keys()].map(id => this.release(id)));
  }
}
