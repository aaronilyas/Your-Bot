import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { AuthorizationContext, Capability, FileScope, JsonValue, PermissionRequest, ToolExecutionContext, ToolExecutor, ToolInvocation, ToolResult } from '@your-bot/contracts';
import { canonicalSyntax, deletePinned, ExecutorError, pinFile, type BoundFile } from './files.js';
import { downloadWheels, validatePackages } from './packages.js';
import { PYTHON_WORKER } from './worker.js';

export interface ExecutorOptions {
  /** Dedicated application-owned directory, absolute/canonical, mode 0700. */
  environmentRoot: string;
  pythonPath?: string;
  bubblewrapPath?: string;
  timeoutMs?: number;
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
  memoryBytes?: number;
  scratchBytes?: number;
  fileBytes?: number;
}
export interface SandboxProbe { supported: boolean; pythonVersion?: string; error?: { code: string; message: string }; }
export const SKILL_IDS = ['calculation', 'data.analysis', 'structured.json', 'structured.csv', 'file.read', 'file.write', 'file.delete'] as const;
const DEFAULT_TIMEOUT = 10_000;
const MiB = 1024 * 1024;
const failure = (code: string, message: string): ToolResult => ({ ok: false, error: { code, message } });
function abortError(signal: AbortSignal): ExecutorError {
  return signal.reason?.name === 'TimeoutError' ? new ExecutorError('TIMEOUT', 'Execution exceeded wall time') : new ExecutorError('CANCELLED', 'Execution cancelled');
}
const aborted = (signal: AbortSignal): void => { if (signal.aborted) throw abortError(signal); };
function waitAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
function scopesEqual(a: FileScope[], b: FileScope[]): boolean {
  const key = (scope: FileScope) => scope.access + ':' + scope.path;
  return a.length === b.length && a.map(key).sort().every((s, i) => s === b.map(key).sort()[i]);
}
export function pythonApprovalReason(code: string): string {
  return 'Execute custom Python sha256:' + createHash('sha256').update(code).digest('hex') + '\n\n' + code;
}

export class PythonToolExecutor implements ToolExecutor {
  private readonly options: Required<ExecutorOptions>;
  private initialized?: Promise<void>;
  private python = '';
  private version = '';
  private sitePackages = '';
  private pipWheel = '';
  private runtimeMounts: string[] = [];
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly operations = new Map<string, Set<AbortController>>();
  private readonly children = new Set<ChildProcess>();
  private readonly probes = new Set<AbortController>();

  constructor(options: ExecutorOptions) {
    canonicalSyntax(options.environmentRoot);
    this.options = { pythonPath: '/usr/bin/python3', bubblewrapPath: '/usr/bin/bwrap',
      timeoutMs: DEFAULT_TIMEOUT, maxTimeoutMs: 30_000, maxOutputBytes: MiB,
      memoryBytes: 256 * MiB, scratchBytes: 32 * MiB, fileBytes: 16 * MiB, ...options };
    for (const [name, value] of Object.entries(this.options)) {
      if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) throw new Error('Invalid executor limit: ' + name);
    }
  }

  private runProcess(command: string, args: string[], input: string, signal: AbortSignal,
    timeout: number, context?: ToolExecutionContext, descriptors: number[] = []): Promise<{ output: string; stderr: string; protocol: string; code: number | null }> {
    aborted(signal);
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { detached: true, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        cwd: this.options.environmentRoot, stdio: ['pipe', 'pipe', 'pipe', ...descriptors] });
      this.children.add(child);
      let stdout = '', stderr = '', protocol = '', bytes = 0;
      let stopped: ExecutorError | undefined;
      const kill = (error: ExecutorError) => {
        stopped ??= error;
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      };
      const onAbort = () => kill(abortError(signal));
      const timer = setTimeout(() => kill(new ExecutorError('TIMEOUT', 'Execution exceeded wall time')), timeout);
      signal.addEventListener('abort', onAbort, { once: true });
      let pending = '';
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      const emit = (stream: 'stdout' | 'stderr', text: string) => {
        if (!text) return;
        try { context?.emit({ stream, text }); }
        catch { kill(new ExecutorError('OUTPUT_HANDLER_FAILED', 'Output handler failed')); }
      };
      const line = (value: string) => {
        if (value.startsWith('\x1eYOURBOT_RESULT ')) protocol += value.slice(16) + '\n';
        else { stdout += value + '\n'; emit('stdout', value + '\n'); }
      };
      const collect = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
        bytes += chunk.length;
        if (bytes > this.options.maxOutputBytes) { kill(new ExecutorError('OUTPUT_LIMIT', 'Execution output exceeded limit')); return; }
        if (stream === 'stderr') { const text = stderrDecoder.write(chunk); stderr += text; emit('stderr', text); }
        else {
          pending += stdoutDecoder.write(chunk);
          let end: number;
          while ((end = pending.indexOf('\n')) !== -1) { line(pending.slice(0, end)); pending = pending.slice(end + 1); }
        }
      };
      child.stdout!.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
      child.stderr!.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
      child.stdin!.on('error', () => {});
      child.stdin!.end(input);
      child.on('error', error => { stopped = new ExecutorError('SANDBOX_UNAVAILABLE', error.message); });
      child.on('close', code => {
        pending += stdoutDecoder.end();
        if (pending) { stdout += pending; emit('stdout', pending); }
        const tail = stderrDecoder.end(); stderr += tail; emit('stderr', tail);
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.children.delete(child);
        if (stopped) reject(stopped); else resolve({ output: stdout, stderr, protocol, code });
      });
      if (signal.aborted) onAbort();
    });
  }

  private async initialize(signal: AbortSignal): Promise<void> {
    if (process.platform !== 'linux' || process.arch !== 'x64') throw new ExecutorError('SANDBOX_UNAVAILABLE', 'Linux x86_64 with bubblewrap and seccomp is required');
    if (!this.initialized) {
      this.initialized = this.prepare(signal).then(async () => {
        const result = await this.checkSandbox(signal);
        if (!result.ok) throw new ExecutorError(result.error?.code ?? 'SANDBOX_UNAVAILABLE', result.error?.message ?? 'Sandbox probe failed');
      });
      this.initialized.catch(() => { this.initialized = undefined; });
    }
    await waitAbort(this.initialized, signal);
  }
  private async prepare(signal: AbortSignal): Promise<void> {
    await mkdir(this.options.environmentRoot, { recursive: true, mode: 0o700 });
    const root = await stat(this.options.environmentRoot);
    if (await realpath(this.options.environmentRoot) !== this.options.environmentRoot || (root.mode & 0o077) !== 0 || root.uid !== process.getuid!()) {
      throw new ExecutorError('ENVIRONMENT_UNSAFE', 'Application environment must be canonical, owned by this user, and mode 0700');
    }
    this.python = await realpath(this.options.pythonPath);
    if (!this.python.startsWith('/usr/')) throw new ExecutorError('SANDBOX_UNAVAILABLE', 'Python runtime must be located in readonly /usr');
    const detection = await this.runProcess(this.python, ['-I', '-S', '-c',
      "import sys,json,glob; wheels=glob.glob(sys.base_prefix+'/lib/python%d.%d/ensurepip/_bundled/pip-*.whl'%sys.version_info[:2])+glob.glob('/usr/share/python-wheels/pip-*.whl'); print(json.dumps({'version':list(sys.version_info[:3]), 'wheel':wheels[0] if wheels else None}))"], '', signal, 5000);
    if (detection.code !== 0) throw new ExecutorError('PYTHON_UNAVAILABLE', 'Python detection failed');
    const info = JSON.parse(detection.output) as { version: number[]; wheel: string | null };
    if (info.version[0] !== 3 || info.version[1] < 10) throw new ExecutorError('PYTHON_UNAVAILABLE', 'Python 3.10 or newer is required');
    this.version = info.version.join('.');
    this.pipWheel = info.wheel ? await realpath(info.wheel) : '';
    if (this.pipWheel && !this.pipWheel.startsWith('/usr/')) throw new ExecutorError('SANDBOX_UNAVAILABLE', 'Bundled pip must be in readonly /usr');
    this.sitePackages = `/venv/lib/python3.${info.version[1]}/site-packages`;
    this.runtimeMounts = ['--ro-bind', '/usr', '/usr'];
    for (const directory of ['/lib', '/lib64']) {
      try { await stat(directory); this.runtimeMounts.push('--ro-bind', directory, directory); } catch { /* absent on some Linux layouts */ }
    }
    const venv = path.join(this.options.environmentRoot, 'venv');
    try {
      const existing = await stat(venv);
      if (!existing.isDirectory() || await realpath(venv) !== venv || existing.uid !== process.getuid!() || (existing.mode & 0o077) !== 0) throw new Error('unsafe venv');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ExecutorError('ENVIRONMENT_UNSAFE', 'Managed venv is unsafe');
      const creation = await this.runProcess(this.python, ['-I', '-S', '-m', 'venv', '--without-pip', venv], '', signal, 30_000);
      if (creation.code !== 0) { await rm(venv, { recursive: true, force: true }); throw new ExecutorError('PYTHON_UNAVAILABLE', 'Could not create application venv'); }
      await chmod(venv, 0o700);
    }
    // Worker never executes a managed venv binary; approved wheels may alter it.
  }

  private async worker(config: Record<string, unknown>, files: BoundFile[], signal: AbortSignal,
    timeout: number, context?: ToolExecutionContext, wheelDirectory?: string): Promise<ToolResult> {
    const args = ['--unshare-all', '--die-with-parent', '--cap-drop', 'ALL', '--clearenv',
      ...this.runtimeMounts, '--dir', '/files', '--dir', '/dev',
      '--ro-bind', '/dev/null', '/dev/null', '--ro-bind', '/dev/urandom', '/dev/urandom',
      '--proc', '/proc', '--remount-ro', '/proc',
      '--size', String(this.options.scratchBytes), '--tmpfs', '/scratch', '--symlink', '/scratch', '/tmp',
      '--chdir', '/scratch', '--setenv', 'HOME', '/nonexistent', '--setenv', 'LANG', 'C.UTF-8',
      '--setenv', 'TMPDIR', '/scratch', '--setenv', 'OPENBLAS_NUM_THREADS', '1'];
    args.push(wheelDirectory ? '--bind' : '--ro-bind', path.join(this.options.environmentRoot, 'venv'), '/venv');
    if (wheelDirectory) args.push('--ro-bind', wheelDirectory, '/wheels');
    const fileMap: Record<string, string> = {};
    files.forEach((file, i) => {
      const alias = '/files/' + i;
      args.push(file.scope.access === 'write' ? '--bind-fd' : '--ro-bind-fd', String(i + 3), alias);
      fileMap[file.scope.path] = alias;
    });
    // Always use the trusted system interpreter: wheels may replace venv/bin.
    args.push('--remount-ro', '/', this.python, '-I', '-S', '-u', '-c', PYTHON_WORKER);
    const input = JSON.stringify({ ...config, files: fileMap, sitePackages: this.sitePackages,
      limits: { memory: this.options.memoryBytes, file: this.options.fileBytes, cpu: Math.max(1, Math.ceil(timeout / 1000)) } });
    if (Buffer.byteLength(input) > MiB) throw new ExecutorError('INPUT_LIMIT', 'Execution input exceeds 1 MiB');
    const result = await this.runProcess(this.options.bubblewrapPath, args, input, signal, timeout, context, files.map(f => f.file.fd));
    const messages = result.protocol.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { ready?: boolean; value?: JsonValue; error?: { code: string; message: string } });
    if (!messages[0]?.ready) return { ok: false, error: messages[0]?.error ?? { code: 'SANDBOX_UNAVAILABLE', message: 'Bubblewrap/seccomp worker did not initialize: ' + result.stderr.slice(0, 2000) } };
    const final = messages[1];
    if (!final || result.code !== 0 || final.error) return { ok: false, error: final?.error ?? { code: 'EXECUTION_FAILED', message: 'Worker terminated without a result (possibly a resource limit)' } };
    return { ok: true, value: final.value ?? null };
  }

  private validateAuthorization(auth: AuthorizationContext): void {
    if (!auth.principal.id || !auth.sessionId || !auth.taskId || !auth.principal.capabilities.includes('tool.execute')) throw new ExecutorError('PERMISSION_DENIED', 'Principal lacks tool.execute');
    for (const grant of auth.grants) {
      if (grant.principalId !== auth.principal.id || grant.sessionId !== auth.sessionId || grant.taskId !== auth.taskId) throw new ExecutorError('INVALID_GRANT', 'Grant principal, session or task does not match');
      for (const scope of grant.paths ?? []) {
        canonicalSyntax(scope.path);
        if (!['read', 'write', 'delete'].includes(scope.access) || grant.capability !== 'file.' + scope.access) throw new ExecutorError('INVALID_GRANT', 'Grant path access must match its capability');
      }
    }
  }
  private async authorize(context: ToolExecutionContext, signal: AbortSignal,
    request: Omit<PermissionRequest, 'id' | 'principalId' | 'sessionId' | 'taskId'>): Promise<void> {
    const auth = context.authorization;
    if (!auth.principal.capabilities.includes(request.capability)) throw new ExecutorError('PERMISSION_DENIED', 'Principal lacks ' + request.capability);
    const matches = (grantId?: string) => auth.grants.some(grant => (!grantId || grant.id === grantId) && grant.capability === request.capability &&
      grant.principalId === auth.principal.id && grant.sessionId === auth.sessionId && grant.taskId === auth.taskId &&
      (!request.paths || scopesEqual(grant.paths ?? [], request.paths)) &&
      (!request.packages || JSON.stringify([...(grant.packages ?? [])].sort()) === JSON.stringify([...request.packages].sort())) &&
      (request.capability !== 'tool.execute' || grant.reason === request.reason));
    if (!matches()) {
      const decision = await waitAbort(context.requestPermission(structuredClone(request)), signal);
      aborted(signal);
      this.validateAuthorization(auth);
      if (decision.outcome !== 'allow' || !matches(decision.requestId)) throw new ExecutorError('PERMISSION_DENIED', 'Approval must produce an exact core-issued grant');
    }
  }

  execute(invocation: ToolInvocation, context: ToolExecutionContext): Promise<ToolResult> {
    if (this.closed) return Promise.resolve(failure('EXECUTOR_CLOSED', 'Executor is closed'));
    // Caller-owned invocation objects must not change after approval.
    let snapshot: ToolInvocation;
    try {
      snapshot = structuredClone(invocation);
      if (Buffer.byteLength(JSON.stringify(snapshot)) > MiB) return Promise.resolve(failure('INPUT_LIMIT', 'Invocation exceeds 1 MiB'));
    } catch { return Promise.resolve(failure('INVALID_INVOCATION', 'Invocation must be JSON serializable')); }
    const controller = new AbortController();
    const taskId = context.authorization.taskId;
    const operations = this.operations.get(taskId) ?? new Set<AbortController>();
    operations.add(controller); this.operations.set(taskId, operations);
    const onAbort = () => controller.abort();
    context.signal.addEventListener('abort', onAbort, { once: true });
    if (context.signal.aborted) controller.abort();
    const work = this.queue.then(async () => {
      try { return await this.executeInternal(snapshot, context, controller.signal); }
      catch (error) { return error instanceof ExecutorError ? failure(error.code, error.message) : failure('EXECUTION_FAILED', (error as Error).message); }
      finally {
        context.signal.removeEventListener('abort', onAbort);
        operations.delete(controller);
        if (!operations.size) this.operations.delete(taskId);
      }
    });
    this.queue = work;
    return work;
  }

  private async executeInternal(invocation: ToolInvocation, context: ToolExecutionContext, signal: AbortSignal): Promise<ToolResult> {
    aborted(signal);
    this.validateAuthorization(context.authorization);
    if (!invocation.id || !['skill', 'python', 'library.install'].includes(invocation.kind)) throw new ExecutorError('INVALID_INVOCATION', 'Invalid tool invocation');
    const timeout = Math.min(invocation.timeoutMs ?? this.options.timeoutMs, this.options.maxTimeoutMs);
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new ExecutorError('INVALID_INVOCATION', 'Invalid timeout');
    const scopes = invocation.paths ?? [];
    if (scopes.length > 32) throw new ExecutorError('INVALID_PATH', 'At most 32 exact files may be bound');
    const keys = new Set<string>();
    for (const scope of scopes) {
      canonicalSyntax(scope.path);
      if (!['read', 'write', 'delete'].includes(scope.access) || keys.has(scope.access + ':' + scope.path)) throw new ExecutorError('INVALID_PATH', 'Invalid or duplicate file access');
      keys.add(scope.access + ':' + scope.path);
      if (scope.access !== 'read' && ['/usr', '/lib', '/lib64', '/bin', '/sbin'].some(prefix => scope.path === prefix || scope.path.startsWith(prefix + '/'))) throw new ExecutorError('INVALID_PATH', 'Trusted runtime files cannot be write/delete bindings');
      if (scope.path === this.options.environmentRoot || scope.path.startsWith(this.options.environmentRoot + '/')) throw new ExecutorError('INVALID_PATH', 'Managed environment cannot be a user-file binding');
    }
    if (invocation.kind === 'python') {
      if (typeof invocation.code !== 'string' || !invocation.code.trim()) throw new ExecutorError('INVALID_INVOCATION', 'Python code is required');
      await this.authorize(context, signal, { capability: 'tool.execute', reason: pythonApprovalReason(invocation.code) });
    }
    if (invocation.kind === 'skill' && !SKILL_IDS.includes(invocation.skillId as typeof SKILL_IDS[number])) throw new ExecutorError('UNKNOWN_SKILL', 'Unknown predefined skill');
    if (invocation.kind === 'library.install') {
      if (scopes.length) throw new ExecutorError('INVALID_INVOCATION', 'Package installation cannot bind user files');
      validatePackages(invocation.packages);
      await this.authorize(context, signal, { capability: 'library.install', packages: invocation.packages,
        reason: 'Install only these PyPI wheels into the application venv; dependencies are not automatic. Packages are untrusted code when imported.' });
      await this.initialize(signal);
      if (!this.pipWheel && !invocation.packages.includes('pip==25.3')) {
        await this.authorize(context, signal, { capability: 'library.install', packages: ['pip==25.3'],
          reason: 'Approve pinned pip==25.3 as the offline sandbox installer; this Python distribution has no bundled pip.' });
      }
      const staging = await mkdtemp(path.join(this.options.environmentRoot, 'wheels-'));
      const installSignal = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
      try {
        const requested = [...invocation.packages];
        if (!this.pipWheel && !requested.includes('pip==25.3')) requested.push('pip==25.3');
        const downloaded = await downloadWheels(requested, staging, installSignal);
        const wheels = downloaded.slice(0, invocation.packages.length);
        const installer = this.pipWheel || downloaded[requested.indexOf('pip==25.3')];
        aborted(signal);
        return await this.worker({ mode: 'install', packages: invocation.packages, wheels, pipWheel: installer }, [], installSignal, timeout, context, staging);
      } catch (error) {
        if (installSignal.aborted) throw abortError(installSignal);
        throw error;
      } finally { await rm(staging, { recursive: true, force: true }); }
    }
    for (const scope of scopes) {
      await this.authorize(context, signal, { capability: ('file.' + scope.access) as Capability, paths: [scope], reason: scope.access + ' exact file ' + scope.path });
      // A writable mount also permits reads; never silently broaden a write grant.
      if (scope.access === 'write') await this.authorize(context, signal, { capability: 'file.read', paths: [{ ...scope, access: 'read' }], reason: 'Read access implied by writable file binding ' + scope.path });
    }
    if (scopes.some(scope => scope.access === 'delete') && (invocation.kind !== 'skill' || invocation.skillId !== 'file.delete')) throw new ExecutorError('INVALID_INVOCATION', 'Deletion is only supported by file.delete');
    const input = invocation.input;
    if (invocation.kind === 'skill' && (typeof input !== 'object' || input === null || Array.isArray(input))) throw new ExecutorError('INVALID_INVOCATION', 'Skill input must be an object');
    const object = input as Record<string, JsonValue>;
    const access = invocation.skillId === 'file.write' ? 'write' : invocation.skillId === 'file.delete' ? 'delete' : 'read';
    if (invocation.kind === 'skill' && (invocation.skillId?.startsWith('file.') || (object.path !== undefined))) {
      if (typeof object.path !== 'string' || !scopes.some(scope => scope.path === object.path && scope.access === access)) throw new ExecutorError('PERMISSION_DENIED', 'Skill path needs its exact declared access');
    }
    await this.initialize(signal);
    const bound: BoundFile[] = [];
    try {
      for (const scope of scopes) {
        if (bound.some(file => file.scope.path === scope.path)) continue;
        const effective = scopes.find(other => other.path === scope.path && other.access === 'write') ?? scope;
        bound.push(await pinFile(effective, this.options.fileBytes));
      }
      aborted(signal);
      if (invocation.skillId === 'file.delete') {
        // Still require a successful OS sandbox probe before this trusted broker.
        const probe = await this.worker({ mode: 'python', code: 'result = True', input: null }, [], signal, timeout);
        if (!probe.ok) return probe;
        const file = bound.find(file => file.scope.path === object.path)!;
        if (file.scope.access !== 'delete') throw new ExecutorError('INVALID_INVOCATION', 'Deletion requires a delete-only binding');
        aborted(signal); await deletePinned(file);
        return { ok: true, value: { deleted: object.path } };
      }
      return await this.worker({ mode: invocation.kind, code: invocation.code, skill: invocation.skillId, input }, bound, signal, timeout, context);
    } finally { await Promise.all(bound.map(file => file.close())); }
  }

  private async checkSandbox(signal: AbortSignal): Promise<ToolResult> {
    return this.worker({ mode: 'python', input: null, code: String.raw`
import ctypes, errno, socket
libc = ctypes.CDLL(None, use_errno=True)
for nr in [41, 56, 57, 58, 59, 322, 435, 0x40000000 | 56]:
    ctypes.set_errno(0)
    if libc.syscall(nr, 0, 0, 0, 0, 0, 0) != -1 or ctypes.get_errno() != errno.EPERM:
        raise RuntimeError('Required syscall denial missing: ' + str(nr))
try:
    open('/usr/your-bot-probe', 'w')
    raise RuntimeError('Readonly runtime missing')
except OSError:
    pass
result = True
` }, [], signal, 5000);
  }

  probe(): Promise<SandboxProbe> {
    if (this.closed) return Promise.resolve({ supported: false, error: { code: 'EXECUTOR_CLOSED', message: 'Executor is closed' } });
    const controller = new AbortController();
    this.probes.add(controller);
    const work = this.queue.then(async (): Promise<SandboxProbe> => {
      try {
        await this.initialize(controller.signal);
        const result = await this.checkSandbox(controller.signal);
        return result.ok ? { supported: true, pythonVersion: this.version } : { supported: false, pythonVersion: this.version, error: result.error };
      } catch (error) {
        return { supported: false, error: { code: error instanceof ExecutorError ? error.code : 'SANDBOX_UNAVAILABLE', message: (error as Error).message } };
      } finally { this.probes.delete(controller); }
    });
    this.queue = work;
    return work;
  }
  async cancel(taskId: string): Promise<void> {
    for (const controller of this.operations.get(taskId) ?? []) controller.abort();
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.probes) controller.abort();
    for (const controllers of this.operations.values()) for (const controller of controllers) controller.abort();
    for (const child of this.children) if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    await this.queue;
  }
}

export function createToolExecutor(options: ExecutorOptions): PythonToolExecutor { return new PythonToolExecutor(options); }
export async function probeSandbox(options: ExecutorOptions): Promise<SandboxProbe> {
  const executor = createToolExecutor(options);
  try { return await executor.probe(); } finally { await executor.close(); }
}
