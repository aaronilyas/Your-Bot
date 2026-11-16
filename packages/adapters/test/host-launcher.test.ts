import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HostLauncher, hostEnvironment, quoteWindowsBatchArg, quoteWindowsBatchCommand, resolveWindowsCommand } from '../src/host-launcher.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const tree = fileURLToPath(new URL('./fixtures/tree.mjs', import.meta.url));

async function directory(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'your-bot-host-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('host launcher', () => {
  it('copies only the allowlist and named passthrough variables', () => {
    const env = hostEnvironment(['YOUR_BOT_PASS', 'NOT_SET'], {
      PATH: '/bin', Path: 'C:\\Windows', HOME: '/home/me', USERPROFILE: 'C:\\Users\\me',
      XDG_CONFIG_HOME: '/xdg', LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8', TMPDIR: '/tmp',
      APPDATA: 'C:\\App', LOCALAPPDATA: 'C:\\Local', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\cmd.exe',
      PATHEXT: '.CMD;.EXE', YOUR_BOT_PASS: 'visible', YOUR_BOT_SECRET_SHOULD_NOT_LEAK: 'nope',
      NODE_OPTIONS: '--inspect', API_KEY: 'secret',
    });
    expect(env.YOUR_BOT_SECRET_SHOULD_NOT_LEAK).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.API_KEY).toBeUndefined();
    expect(env.NOT_SET).toBeUndefined();
    expect(env.YOUR_BOT_PASS).toBe('visible');
    expect(env.HOME).toBe('/home/me');
    expect(env.XDG_CONFIG_HOME).toBe('/xdg');
    expect(env.LC_ALL).toBe('C.UTF-8');
    if (process.platform === 'win32') expect(env.Path ?? env.PATH).toBeTruthy();
    else expect(env.PATH).toBe('/bin');
  });

  it('resolves PATHEXT with the current directory before PATH', () => {
    const cwd = 'C:\\work';
    const tools = 'C:\\tools';
    const found = new Set([
      'C:\\work\\local.CMD',
      'C:\\tools\\grok.EXE',
      'C:\\tools\\npm.CMD',
    ]);
    const exists = (candidate: string) => found.has(candidate);
    const env = { PATH: tools, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    expect(resolveWindowsCommand('local', cwd, env, exists)).toBe('C:\\work\\local.CMD');
    expect(resolveWindowsCommand('grok', cwd, env, exists)).toBe('C:\\tools\\grok.EXE');
    expect(resolveWindowsCommand('npm', cwd, env, exists)).toBe('C:\\tools\\npm.CMD');
    expect(resolveWindowsCommand('missing', cwd, env, exists)).toBe('missing');
  });

  it('quotes batch arguments for cmd.exe /d /s /c', () => {
    expect(quoteWindowsBatchCommand('C:\\tools\\agent.cmd', ['hello'])).toBe('"C:\\tools\\agent.cmd" hello');
    expect(quoteWindowsBatchCommand('C:\\Program Files\\agent.cmd', ['hello world'])).toBe('"C:\\Program Files\\agent.cmd" "hello world"');
    expect(quoteWindowsBatchArg('a&b')).toBe('"a&b"');
    expect(quoteWindowsBatchArg('say "hi"')).toBe('"say ""hi"""');
    expect(quoteWindowsBatchArg('%PATH%')).toBe('"%%cd:~,%PATH%%cd:~,%"');
    expect(quoteWindowsBatchArg('')).toBe('""');
    expect(() => quoteWindowsBatchArg('one\ntwo')).toThrow(/newlines or NUL/);
    expect(() => quoteWindowsBatchCommand('C:\\bad%.cmd', [])).toThrow(/cannot be quoted safely/);
  });

  it('kills the agent process group, including a grandchild that ignores SIGTERM', async () => {
    const dir = await directory();
    const controller = new AbortController();
    const hosted = await new HostLauncher().launch({
      command: process.execPath, args: [tree], cwd: dir, signal: controller.signal,
    });
    const line = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      hosted.process.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        if (newline >= 0) resolve(buffer.slice(0, newline));
      });
      hosted.process.once('exit', () => reject(new Error('tree exited before reporting pids')));
    });
    const ids = JSON.parse(line) as { self: number; child: number };
    if (process.platform !== 'win32') expect(alive(-ids.self)).toBe(true);
    await hosted.terminate();
    const end = Date.now() + 3000;
    while ((alive(ids.self) || alive(ids.child)) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
    expect(alive(ids.self)).toBe(false);
    expect(alive(ids.child)).toBe(false);
    controller.abort();
  });

  it('runs a .cmd shim through cmd.exe when on Windows', async () => {
    if (process.platform !== 'win32') return;
    const dir = await directory();
    const script = path.join(dir, 'shim.cmd');
    const output = path.join(dir, 'out.txt');
    await writeFile(script, '@echo off\r\n> "%~2" echo(%~1\r\n');
    const controller = new AbortController();
    const hosted = await new HostLauncher().launch({
      command: script, args: ['spaced value', output], cwd: dir, signal: controller.signal,
    });
    await new Promise((resolve, reject) => hosted.process.once('exit', code => code === 0 ? resolve(code) : reject(new Error(`shim exited ${code}`))));
    expect((await readFile(output, 'utf8')).trim()).toBe('spaced value');
    controller.abort();
  });
});

describe('spawn plan is direct off Windows', () => {
  it('does not wrap a normal executable in a shell', () => {
    if (process.platform === 'win32') return;
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { shell: false, stdio: 'ignore' });
    expect(child.spawnfile).toBe(process.execPath);
    child.unref();
  });
});
