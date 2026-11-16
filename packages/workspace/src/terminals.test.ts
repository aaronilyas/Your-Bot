import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import type { WorkspaceHost } from '@your-bot/contracts';
import { createWorkspaceHost, buildEnvironment } from './index.js';
import { cleanupTemp, expectCode, linkDir, makeTemp, pidAlive, signal, waitFor } from './test-support.js';

const node = process.execPath;
const LONG = 'setInterval(() => {}, 1000)';
const TREE = `
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(LONG)}], { stdio: 'ignore' });
  process.stdout.write('GRANDCHILD ' + child.pid + '\\n');
  setInterval(() => {}, 1000);
`;

let host: WorkspaceHost;
let root: string;
let taskCounter = 0;
const newTask = () => `task-${++taskCounter}`;

beforeEach(async () => {
  root = await makeTemp();
  host = createWorkspaceHost();
});
afterEach(async () => {
  await host.close();
  await cleanupTemp();
});

const run = (args: string[], extra: { env?: { name: string; value: string }[]; outputByteLimit?: number; taskId?: string; signal?: AbortSignal; cwd?: string } = {}) =>
  host.createTerminal(root, { command: node, args, cwd: extra.cwd ?? root, env: extra.env, outputByteLimit: extra.outputByteLimit }, { taskId: extra.taskId ?? newTask(), signal: extra.signal ?? signal() });

async function finish(id: string) {
  const status = await host.waitForTerminalExit(id, signal());
  return { status, ...(await host.terminalOutput(id)) };
}

async function startTree(taskId = newTask(), controllerSignal: AbortSignal = signal()) {
  const id = await run(['-e', TREE], { taskId, signal: controllerSignal });
  await waitFor(async () => (await host.terminalOutput(id)).output.includes('GRANDCHILD '));
  const pid = Number(/GRANDCHILD (\d+)/.exec((await host.terminalOutput(id)).output)![1]);
  expect(pidAlive(pid)).toBe(true);
  return { id, pid, taskId };
}

describe('terminal basics', () => {
  it('runs a command without a shell and reports output and exit code', async () => {
    const id = await run(['-e', 'console.log("out"); console.error("err"); process.exit(7)']);
    const result = await finish(id);
    expect(result.status).toEqual({ exitCode: 7, signal: null });
    expect(result.exitStatus).toEqual({ exitCode: 7, signal: null });
    expect(result.output).toContain('out');
    expect(result.output).toContain('err');
    expect(result.truncated).toBe(false);
    await host.releaseTerminal(id);
  });

  it('exits 0 and exposes no exitStatus while running', async () => {
    const running = await run(['-e', LONG]);
    expect((await host.terminalOutput(running)).exitStatus).toBeUndefined();
    await host.killTerminal(running);
    const done = await run(['-e', '']);
    expect((await finish(done)).status).toEqual({ exitCode: 0, signal: null });
  });

  it('passes shell metacharacters literally (no shell)', async () => {
    const args = [';echo injected', '$(echo injected)', '`echo injected`', '*', 'a b', '"q"', '&echo injected', '%PATH%', ''];
    const id = await run(['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args]);
    const result = await finish(id);
    expect(JSON.parse(result.output)).toEqual(args);
  });

  it('uses the allowlisted environment plus request variables only', async () => {
    process.env.YB_TEST_SECRET = 'leak';
    try {
      const id = await run(['-e', 'process.stdout.write(JSON.stringify(process.env))'], { env: [{ name: 'YB_REQ', value: 'yes' }] });
      const env = JSON.parse((await finish(id)).output) as Record<string, string>;
      expect(env.YB_TEST_SECRET).toBeUndefined();
      expect(env.YB_REQ).toBe('yes');
      expect(Object.keys(env).some(name => name.toLowerCase() === 'path')).toBe(true);
    } finally { delete process.env.YB_TEST_SECRET; }
  });

  it('buildEnvironment allowlist semantics', () => {
    const base = { PATH: '/bin', HOME: '/h', XDG_DATA_HOME: '/x', LC_ALL: 'C', LANG: 'C', SECRET: 's', npm_token: 't', SystemRoot: 'C:\\W', TMPDIR: '/t' };
    expect(buildEnvironment(base, [{ name: 'A', value: '1' }], 'linux')).toEqual({ PATH: '/bin', HOME: '/h', XDG_DATA_HOME: '/x', LC_ALL: 'C', LANG: 'C', SystemRoot: 'C:\\W', TMPDIR: '/t', A: '1' });
    expect(buildEnvironment({ Path: 'C:\\x', SYSTEMROOT: 'C:\\W', Secret: 's', lc_ctype: 'x' }, [{ name: 'PATH', value: 'C:\\y' }], 'win32')).toEqual({ SYSTEMROOT: 'C:\\W', lc_ctype: 'x', PATH: 'C:\\y' });
    for (const bad of [{ name: '', value: 'x' }, { name: 'A=B', value: 'x' }, { name: 'A\0', value: 'x' }, { name: 'A', value: 'x\0' }]) {
      expect(() => buildEnvironment({}, [bad], 'linux')).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    }
  });

  it('runs in the requested cwd', async () => {
    await mkdir(join(root, 'sub'));
    const id = await run(['-e', 'process.stdout.write(require("fs").realpathSync(process.cwd()))'], { cwd: join(root, 'sub') });
    expect((await finish(id)).output).toBe(join(root, 'sub'));
  });

  it('rejects bad requests and unknown commands', async () => {
    await expectCode(host.createTerminal(root, { command: '', cwd: root }, { taskId: newTask(), signal: signal() }), 'INVALID_REQUEST');
    await expectCode(host.createTerminal(root, { command: node, args: ['a\0'], cwd: root }, { taskId: newTask(), signal: signal() }), 'INVALID_REQUEST');
    await expectCode(host.createTerminal(root, { command: node, outputByteLimit: -1, cwd: root }, { taskId: newTask(), signal: signal() }), 'INVALID_REQUEST');
    await expectCode(host.createTerminal(root, { command: 'definitely-not-a-real-command-xyz', cwd: root }, { taskId: newTask(), signal: signal() }), 'NOT_FOUND');
    await expectCode(host.createTerminal(root, { command: join(root, 'missing-binary'), cwd: root }, { taskId: newTask(), signal: signal() }), 'NOT_FOUND');
    const aborted = new AbortController();
    aborted.abort();
    await expectCode(run(['-e', ''], { signal: aborted.signal }), 'ABORTED');
  });

  it('unknown terminal ids give TERMINAL_NOT_FOUND', async () => {
    await expectCode(host.terminalOutput('nope'), 'TERMINAL_NOT_FOUND');
    await expectCode(host.waitForTerminalExit('nope', signal()), 'TERMINAL_NOT_FOUND');
    await expectCode(host.killTerminal('nope'), 'TERMINAL_NOT_FOUND');
    await expectCode(host.releaseTerminal('nope'), 'TERMINAL_NOT_FOUND');
    const id = await run(['-e', '']);
    await host.releaseTerminal(id);
    await expectCode(host.terminalOutput(id), 'TERMINAL_NOT_FOUND');
    await expectCode(host.releaseTerminal(id), 'TERMINAL_NOT_FOUND');
  });
});

describe('command resolution', () => {
  it('finds commands on the PATH of the host env and never in the cwd', async () => {
    const pathHost = createWorkspaceHost({ baseEnv: { PATH: dirname(node) } });
    try {
      const id = await pathHost.createTerminal(root, { command: 'node', args: ['-e', 'process.stdout.write("via-path")'], cwd: root }, { taskId: newTask(), signal: signal() });
      await pathHost.waitForTerminalExit(id, signal());
      expect((await pathHost.terminalOutput(id)).output).toBe('via-path');
      const name = process.platform === 'win32' ? 'planted.cmd' : 'planted';
      await writeFile(join(root, name), process.platform === 'win32' ? '@echo planted\r\n' : '#!/bin/sh\necho planted\n');
      await chmod(join(root, name), 0o755);
      await expectCode(pathHost.createTerminal(root, { command: 'planted', cwd: root }, { taskId: newTask(), signal: signal() }), 'NOT_FOUND');
      await expectCode(pathHost.createTerminal(root, { command: 'planted', cwd: root, env: [{ name: 'PATH', value: '' }] }, { taskId: newTask(), signal: signal() }), 'NOT_FOUND');
    } finally { await pathHost.close(); }
  });

  it('request PATH is used for resolution', async () => {
    const bin = join(root, 'bin');
    await mkdir(bin);
    const name = process.platform === 'win32' ? 'mytool.cmd' : 'mytool';
    await writeFile(join(bin, name), process.platform === 'win32' ? '@echo off\r\necho tool-ran\r\n' : '#!/bin/sh\necho tool-ran\n');
    await chmod(join(bin, name), 0o755);
    const id = await host.createTerminal(root, { command: 'mytool', cwd: root, env: [{ name: 'PATH', value: [bin, process.env.PATH ?? ''].join(delimiter) }] }, { taskId: newTask(), signal: signal() });
    const result = await finish(id);
    expect(result.output).toContain('tool-ran');
    expect(result.status.exitCode).toBe(0);
  });

  if (process.platform === 'win32') {
    it('runs .cmd files through cmd.exe with hostile arguments and no injection', async () => {
      const dir = join(root, 'my tools');
      await mkdir(dir);
      await writeFile(join(dir, 'print.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
      await writeFile(join(dir, 'show.cmd'), `@echo off\r\n"${node}" "%~dp0print.js" %*\r\n`);
      const hostile = ['a b', 'x" & echo PWNED>marker.txt & "y', '&echo PWNED>marker.txt', '%PATH%', 'trail\\', '^&', '(x)'];
      const id = await host.createTerminal(root, { command: 'show', args: hostile, cwd: root, env: [{ name: 'PATH', value: dir }, { name: 'PATHEXT', value: '.EXE;.CMD' }] }, { taskId: newTask(), signal: signal() });
      const result = await finish(id);
      expect(JSON.parse(result.output)).toEqual(hostile);
      expect(existsSync(join(root, 'marker.txt'))).toBe(false);
    });
  }
});

describe('cwd confinement', () => {
  it('rejects cwd outside the root, via links, missing, files and relative paths', async () => {
    const outside = await makeTemp('ybout-');
    await linkDir(outside, join(root, 'escape'));
    await writeFile(join(root, 'file.txt'), 'x');
    await expectCode(run(['-e', ''], { cwd: outside }), 'OUTSIDE_WORKSPACE');
    await expectCode(run(['-e', ''], { cwd: join(root, '..') }), 'OUTSIDE_WORKSPACE');
    await expectCode(run(['-e', ''], { cwd: join(root, 'escape') }), 'OUTSIDE_WORKSPACE');
    await expectCode(run(['-e', ''], { cwd: join(root, 'missing') }), 'NOT_FOUND');
    await expectCode(run(['-e', ''], { cwd: join(root, 'file.txt') }), 'INVALID_REQUEST');
    await expectCode(run(['-e', ''], { cwd: 'sub' }), 'INVALID_REQUEST');
  });
});

describe('output limits', () => {
  it('truncates from the start on a multibyte boundary and flags it', async () => {
    for (const [unit, limit] of [['\u00e9', 1001], ['\u4e2d', 1000], ['\u{1f600}', 1001]] as const) {
      const id = await run(['-e', `process.stdout.write(${JSON.stringify(unit)}.repeat(5000))`], { outputByteLimit: limit });
      const result = await finish(id);
      expect(result.truncated).toBe(true);
      expect(result.output.includes('\ufffd')).toBe(false);
      expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(limit);
      expect(Buffer.byteLength(result.output)).toBeGreaterThan(limit - 4);
      expect([...result.output].every(character => character === unit)).toBe(true);
      await host.releaseTerminal(id);
    }
  });

  it('keeps the tail of the output', async () => {
    const id = await run(['-e', 'process.stdout.write("A".repeat(5000) + "THE-END")'], { outputByteLimit: 100 });
    const result = await finish(id);
    expect(result.truncated).toBe(true);
    expect(result.output.endsWith('THE-END')).toBe(true);
    expect(result.output.length).toBe(100);
  });

  it('defaults to 1 MiB', async () => {
    const id = await run(['-e', 'process.stdout.write("x".repeat(3 * 1024 * 1024))']);
    const result = await finish(id);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBe(1024 * 1024);
  });
});

describe('process control', () => {
  it('kill reports SIGKILL', async () => {
    const id = await run(['-e', LONG]);
    await host.killTerminal(id);
    const status = await host.waitForTerminalExit(id, signal());
    expect(status).toEqual({ exitCode: null, signal: 'SIGKILL' });
    expect((await host.terminalOutput(id)).exitStatus).toEqual(status);
  });

  if (process.platform !== 'win32') {
    it('reports the signal name when the process kills itself', async () => {
      const id = await run(['-e', 'process.kill(process.pid, "SIGTERM"); setInterval(() => {}, 1000)']);
      expect((await finish(id)).status).toEqual({ exitCode: null, signal: 'SIGTERM' });
    });
  }

  it('killTerminal kills the whole tree (grandchild dies)', async () => {
    const { id, pid } = await startTree();
    await host.killTerminal(id);
    await waitFor(() => !pidAlive(pid));
    await host.releaseTerminal(id);
  });

  it('releaseTerminal kills a running tree and frees the id', async () => {
    const { id, pid } = await startTree();
    await host.releaseTerminal(id);
    await waitFor(() => !pidAlive(pid));
    await expectCode(host.terminalOutput(id), 'TERMINAL_NOT_FOUND');
  });

  it('releaseTask kills and frees every terminal of that task only', async () => {
    const taskId = newTask();
    const a = await startTree(taskId);
    const b = await startTree(taskId);
    const other = await startTree();
    await host.releaseTask(taskId);
    await waitFor(() => !pidAlive(a.pid) && !pidAlive(b.pid));
    await expectCode(host.terminalOutput(a.id), 'TERMINAL_NOT_FOUND');
    await expectCode(host.terminalOutput(b.id), 'TERMINAL_NOT_FOUND');
    expect(pidAlive(other.pid)).toBe(true);
    expect((await host.terminalOutput(other.id)).exitStatus).toBeUndefined();
    await host.releaseTask('task-without-terminals');
  });

  it('aborting the task signal kills the tree', async () => {
    const controller = new AbortController();
    const { id, pid } = await startTree(newTask(), controller.signal);
    controller.abort();
    await waitFor(() => !pidAlive(pid));
    const status = await host.waitForTerminalExit(id, signal());
    expect(status.exitCode === 0).toBe(false);
  });

  it('aborting a wait rejects the wait but leaves the terminal running', async () => {
    const id = await run(['-e', LONG]);
    const controller = new AbortController();
    const waiting = host.waitForTerminalExit(id, controller.signal);
    controller.abort();
    await expectCode(waiting, 'ABORTED');
    expect((await host.terminalOutput(id)).exitStatus).toBeUndefined();
  });

  it('close kills every terminal and refuses new ones', async () => {
    const a = await startTree();
    const b = await startTree();
    await host.close();
    await waitFor(() => !pidAlive(a.pid) && !pidAlive(b.pid));
    await expectCode(run(['-e', '']), 'INVALID_REQUEST');
  });

  if (process.platform !== 'win32') {
    it('release also kills orphans left in the group after the leader exited', async () => {
      const id = await run(['-e', `
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, ['-e', ${JSON.stringify(LONG)}], { stdio: 'ignore' });
        child.unref();
        process.stdout.write('GRANDCHILD ' + child.pid + '\\n');
      `]);
      const result = await finish(id);
      const pid = Number(/GRANDCHILD (\d+)/.exec(result.output)![1]);
      expect(pidAlive(pid)).toBe(true);
      await host.releaseTerminal(id);
      await waitFor(() => !pidAlive(pid));
    });
  }

  it('a background process holding the pipes open does not block exit detection', async () => {
    const started = Date.now();
    const id = await run(['-e', `
      const { spawn } = require('child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(LONG)}], { stdio: ['ignore', 'inherit', 'inherit'] });
      child.unref();
      process.stdout.write('GRANDCHILD ' + child.pid + '\\n');
    `]);
    const result = await finish(id);
    expect(result.status.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(/GRANDCHILD (\d+)/.exec(result.output)![1]);
    if (process.platform !== 'win32') await host.releaseTerminal(id);
    else try { process.kill(pid); } catch { /* already gone */ } // Windows cannot reach orphans after the leader exits (see README)
    await waitFor(() => !pidAlive(pid));
  });
});

describe('terminal limits', () => {
  it('allows 16 running terminals per task, then LIMIT_EXCEEDED; other tasks and released slots are free', async () => {
    const taskId = newTask();
    const ids: string[] = [];
    for (let i = 0; i < 16; i++) ids.push(await run(['-e', LONG], { taskId }));
    await expectCode(run(['-e', LONG], { taskId }), 'LIMIT_EXCEEDED');
    const other = await run(['-e', LONG], { taskId: newTask() });
    await host.releaseTerminal(ids[0]!);
    ids[0] = await run(['-e', LONG], { taskId });
    await expectCode(run(['-e', LONG], { taskId }), 'LIMIT_EXCEEDED');
    await host.releaseTask(taskId);
    await host.releaseTerminal(other);
    await run(['-e', LONG], { taskId });
  }, 60000);
});
