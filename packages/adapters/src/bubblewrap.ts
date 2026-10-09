import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, mkdtemp, open, realpath, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';
import type { ContainedHarness, ContainmentLauncher, HarnessLaunchRequest } from './containment.js';
import { AdapterError, positiveInteger } from './errors.js';
import { throwIfAborted } from './lifecycle.js';
import { LINUX_BOOTSTRAP_SOURCE } from './linux-bootstrap.js';

export interface BubblewrapContainmentOptions {
  /** One host-approved .mjs or .py file, snapshotted through a canonical open fd.
   * launch args must contain exactly this path; no runtime flags/env/shell accepted. */
  scriptPath: string;
  /** Combined /scratch and /tmp tmpfs capacity. Default 64 MiB. */
  scratchBytes?: number;
  /** Hard RLIMIT_AS, including virtual runtime reservations, NOT a physical RSS cap.
   * Default 8 GiB; Node also gets a fixed 256 MiB V8 old-space cap. */
  addressSpaceBytes?: number;
  /** Hard RLIMIT_FSIZE, default 16 MiB per file. */
  fileBytes?: number;
  /** Hard RLIMIT_CPU, default 30 CPU seconds (all runtime threads combined). */
  cpuSeconds?: number;
  /** Independent wall deadline and startup deadline, defaults 120 s / 10 s. */
  wallTimeMs?: number;
  startupTimeoutMs?: number;
}

function unavailable(): AdapterError {
  return new AdapterError('CONTAINMENT_UNAVAILABLE', 'Linux Bubblewrap containment could not be established.');
}

/** Root-administered distro components are trusted; user executables never are. */
async function trustedFile(path: string): Promise<string> {
  const canonical = await realpath(path);
  const info = await stat(canonical);
  if (!canonical.startsWith('/usr/') || !info.isFile() || info.uid !== 0 || (info.mode & 0o6022)) throw unavailable();
  return canonical;
}

async function dynamicRuntime(command: string): Promise<{ path: string; handle: FileHandle }> {
  if (command !== '/usr/bin/node' && command !== '/usr/bin/python3') throw unavailable();
  const path = await trustedFile(command);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (info.uid !== 0 || (info.mode & 0o6022) || !info.isFile()) throw unavailable();
    const header = Buffer.alloc(64);
    await handle.read(header, 0, header.length, 0);
    if (header.subarray(0, 4).toString('hex') !== '7f454c46' || header[4] !== 2 || header[5] !== 1 ||
      header.readUInt16LE(18) !== 62 || ![2, 3].includes(header.readUInt16LE(16)) || header.readUInt16LE(54) !== 56) throw unavailable();
    const offset = Number(header.readBigUInt64LE(32));
    const count = header.readUInt16LE(56);
    if (!Number.isSafeInteger(offset) || count < 1 || count > 128 || offset + count * 56 > info.size) throw unavailable();
    const programs = Buffer.alloc(count * 56);
    await handle.read(programs, 0, programs.length, offset);
    let interpreter: string | undefined;
    for (let i = 0; i < count; i++) {
      if (programs.readUInt32LE(i * 56) !== 3) continue; // PT_INTERP
      const at = Number(programs.readBigUInt64LE(i * 56 + 8));
      const size = Number(programs.readBigUInt64LE(i * 56 + 32));
      if (!Number.isSafeInteger(at) || size < 2 || size > 256 || at + size > info.size) throw unavailable();
      const bytes = Buffer.alloc(size);
      await handle.read(bytes, 0, size, at);
      interpreter = bytes.subarray(0, size - 1).toString();
    }
    if (!interpreter || !['/lib64/ld-linux-x86-64.so.2', '/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2'].includes(interpreter)) throw unavailable();
    await trustedFile(interpreter);
    return { path, handle };
  } catch (error) { await handle.close(); throw error; }
}

/** Kill the supervisor group and let PID-namespace teardown kill every runtime thread.
 * --die-with-parent also covers a host crash; stdio 'close' confirms namespace teardown. */
const closedProcesses = new WeakMap<ChildProcess, Promise<void>>();
function track<T extends ChildProcess>(child: T): T {
  closedProcesses.set(child, new Promise(resolve => child.once('close', () => resolve())));
  return child;
}

async function stop(child: ChildProcess): Promise<void> {
  const closed = closedProcesses.get(child);
  if (!closed) throw new AdapterError('CONTAINMENT_FAILURE', 'Unknown containment process.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AdapterError('CONTAINMENT_FAILURE', 'Containment termination could not be confirmed.')), 3_000);
  });
  try {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      child.kill('SIGKILL');
    }
    await Promise.race([closed, timeout]);
  } finally { clearTimeout(timer); }
}

async function compile(directory: string, signal: AbortSignal): Promise<string> {
  await trustedFile('/usr/bin/cc');
  const source = join(directory, 'bootstrap.c');
  const library = join(directory, 'bootstrap.so');
  await writeFile(source, LINUX_BOOTSTRAP_SOURCE, { mode: 0o600 });
  throwIfAborted(signal);
  const child = track(spawn('/usr/bin/cc', ['-shared', '-fPIC', '-O2', '-Wall', '-Wextra', '-Werror',
    '-Wl,-z,relro,-z,now', '-o', library, source], { env: { PATH: '/usr/bin', TMPDIR: directory }, cwd: directory, detached: true, stdio: ['ignore', 'ignore', 'pipe'] }));
  child.stderr?.resume(); // Never expose compiler paths or output in normalized errors.
  const onAbort = () => { void stop(child).catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', () => reject(unavailable()));
      child.once('close', code => code === 0 ? resolve() : reject(unavailable()));
    });
    throwIfAborted(signal);
    await chmod(library, 0o400);
    return library;
  } finally { signal.removeEventListener('abort', onAbort); }
}

async function ready(child: ChildProcess, signal: AbortSignal, timeoutMs: number): Promise<void> {
  const pipe = child.stdio[3] as Readable;
  const confirmation = Buffer.from('YOUR_BOT_CONTAINED_V1\n');
  await new Promise<void>((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      child.removeListener('error', fail);
      child.removeListener('exit', fail);
      pipe.removeListener('data', data);
      pipe.removeListener('end', fail);
      pipe.removeListener('error', fail);
      error ? reject(error) : resolve();
    };
    const fail = () => finish(unavailable());
    const abort = () => finish(new AdapterError('CANCELLED', 'Agent task was cancelled.'));
    const data = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > confirmation.length) return fail();
      if (bytes.length === confirmation.length) bytes.equals(confirmation) ? finish() : fail();
    };
    const timer = setTimeout(fail, timeoutMs);
    pipe.on('data', data);
    pipe.once('end', fail);
    pipe.once('error', fail);
    child.once('error', fail);
    child.once('exit', fail);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Concrete fail-closed Linux x86_64 containment for a single distro Node/Python harness.
 * No credentials/network/native grants. Actual tools use the gateway ACP extension.
 * Requires root-administered /usr, glibc, cc + Linux headers, bubblewrap with --size,
 * and usable user/PID/network/mount namespaces + seccomp TSYNC. */
export class BubblewrapContainmentLauncher implements ContainmentLauncher {
  private readonly options: Required<BubblewrapContainmentOptions>;

  constructor(options: BubblewrapContainmentOptions) {
    if (!isAbsolute(options.scriptPath) || !['.mjs', '.py'].includes(extname(options.scriptPath))) {
      throw new AdapterError('INVALID_CONFIG', 'Declare an absolute .mjs or .py harness script.');
    }
    this.options = {
      scriptPath: options.scriptPath,
      scratchBytes: positiveInteger(options.scratchBytes ?? 64 * 1024 * 1024, 'scratchBytes'),
      addressSpaceBytes: positiveInteger(options.addressSpaceBytes ?? 8 * 1024 ** 3, 'addressSpaceBytes'),
      fileBytes: positiveInteger(options.fileBytes ?? 16 * 1024 * 1024, 'fileBytes'),
      cpuSeconds: positiveInteger(options.cpuSeconds ?? 30, 'cpuSeconds'),
      wallTimeMs: positiveInteger(options.wallTimeMs ?? 120_000, 'wallTimeMs'),
      startupTimeoutMs: positiveInteger(options.startupTimeoutMs ?? 10_000, 'startupTimeoutMs'),
    };
  }

  async launch(request: HarnessLaunchRequest): Promise<ContainedHarness> {
    throwIfAborted(request.signal);
    if (process.platform !== 'linux' || process.arch !== 'x64' || request.args.length !== 1 ||
      request.args[0] !== this.options.scriptPath ||
      (request.command === '/usr/bin/node' ? extname(this.options.scriptPath) !== '.mjs' :
        request.command === '/usr/bin/python3' ? extname(this.options.scriptPath) !== '.py' : true)) throw unavailable();

    const controller = new AbortController();
    const abort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    const deadline = setTimeout(() => controller.abort(new AdapterError('TIMEOUT', 'Harness containment deadline expired.')), this.options.wallTimeMs);
    let directory: string | undefined;
    let runtime: Awaited<ReturnType<typeof dynamicRuntime>> | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    let retired: Promise<void> | undefined;
    const handles: FileHandle[] = [];
    const terminate = (): Promise<void> => retired ??= (async () => {
      clearTimeout(deadline);
      request.signal.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', kill);
      if (child) await stop(child);
      await Promise.all(handles.splice(0).map(handle => handle.close()));
      if (directory) await rm(directory, { recursive: true, force: true });
    })();
    const kill = () => { void terminate().catch(() => {}); };
    try {
      const bwrap = await trustedFile('/usr/bin/bwrap');
      runtime = await dynamicRuntime(request.command);
      handles.push(runtime.handle);
      directory = await mkdtemp(join(tmpdir(), 'your-bot-acp-contained-'));
      await chmod(directory, 0o700);
      const script = await open(await realpath(this.options.scriptPath), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let snapshot: Buffer;
      try {
        const info = await script.stat();
        if (!info.isFile() || info.size > 1024 * 1024) throw unavailable();
        // Fixed-size read prevents a concurrent host writer growing an unbounded snapshot.
        snapshot = Buffer.alloc(info.size);
        const { bytesRead } = await script.read(snapshot, 0, info.size, 0);
        if (bytesRead !== info.size) throw unavailable();
      } finally { await script.close(); }
      const scriptCopy = join(directory, `script${extname(this.options.scriptPath)}`);
      await writeFile(scriptCopy, snapshot, { mode: 0o400 });
      const library = await compile(directory, controller.signal);
      throwIfAborted(controller.signal);
      for (const path of [library, scriptCopy]) handles.push(await open(path, constants.O_RDONLY | constants.O_NOFOLLOW));
      const mounts: string[] = [];
      // Shared libraries + the selected interpreter's system modules, rather than /usr.
      // No /usr/bin tree, /usr/local, /etc, host /tmp, projects or home mounts.
      const mountLibrary = async (path: string, required = false): Promise<boolean> => {
        try {
          const canonical = await realpath(path);
          const info = await stat(canonical);
          if (!canonical.startsWith('/usr/') || !info.isDirectory() || info.uid !== 0 || (info.mode & 0o022)) throw unavailable();
          mounts.push('--ro-bind', canonical, path);
          return true;
        } catch (error) {
          if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        }
      };
      const multiarch = await mountLibrary('/usr/lib/x86_64-linux-gnu');
      const lib64 = await mountLibrary('/usr/lib64');
      if (!multiarch && !lib64) throw unavailable();
      if (request.command === '/usr/bin/python3') {
        const version = runtime.path.match(/\/python(3\.\d+)$/)?.[1];
        if (!version) throw unavailable();
        await mountLibrary(`/usr/lib/python${version}`, true);
        await mountLibrary('/usr/lib/python3/dist-packages');
        await mountLibrary('/usr/lib/locale');
      } else {
        await mountLibrary('/usr/lib/nodejs');
        if (await mountLibrary('/usr/share/nodejs')) mounts.push('--symlink', '/usr/share/nodejs', '/harness/node_modules');
      }
      const sandboxScript = `/harness/script${extname(this.options.scriptPath)}`;
      const args = ['--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts',
        '--cap-drop', 'ALL', '--die-with-parent', '--new-session', '--clearenv',
        ...mounts, '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
        '--ro-bind-fd', '4', runtime.path,
        '--ro-bind-data', '5', '/bootstrap.so', '--ro-bind-data', '6', sandboxScript,
        '--proc', '/proc', '--dev', '/dev',
        '--size', String(this.options.scratchBytes), '--tmpfs', '/scratch', '--symlink', 'scratch', '/tmp',
        '--remount-ro', '/', '--chdir', '/scratch',
        '--setenv', 'LD_PRELOAD', '/bootstrap.so',
        '--setenv', 'YOUR_BOT_AS', String(this.options.addressSpaceBytes),
        '--setenv', 'YOUR_BOT_CPU', String(this.options.cpuSeconds),
        '--setenv', 'YOUR_BOT_FILE', String(this.options.fileBytes),
        '--', runtime.path, ...(request.command === '/usr/bin/node'
          ? ['--no-addons', '--disable-wasm-trap-handler', '--max-old-space-size=256', sandboxScript]
          : ['-I', '-B', sandboxScript])];
      // Bubblewrap passes unused inherited fds to the runtime. fd3 confirms bootstrap;
      // fds4..6 are consumed mount inputs. The constructor closes every fd >= 4.
      child = track(spawn(bwrap, args, { env: {}, cwd: '/', detached: true,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe', ...handles.map(handle => handle.fd)],
      }) as ChildProcessWithoutNullStreams);
      // Error events must remain handled even when the caller has already aborted.
      child.on('error', () => {});
      child.once('close', () => { void terminate().catch(() => {}); });
      controller.signal.addEventListener('abort', kill, { once: true });
      if (controller.signal.aborted) kill();
      await ready(child, controller.signal, this.options.startupTimeoutMs);
      throwIfAborted(controller.signal);
      await Promise.all(handles.splice(0).map(handle => handle.close()));
      return { process: child, cwd: '/scratch', terminate };
    } catch (error) {
      await terminate();
      if (controller.signal.aborted) throwIfAborted(controller.signal);
      if (error instanceof AdapterError) throw error;
      throw unavailable();
    }
  }
}
