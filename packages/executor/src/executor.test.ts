import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { PermissionRequest, ToolExecutionContext, ToolInvocation, ToolResult } from '@your-bot/contracts';
import { createToolExecutor, probeSandbox, pythonApprovalReason, type PythonToolExecutor } from './index.js';
import { pinFile } from './files.js';

let root: string;
let executor: PythonToolExecutor;
const outputs: string[] = [];
function context(allow = true, taskId = 'task'): ToolExecutionContext {
  const ctx: ToolExecutionContext = {
    authorization: { principal: { id: 'owner', kind: 'local', capabilities: ['tool.execute', 'file.read', 'file.write', 'file.delete', 'library.install'] }, sessionId: 'session', taskId, grants: [] },
    signal: new AbortController().signal,
    requestPermission: async request => {
      const id = 'grant-' + ctx.authorization.grants.length;
      if (allow) ctx.authorization.grants.push({ ...request, id, principalId: 'owner', sessionId: 'session', taskId });
      return { requestId: id, outcome: allow ? 'allow' : 'deny', scope: 'once' };
    },
    emit: output => outputs.push(output.text),
  };
  return ctx;
}
function python(code: string, extra: Partial<ToolInvocation> = {}): ToolInvocation {
  return { id: 'call', kind: 'python', code, input: null, ...extra };
}
function skill(skillId: string, input: ToolInvocation['input'], extra: Partial<ToolInvocation> = {}): ToolInvocation {
  return { id: 'call', kind: 'skill', skillId, input, ...extra };
}
const code = (result: ToolResult) => result.error?.code;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'your-bot-executor-test-'));
  executor = createToolExecutor({ environmentRoot: path.join(root, 'app'), maxOutputBytes: 128 * 1024 });
  outputs.length = 0;
});
afterEach(async () => { vi.unstubAllGlobals(); await executor.close(); await rm(root, { recursive: true, force: true }); });

describe('real Linux bubblewrap and seccomp (no skipped sandbox tests)', () => {
  it('probes the enforced runtime and reopens the application venv', async () => {
    const probe = await executor.probe();
    expect(probe, JSON.stringify(probe)).toMatchObject({ supported: true });
    expect(probe.pythonVersion).toMatch(/^3\./);
    expect(await probeSandbox({ environmentRoot: path.join(root, 'app') })).toMatchObject({ supported: true });
  });
  it('runs approved code with input/result and streams stdout', async () => {
    const result = await executor.execute(python('print("hello")\nresult = input["x"] * 7', { input: { x: 6 } }), context());
    expect(result).toEqual({ ok: true, value: 42 });
    expect(outputs.join('')).toContain('hello');
  });
  it('blocks host files, runtime/root writes, processes, threads and network at the OS boundary', async () => {
    const secret = path.join(root, 'secret');
    await writeFile(secret, 'private');
    const result = await executor.execute(python(String.raw`
import os, socket, ctypes, errno, subprocess, threading
for filename in [input, '/home', '/usr/forbidden', '/escape']:
    try:
        open(filename, 'w').write('escape')
        raise RuntimeError('host write allowed: ' + filename)
    except OSError:
        pass
for action in [os.fork, lambda: subprocess.run(['/usr/bin/python3', '-c', 'print(1)']), lambda: socket.socket(), lambda: threading.Thread(target=lambda: None).start()]:
    try:
        action()
        raise ValueError('process/network creation allowed')
    except (OSError, RuntimeError):
        pass
libc = ctypes.CDLL(None, use_errno=True)
for nr in [41,42,56,57,58,59,101,165,272,308,317,321,322,425,435,0x40000000|56]:
    ctypes.set_errno(0)
    assert libc.syscall(nr,0,0,0,0,0,0) == -1 and ctypes.get_errno() == errno.EPERM, nr
try:
    open(input).read()
    raise RuntimeError('host secret readable')
except OSError:
    pass
assert os.environ.get('HOME') == '/nonexistent'
assert 'USER' not in os.environ and 'PYTHONPATH' not in os.environ
open('/scratch/private', 'w').write('allowed')
result = True
`, { input: secret }), context());
    expect(result).toEqual({ ok: true, value: true });
    expect(await readFile(secret, 'utf8')).toBe('private');
  });
  it('kills alternate-architecture int80 syscalls rather than confusing syscall numbers', async () => {
    const result = await executor.execute(python(String.raw`
import mmap, ctypes
memory = mmap.mmap(-1, 4096, prot=mmap.PROT_READ|mmap.PROT_WRITE|mmap.PROT_EXEC)
memory.write(bytes.fromhex('b814000000cd80c3'))
function = ctypes.CFUNCTYPE(ctypes.c_int)(ctypes.addressof(ctypes.c_char.from_buffer(memory)))
function()
result = 'escaped'
`), context());
    expect(result.ok).toBe(false);
    expect(code(result)).toBe('EXECUTION_FAILED');
  });
  it('binds approved reads readonly and writes only the exact approved file', async () => {
    const input = path.join(root, 'input.txt'), output = path.join(root, 'output.txt');
    await writeFile(input, 'sample');
    const result = await executor.execute(python(String.raw`
import os
assert open(files[input['read']]).read() == 'sample'
try:
    open(files[input['read']], 'w').write('bad')
    raise RuntimeError('readonly binding writable')
except OSError:
    pass
open(files[input['write']], 'w').write('approved')
try:
    open('/files/other', 'w')
    raise RuntimeError('parent directory writable')
except OSError:
    pass
result = True
`, { input: { read: input, write: output }, paths: [{ path: input, access: 'read' }, { path: output, access: 'write' }] }), context());
    expect(result).toEqual({ ok: true, value: true });
    expect(await readFile(input, 'utf8')).toBe('sample');
    expect(await readFile(output, 'utf8')).toBe('approved');
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });
  it('never executes managed .pth hooks and clears scratch between workers', async () => {
    const probe = await executor.probe(); expect(probe.supported).toBe(true);
    const site = path.join(root, 'app/venv/lib', 'python' + probe.pythonVersion!.split('.').slice(0, 2).join('.'), 'site-packages');
    await writeFile(path.join(site, 'evil.pth'), "import sys; print('HOOK EXECUTED')\n");
    expect(await executor.execute(python("open('/scratch/marker','w').write('x'); result = True"), context())).toEqual({ ok: true, value: true });
    expect(await executor.execute(python("import os; result = os.path.exists('/scratch/marker')"), context())).toEqual({ ok: true, value: false });
    expect(outputs.join('')).not.toContain('HOOK EXECUTED');
  });
  it('keeps a real sandbox write bound to its approved inode during a host symlink swap', async () => {
    const file = path.join(root, 'race'), secret = path.join(root, 'secret');
    await writeFile(file, 'initial'); await writeFile(secret, 'private');
    let swap: Promise<void> | undefined;
    const ctx = context();
    ctx.emit = output => {
      if (output.text.includes('BOUND')) swap = (async () => {
        await rename(file, file + '.moved');
        await symlink(secret, file);
        await writeFile(file + '.moved', 'swapped');
      })();
    };
    const result = await executor.execute(python(String.raw`
import time
print('BOUND', flush=True)
while open(files[input]).read() != 'swapped':
    time.sleep(0.005)
open(files[input], 'w').write('approved')
result = True
`, { input: file, paths: [{ path: file, access: 'write' }] }), ctx);
    await swap;
    expect(result).toEqual({ ok: true, value: true });
    expect(await readFile(secret, 'utf8')).toBe('private');
    expect(await readFile(file + '.moved', 'utf8')).toBe('approved');
  });
  it('never executes a replaced managed interpreter before seccomp', async () => {
    expect((await executor.probe()).supported).toBe(true);
    const binary = path.join(root, 'app/venv/bin/python3');
    await rm(binary);
    await writeFile(binary, '#!/bin/sh\necho UNTRUSTED_BOOTSTRAP\n', { mode: 0o700 });
    const result = await executor.execute(python('import os, sys\ntry: os.fork()\nexcept PermissionError: result = sys.prefix'), context());
    expect(result).toEqual({ ok: true, value: '/venv' });
    expect(outputs.join('')).not.toContain('UNTRUSTED_BOOTSTRAP');
    expect(await probeSandbox({ environmentRoot: path.join(root, 'app') })).toMatchObject({ supported: true });
  });
  it('cancels and kills a worker process group, then runs a new task', async () => {
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const ctx = context(); ctx.emit = output => { if (output.text.includes('RUNNING')) ready(); };
    const running = executor.execute(python('print("RUNNING", flush=True)\nwhile True: pass'), ctx);
    await Promise.race([started, running.then(result => { throw new Error(JSON.stringify(result)); })]);
    await executor.cancel('task');
    expect(code(await running)).toBe('CANCELLED');
    expect(await executor.execute(skill('calculation', { operation: 'sum', values: [1, 2] }), context(true, 'next'))).toEqual({ ok: true, value: 3 });
  });
  it('observes AbortSignal and close, including pending permission callbacks', async () => {
    const controller = new AbortController(); const ctx = context(); ctx.signal = controller.signal;
    let permissionReady!: () => void; const requested = new Promise<void>(resolve => { permissionReady = resolve; });
    ctx.requestPermission = () => { permissionReady(); return new Promise(() => {}); };
    const pending = executor.execute(python('result=1'), ctx);
    await requested;
    controller.abort();
    expect(code(await pending)).toBe('CANCELLED');
    let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
    const next = context(); next.emit = () => ready();
    const running = executor.execute(python('print("started")\nwhile True: pass'), next);
    await Promise.race([started, running.then(result => { throw new Error(JSON.stringify(result)); })]);
    const queued = executor.execute(skill('calculation', { operation: 'sum', values: [1] }), context(true, 'queued'));
    await executor.close();
    expect(code(await queued)).toBe('CANCELLED');
    expect(code(await running)).toBe('CANCELLED');
    expect(code(await executor.execute(skill('calculation', { operation: 'sum', values: [1] }), context()))).toBe('EXECUTOR_CLOSED');
  });
  it('enforces time, output, file-size and memory caps', async () => {
    expect(code(await executor.execute(python('while True: pass', { timeoutMs: 200 }), context()))).toBe('TIMEOUT');
    expect(code(await executor.execute(python('print("a" * 200000)'), context()))).toBe('OUTPUT_LIMIT');
    expect((await executor.execute(python("open('/scratch/large','wb').write(b'a' * (20 * 1024 * 1024))"), context())).ok).toBe(false);
    expect((await executor.execute(python("result = bytearray(512 * 1024 * 1024)"), context())).ok).toBe(false);
    expect(await executor.execute(skill('calculation', { operation: 'max', values: [2, 9] }), context())).toEqual({ ok: true, value: 9 });
  });
});

describe('authorization and exact path handling', () => {
  it('requires explicit approval for custom code bound to its hash', async () => {
    expect(code(await executor.execute(python('result = 1'), context(false)))).toBe('PERMISSION_DENIED');
    const ctx = context(false);
    ctx.authorization.grants.push({ id: 'code', principalId: 'owner', sessionId: 'session', taskId: 'task', capability: 'tool.execute', reason: pythonApprovalReason('result = 1') });
    expect(code(await executor.execute(python('result = 2'), ctx))).toBe('PERMISSION_DENIED');
    expect(await executor.execute(python('result = 1'), ctx)).toEqual({ ok: true, value: 1 });
  });
  it('snapshots caller-owned code and scope objects before asynchronous approval', async () => {
    const invocation = python('result = 42');
    let pending!: () => void; const requested = new Promise<void>(resolve => { pending = resolve; });
    let resume!: () => void; const approval = new Promise<void>(resolve => { resume = resolve; });
    const ctx = context(); const approve = ctx.requestPermission;
    ctx.requestPermission = async request => { pending(); await approval; return approve(request); };
    const running = executor.execute(invocation, ctx);
    await requested;
    invocation.code = 'result = "mutated"';
    resume();
    expect(await running).toEqual({ ok: true, value: 42 });
  });
  it('rejects a bare allow without an exact core-issued grant', async () => {
    const ctx = context(); ctx.requestPermission = async () => ({ requestId: 'unknown', outcome: 'allow', scope: 'task' });
    expect(code(await executor.execute(python('result=1'), ctx))).toBe('PERMISSION_DENIED');
  });
  it.each(['principalId', 'sessionId', 'taskId'] as const)('rejects grants for another %s', async field => {
    const ctx = context();
    const grant: PermissionRequest = { id: 'invalid', principalId: 'owner', sessionId: 'session', taskId: 'task', capability: 'file.read', reason: 'test', paths: [{ path: '/tmp/example', access: 'read' }] };
    grant[field] = 'other'; ctx.authorization.grants.push(grant);
    expect(code(await executor.execute(skill('calculation', { operation: 'sum', values: [1] }), ctx))).toBe('INVALID_GRANT');
  });
  it('requires principal capability, exact scope and separate read approval for write mounts', async () => {
    const file = path.join(root, 'target'); await writeFile(file, 'unchanged');
    const ctx = context(false);
    ctx.authorization.grants.push({ id: 'wrong', principalId: 'owner', sessionId: 'session', taskId: 'task', capability: 'file.write', reason: 'test', paths: [{ path: file + '.other', access: 'write' }] });
    expect(code(await executor.execute(skill('file.write', { path: file, text: 'new' }, { paths: [{ path: file, access: 'write' }] }), ctx))).toBe('PERMISSION_DENIED');
    const noRead = context(); noRead.authorization.principal.capabilities = ['tool.execute', 'file.write'];
    expect(code(await executor.execute(skill('file.write', { path: file, text: 'new' }, { paths: [{ path: file, access: 'write' }] }), noRead))).toBe('PERMISSION_DENIED');
    expect(await readFile(file, 'utf8')).toBe('unchanged');
  });
  it('rejects symlinks at the leaf and every ancestor, noncanonical paths and writable hardlinks', async () => {
    const target = path.join(root, 'target'); await writeFile(target, 'safe');
    const leaf = path.join(root, 'leaf'); await symlink(target, leaf);
    const dir = path.join(root, 'alias'); await symlink(root, dir);
    const hard = path.join(root, 'hard'); await link(target, hard);
    for (const file of [leaf, path.join(dir, 'target'), root + '/x/../target', hard]) {
      expect(code(await executor.execute(skill('file.write', { path: file, text: 'bad' }, { paths: [{ path: file, access: 'write' }] }), context())), file).toBe('INVALID_PATH');
    }
    expect(await readFile(target, 'utf8')).toBe('safe');
  });
  it('pins an inode across leaf replacement rather than following a swapped symlink', async () => {
    const file = path.join(root, 'file'), other = path.join(root, 'other');
    await writeFile(file, 'bound'); await writeFile(other, 'private');
    const pinned = await pinFile({ path: file, access: 'write' });
    try {
      await rename(file, file + '.moved'); await symlink(other, file);
      await pinned.file.write('changed', 0, 'utf8');
      expect(await readFile(other, 'utf8')).toBe('private');
      expect(await readFile(file + '.moved', 'utf8')).toBe('changed');
    } finally { await pinned.close(); }
  });
  it('rejects unsupported bubblewrap before creating approved user output', async () => {
    await executor.close(); executor = createToolExecutor({ environmentRoot: path.join(root, 'unsupported'), bubblewrapPath: '/missing-bwrap' });
    const file = path.join(root, 'new-output');
    expect(code(await executor.execute(skill('file.write', { path: file, text: 'unsafe' }, { paths: [{ path: file, access: 'write' }] }), context()))).toBe('SANDBOX_UNAVAILABLE');
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('fails closed for insecure application directories', async () => {
    await mkdir(path.join(root, 'open'), { mode: 0o755 }); await chmod(path.join(root, 'open'), 0o755);
    expect(await probeSandbox({ environmentRoot: path.join(root, 'open') })).toMatchObject({ supported: false, error: { code: 'ENVIRONMENT_UNSAFE' } });
  });
});

describe('predefined skills', () => {
  it('calculates, analyzes rows and parses/selects structured JSON/CSV', async () => {
    expect(await executor.execute(skill('calculation', { operation: 'product', values: [2, 3, 7] }), context())).toEqual({ ok: true, value: 42 });
    expect(await executor.execute(skill('data.analysis', { rows: [{ x: 2 }, { x: 4 }, { x: 6 }], column: 'x' }), context())).toEqual({ ok: true, value: { count: 3, sum: 12, min: 2, max: 6, mean: 4, median: 4, stdev: 2 } });
    expect(await executor.execute(skill('structured.json', { text: '{"a":[7]}', select: ['a', 0] }), context())).toEqual({ ok: true, value: 7 });
    expect(await executor.execute(skill('structured.csv', { text: 'name,n\nx,2\n' }), context())).toEqual({ ok: true, value: [{ name: 'x', n: '2' }] });
  });
  it('reads, writes, analyzes and deletes approved exact files', async () => {
    const file = path.join(root, 'data.csv');
    const write = await executor.execute(skill('file.write', { path: file, text: 'x\n2\n4\n' }, { paths: [{ path: file, access: 'write' }] }), context());
    expect(write.ok).toBe(true);
    expect(await executor.execute(skill('file.read', { path: file }, { paths: [{ path: file, access: 'read' }] }), context())).toEqual({ ok: true, value: 'x\n2\n4\n' });
    expect(await executor.execute(skill('data.analysis', { path: file, column: 'x' }, { paths: [{ path: file, access: 'read' }] }), context())).toMatchObject({ ok: true, value: { count: 2, mean: 3 } });
    expect(await executor.execute(skill('file.delete', { path: file }, { paths: [{ path: file, access: 'delete' }] }), context())).toEqual({ ok: true, value: { deleted: file } });
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects undeclared paths and unknown skills', async () => {
    expect(code(await executor.execute(skill('file.read', { path: path.join(root, 'secret') }), context()))).toBe('PERMISSION_DENIED');
    expect(code(await executor.execute(skill('other', {}), context()))).toBe('UNKNOWN_SKILL');
  });
});

function wheelBytes(unsafePath?: string, oversized = false): Buffer {
  const script = String.raw`
import sys,io,zipfile
b=io.BytesIO()
with zipfile.ZipFile(b,'w',compression=zipfile.ZIP_DEFLATED) as z:
    z.writestr('yourbot_fixture/__init__.py','value = 42\n')
    z.writestr('yourbot_fixture-1.0.dist-info/METADATA','Metadata-Version: 2.1\nName: yourbot-fixture\nVersion: 1.0\n')
    z.writestr('yourbot_fixture-1.0.dist-info/WHEEL','Wheel-Version: 1.0\nGenerator: test\nRoot-Is-Purelib: true\nTag: py3-none-any\n')
    z.writestr('yourbot_fixture-1.0.dist-info/RECORD','yourbot_fixture/__init__.py,,\nyourbot_fixture-1.0.dist-info/METADATA,,\nyourbot_fixture-1.0.dist-info/WHEEL,,\nyourbot_fixture-1.0.dist-info/RECORD,,\n')
    if len(sys.argv) > 1:
        z.writestr(sys.argv[1], b'a' * (17 * 1024 * 1024) if len(sys.argv) > 2 else b'bad')
sys.stdout.buffer.write(b.getvalue())
`;
  const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', script, ...(unsafePath ? [unsafePath] : []), ...(oversized ? ['large'] : [])]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return result.stdout;
}
describe('separately approved managed package installation', () => {
  it.each(['--user', 'https://example.com/x.whl', 'foo>=1', '-r requirements', 'foo[bar]'])('rejects unsafe requirement %s', async spec => {
    expect(code(await executor.execute({ id: 'call', kind: 'library.install', input: null, packages: [spec] }, context()))).toBe('INVALID_PACKAGES');
  });
  it('does not download without explicit package approval', async () => {
    const spy = vi.fn(); vi.stubGlobal('fetch', spy);
    expect(code(await executor.execute({ id: 'call', kind: 'library.install', input: null, packages: ['example==1'] }, context(false)))).toBe('PERMISSION_DENIED');
    expect(spy).not.toHaveBeenCalled();
  });
  it('installs an approved fixture wheel offline in real bubblewrap, then imports it', async () => {
    // The actual pinned installer is downloaded over HTTPS; fixture metadata/bytes
    // are synthetic so we never publish or install anything globally.
    const originalFetch = globalThis.fetch;
    const bytes = wheelBytes();
    const hash = createHash('sha256').update(bytes).digest('hex');
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push(String(url));
      if (String(url).includes('/yourbot-fixture/')) return new Response(JSON.stringify({ info: { name: 'yourbot-fixture', version: '1.0' }, urls: [{ filename: 'yourbot_fixture-1.0-py3-none-any.whl', url: 'https://files.pythonhosted.org/yourbot_fixture.whl', digests: { sha256: hash }, yanked: false }] }));
      if (String(url).endsWith('/yourbot_fixture.whl')) return new Response(new Uint8Array(bytes));
      return originalFetch(url, init);
    });
    const result = await executor.execute({ id: 'install', kind: 'library.install', input: null, packages: ['yourbot-fixture==1.0'], timeoutMs: 30000 }, context());
    expect(result, outputs.join('')).toEqual({ ok: true, value: { installed: ['yourbot-fixture==1.0'] } });
    expect(calls.every(url => url.startsWith('https://pypi.org/') || url.startsWith('https://files.pythonhosted.org/'))).toBe(true);
    expect(await executor.execute(python('import yourbot_fixture; result = yourbot_fixture.value'), context())).toEqual({ ok: true, value: 42 });
    const probe = await executor.probe();
    await expect(stat(path.join(root, 'app/venv/lib', 'python' + probe.pythonVersion!.split('.').slice(0, 2).join('.'), 'site-packages/yourbot_fixture/__init__.py'))).resolves.toBeDefined();
    await expect((await import('node:fs/promises')).readdir(path.join(root, 'app'))).resolves.toEqual(['venv']);
  });
  it.each([['../escape', false, 'Unsafe wheel member path'], ['large', true, 'Wheel exceeds installation disk limits']] as const)('rejects unsafe wheel content %s before pip runs', async (member, oversized, message) => {
    const bytes = wheelBytes(member, oversized);
    const hash = createHash('sha256').update(bytes).digest('hex');
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('/pypi/')) {
        const pip = String(url).includes('/pip/');
        return new Response(JSON.stringify({ info: { name: pip ? 'pip' : 'example', version: pip ? '25.3' : '1' }, urls: [{ filename: pip ? 'pip-25.3-py3-none-any.whl' : 'example-1-py3-none-any.whl', url: 'https://files.pythonhosted.org/' + (pip ? 'pip' : 'example') + '.whl', digests: { sha256: hash }, yanked: false }] }));
      }
      return new Response(new Uint8Array(bytes));
    });
    const result = await executor.execute({ id: 'install', kind: 'library.install', input: null, packages: ['example==1'] }, context());
    expect(result).toMatchObject({ ok: false, error: { message } });
    await expect(stat(path.join(root, 'escape'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects unapproved wheel origins and hash mismatches', async () => {
    const metadata = { info: { name: 'example', version: '1' }, urls: [{ filename: 'example-1-py3-none-any.whl', url: 'https://evil.example/package.whl', digests: { sha256: 'x' }, yanked: false }] };
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(metadata)));
    expect(code(await executor.execute({ id: 'install', kind: 'library.install', input: null, packages: ['example==1'] }, context()))).toBe('PACKAGE_DOWNLOAD_FAILED');
    metadata.urls[0].url = 'https://files.pythonhosted.org/test.whl';
    expect(code(await executor.execute({ id: 'install', kind: 'library.install', input: null, packages: ['example==1'] }, context()))).toBe('PACKAGE_INTEGRITY_FAILED');
  });
});
