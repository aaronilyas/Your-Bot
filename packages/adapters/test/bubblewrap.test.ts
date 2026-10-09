import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BubblewrapContainmentLauncher, createAdapters, type ContainedHarness } from '../src/index.js';
import { context, waitUntil } from './helpers.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanup.splice(0).reverse()) await clean(); });

async function temporary(base = tmpdir()): Promise<string> {
  const path = await mkdtemp(join(base, 'your-bot-bwrap-test-'));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function launch(scriptPath: string, command = '/usr/bin/python3', options: Partial<ConstructorParameters<typeof BubblewrapContainmentLauncher>[0]> = {}) {
  const controller = new AbortController();
  const launcher = new BubblewrapContainmentLauncher({ scriptPath, ...options });
  const handle = await launcher.launch({ command, args: [scriptPath], signal: controller.signal });
  // Production RPC drains stderr; tests drain it too, without leaking host paths.
  handle.process.stderr.resume();
  cleanup.push(() => handle.terminate());
  return { handle, controller, launcher };
}

async function line(handle: ContainedHarness): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => finish(new Error('Contained fixture did not report its results.')), 3000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      handle.process.stdout.removeListener('data', chunk);
      handle.process.removeListener('exit', exit);
      error ? reject(error) : resolve(data.split('\n')[0]);
    };
    const chunk = (bytes: Buffer) => { data += bytes.toString(); if (data.includes('\n')) finish(); };
    const exit = () => finish(new Error('Contained fixture exited before reporting results.'));
    handle.process.stdout.on('data', chunk);
    handle.process.once('exit', exit);
  });
}

// Missing bwrap/namespace/seccomp/compiler support FAILS these tests on Linux;
// no environmental skip can be reported as genuine isolation success.
describe.skipIf(process.platform !== 'linux' || process.arch !== 'x64')('real Linux Bubblewrap isolation', () => {
  it.each([['node', 'contained.mjs'], ['python3', 'contained.py']])('initializes and streams ACP through contained %s', async (runtime, name) => {
    const scriptPath = fixture(name);
    const containment = new BubblewrapContainmentLauncher({ scriptPath });
    const [adapter] = createAdapters([{ id: 'contained', name: 'Contained', kind: 'acp', enabled: true,
      command: `/usr/bin/${runtime}`, args: [scriptPath] }], { acp: { containment } });
    cleanup.push(() => adapter.close());
    const run = context();
    await adapter.run(run);
    expect(run.updates.filter(update => update.type === 'text').map(update => update.text).join('')).toBe('Contained 🌍');
    expect(run.executeTool).not.toHaveBeenCalled();
  });

  it('enforces real syscalls, readonly runtime, hidden home/secrets, sized private scratch and hard limits', async () => {
    const directory = await temporary();
    const home = await temporary(homedir());
    const hostTmp = join(directory, 'sentinel');
    const hostHome = join(home, 'sentinel');
    const hostSecret = join(home, 'secret');
    await writeFile(hostTmp, 'untouched');
    await writeFile(hostHome, 'untouched');
    await writeFile(hostSecret, 'SECRET');
    const source = (await readFile(fixture('malicious.py'), 'utf8'))
      .replace('__HOST_TMP__', hostTmp).replace('__HOST_HOME__', hostHome).replace('__HOST_SECRET__', hostSecret);
    const scriptPath = join(directory, 'malicious.py');
    await writeFile(scriptPath, source);
    const original = process.env.YOUR_BOT_TEST_SECRET;
    process.env.YOUR_BOT_TEST_SECRET = 'INHERITED_SECRET';
    let handle: ContainedHarness;
    try { ({ handle } = await launch(scriptPath)); }
    finally { if (original === undefined) delete process.env.YOUR_BOT_TEST_SECRET; else process.env.YOUR_BOT_TEST_SECRET = original; }
    const result = JSON.parse(await line(handle!)) as Record<string, unknown>;
    for (const name of ['spawn', 'fork', 'vfork', 'clone_process', 'clone_namespace', 'clone_high_bits',
      'execve', 'execveat', 'socket_ipv4', 'socket_ipv6', 'socket_unix', 'socketpair',
      'mount', 'umount', 'unshare', 'setns', 'ptrace', 'io_uring', 'bpf', 'keyctl',
      'open_by_handle_at', 'process_vm_readv', 'pidfd_getfd', 'seccomp_replace', 'setrlimit', 'prctl_lower_security']) {
      expect(result[name], name).toBe(1); // EPERM from the actual seccomp boundary.
    }
    expect(result.clone3).toBe(38); // ENOSYS enables safe libc thread fallback.
    expect(result.host_tmp_write).toBe(2);
    expect(result.host_home_write).toBe(2);
    expect(result.host_home_read).toBe(2);
    // The namespace init has only the sandbox root; kernels may also deny dereferencing it.
    expect([2, 13]).toContain(result.proc_init_home_read);
    expect(result.proc_self_home_read).toBe(2);
    expect(result.init_environ === 13 || result.init_environ === '').toBe(true);
    expect(result.usr_write).toBe(30); // EROFS, including readonly root scaffolding.
    expect(result.root_write).toBe(30);
    // Python itself adds its UTF-8 locale after bootstrap; neither value came from host env.
    expect(result.env).toEqual({ PWD: '/scratch', LC_CTYPE: 'C.UTF-8' });
    expect(result.cwd).toBe('/scratch');
    expect(result.thread).toBe('worked');
    expect(result.tmp_same_scratch).toBe(true);
    expect(result.limits).toEqual({ as: [8 * 1024 ** 3, 8 * 1024 ** 3], cpu: [30, 30],
      file: [16 * 1024 ** 2, 16 * 1024 ** 2], fd: [64, 64], core: [0, 0] });
    expect(await readFile(hostTmp, 'utf8')).toBe('untouched');
    expect(await readFile(hostHome, 'utf8')).toBe('untouched');
    await handle!.terminate();
    expect(handle!.process.signalCode).toBe('SIGKILL');
  });

  it('denies Node child_process spawn and internet sockets while allowing runtime threads', async () => {
    const directory = await temporary();
    const scriptPath = join(directory, 'node-malicious.mjs');
    await writeFile(scriptPath, `import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
      import net from 'node:net'; import {Worker} from 'node:worker_threads';
      const result = {spawn: spawnSync('/usr/bin/node', ['--version']).error?.code};
      const worker = new Worker('require("node:worker_threads").parentPort.postMessage("thread worked")', {eval:true});
      worker.on('message', value => { result.thread = value;
        const server = net.createServer(); server.on('error', error => {
          result.socket = error.code; fs.writeSync(1, JSON.stringify(result)+'\\n');
          setInterval(()=>{},1000);
        }); server.listen(43210,'127.0.0.1');
      });`);
    const { handle } = await launch(scriptPath, '/usr/bin/node');
    expect(JSON.parse(await line(handle))).toEqual({ spawn: 'EPERM', thread: 'thread worked', socket: 'EPERM' });
  });

  it('denies native ACP grants and filesystem RPC, routing the tool extension through core', async () => {
    const scriptPath = fixture('contained-tools.mjs');
    const [adapter] = createAdapters([{ id: 'tools', name: 'Tools', kind: 'acp', enabled: true,
      command: '/usr/bin/node', args: [scriptPath] }], {
      acp: { containment: new BubblewrapContainmentLauncher({ scriptPath }) },
    });
    cleanup.push(() => adapter.close());
    const run = context();
    await adapter.run(run);
    const report = JSON.parse(run.updates.filter(update => update.type === 'text').map(update => update.text).join(''));
    expect(report).toMatchObject({ permission: { outcome: { outcome: 'selected', optionId: 'no' } }, filesystem: -32601,
      tool: { value: 'host-result' } });
    expect(run.requestPermission).not.toHaveBeenCalled();
    expect(run.executeTool).toHaveBeenCalledExactlyOnceWith({ id: 'extension', kind: 'skill', skillId: 'example', input: {} });
  });

  it('awaits real containment teardown on ACP task cancellation', async () => {
    const scriptPath = fixture('contained.mjs');
    const [adapter] = createAdapters([{ id: 'hang', name: 'Hang', kind: 'acp', enabled: true,
      command: '/usr/bin/node', args: [scriptPath] }], {
      acp: { containment: new BubblewrapContainmentLauncher({ scriptPath }) },
    });
    cleanup.push(() => adapter.close());
    const run = context();
    run.session.messages[0].content = 'Hang';
    const result = adapter.run(run).catch(error => error);
    await waitUntil(() => run.updates.some(update => update.type === 'text' && update.text === 'started'));
    await adapter.cancel(run.taskId);
    expect(await result).toMatchObject({ code: 'CANCELLED' });
    expect(run.updates.filter(update => update.type === 'text')).toEqual([{ type: 'text', text: 'started' }]);
  });

  it('limits scratch capacity and refuses changing hard resource limits', async () => {
    const directory = await temporary();
    const scriptPath = join(directory, 'quota.py');
    await writeFile(scriptPath, `import os,json,resource,sys,ctypes
result = {'capacity':os.statvfs('/scratch').f_blocks * os.statvfs('/scratch').f_frsize}
libc=ctypes.CDLL(None,use_errno=True)
limits=(ctypes.c_ulong*2)(999999999,999999999)
result['raise']=ctypes.get_errno() if libc.setrlimit(resource.RLIMIT_FSIZE,ctypes.byref(limits)) == -1 else 'ALLOWED'
try:
    with open('/scratch/full','wb') as f:
        for n in range(128): f.write(b'x'*65536)
    result['fill']='ALLOWED'
except OSError as e: result['fill']=e.errno
print(json.dumps(result),flush=True)
for line in sys.stdin: pass
`);
    const { handle } = await launch(scriptPath, '/usr/bin/python3', { scratchBytes: 1024 * 1024 });
    expect(JSON.parse(await line(handle))).toEqual({ capacity: 1024 * 1024, raise: 1, fill: 28 });
  });

  it('aborts containment and cleans its private setup files, including live worker threads', async () => {
    const directory = await temporary();
    const scriptPath = join(directory, 'hang.py');
    await writeFile(scriptPath, `import threading,time,os,json
threading.Thread(target=lambda:time.sleep(60)).start()
print(json.dumps({'ready':True}),flush=True)
time.sleep(60)
`);
    const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith('your-bot-acp-contained-')));
    const { handle, controller } = await launch(scriptPath);
    expect(JSON.parse(await line(handle))).toEqual({ ready: true });
    const exited = once(handle.process, 'close');
    controller.abort();
    await exited;
    await handle.terminate();
    expect(handle.process.signalCode).toBe('SIGKILL');
    expect((await readdir(tmpdir())).filter(name => name.startsWith('your-bot-acp-contained-') && !before.has(name))).toEqual([]);
  });

  it('applies an independent wall deadline', async () => {
    const directory = await temporary();
    const scriptPath = join(directory, 'hang.py');
    await writeFile(scriptPath, 'import time\ntime.sleep(60)\n');
    const { handle } = await launch(scriptPath, '/usr/bin/python3', { wallTimeMs: 800 });
    await waitUntil(() => handle.process.signalCode !== null);
    await handle.terminate();
    expect(handle.process.signalCode).toBe('SIGKILL');
  });

  it('cleans partial startup on abort and rejects oversized snapshots without executing them', async () => {
    const directory = await temporary();
    const scriptPath = join(directory, 'oversize.py');
    await writeFile(scriptPath, '#'.repeat(1024 * 1024 + 1));
    const launcher = new BubblewrapContainmentLauncher({ scriptPath });
    const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith('your-bot-acp-contained-')));
    await expect(launcher.launch({ command: '/usr/bin/python3', args: [scriptPath], signal: new AbortController().signal })).rejects.toMatchObject({ code: 'CONTAINMENT_UNAVAILABLE' });
    await writeFile(scriptPath, 'print("SHOULD_NOT_RUN")\n');
    const controller = new AbortController();
    const promise = launcher.launch({ command: '/usr/bin/python3', args: [scriptPath], signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
    expect((await readdir(tmpdir())).filter(name => name.startsWith('your-bot-acp-contained-') && !before.has(name))).toEqual([]);
  });

  it('rejects a declared FIFO without blocking open or launching the harness', async () => {
    const directory = await temporary();
    const scriptPath = join(directory, 'fifo.py');
    expect(spawnSync('/usr/bin/mkfifo', [scriptPath]).status).toBe(0);
    const launcher = new BubblewrapContainmentLauncher({ scriptPath });
    await expect(launcher.launch({ command: '/usr/bin/python3', args: [scriptPath], signal: new AbortController().signal })).rejects.toMatchObject({ code: 'CONTAINMENT_UNAVAILABLE' });
  });

  it('fails closed for user executables, runtime flags, extra script arguments and mismatched script types', async () => {
    const scriptPath = fixture('contained.mjs');
    const launcher = new BubblewrapContainmentLauncher({ scriptPath });
    for (const [command, args] of [['/bin/sh', [scriptPath]], [scriptPath, []], ['/usr/bin/true', [scriptPath]],
      ['/usr/bin/node', ['--eval', 'process.exit(0)']], ['/usr/bin/node', [scriptPath, '--flag']],
      ['/usr/bin/python3', [scriptPath]]] as const) {
      await expect(launcher.launch({ command, args, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'CONTAINMENT_UNAVAILABLE' });
    }
    await expect(launcher.launch({ command: '/usr/bin/node', args: [scriptPath], signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
