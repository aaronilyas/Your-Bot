import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunContextV2, AgentUpdate, TerminalExitStatus, TerminalOutput, WorkspaceHostChannel } from '@your-bot/contracts';
import { AcpAdapter, HostLauncher } from '../src/index.js';

/**
 * Opt-in. YOUR_BOT_REAL_AGENT=grok uses `grok agent stdio`.
 * YOUR_BOT_REAL_AGENT=claude uses `npx -y @agentclientprotocol/claude-agent-acp`.
 * The agent process is uncontained. File and terminal requests are served here.
 */
const realAgent = process.env.YOUR_BOT_REAL_AGENT;
const enabled = realAgent === 'grok' || realAgent === 'claude';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function memoryState() {
  let value: import('@your-bot/contracts').JsonValue | undefined;
  return { get: async () => value, set: async (next: import('@your-bot/contracts').JsonValue) => { value = next; }, clear: async () => { value = undefined; } };
}

function coded(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function canExecute(file: string): boolean {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
}

function contained(rootReal: string, real: string): boolean {
  const relative = path.relative(rootReal, real);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Workspace root or a path inside it. The root itself is a valid terminal cwd. */
async function inside(root: string, requested: string): Promise<string> {
  const rootReal = await realpath(root);
  let current = path.resolve(rootReal, requested);
  const missing: string[] = [];
  while (true) {
    try {
      const real = await realpath(current);
      if (!contained(rootReal, real)) throw coded('OUTSIDE_WORKSPACE');
      if (missing.some(part => part === '.' || part === '..')) throw coded('OUTSIDE_WORKSPACE');
      return path.join(real, ...missing.reverse());
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'OUTSIDE_WORKSPACE') throw error;
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
      const base = path.basename(current);
      const parent = path.dirname(current);
      if (!base || parent === current) throw coded('OUTSIDE_WORKSPACE');
      missing.push(base);
      current = parent;
    }
  }
}

function sliceText(content: string, line?: number, limit?: number): string {
  if (line === undefined && limit === undefined) return content;
  const lines = content.split(/\r?\n/);
  const start = Math.max(0, (line ?? 1) - 1);
  return lines.slice(start, limit === undefined ? undefined : start + limit).join('\n');
}

/** Minimal in-test channel. Core would authorize; this test allows what it resolves inside the workspace. */
function testHost(root: string, calls: string[]): WorkspaceHostChannel {
  const terminals = new Map<string, { output: string; truncated: boolean; status?: TerminalExitStatus; done: Promise<void>; kill: () => void }>();
  let sequence = 0;
  const killTree = (child: ChildProcess) => {
    const pid = child.pid;
    if (!pid) return;
    if (process.platform === 'win32') {
      spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(pid)], { shell: false, windowsHide: true, stdio: 'ignore' });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    }
  };
  return {
    async readTextFile(request) {
      calls.push(`read ${request.path}`);
      const target = await inside(root, request.path);
      try { return { content: sliceText(await readFile(target, 'utf8'), request.line, request.limit) }; }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'OUTSIDE_WORKSPACE') throw error;
        throw coded('NOT_FOUND');
      }
    },
    async writeTextFile(request) {
      calls.push(`write ${request.path}`);
      const target = await inside(root, request.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, request.content, 'utf8');
    },
    async createTerminal(request) {
      calls.push(`terminal ${request.command}`);
      const cwd = request.cwd ? await inside(root, request.cwd) : await realpath(root);
      const limit = request.outputByteLimit ?? 1_048_576;
      const args = request.args ?? [];
      // ACP's command is an executable. Grok sends one shell command line and no args.
      const direct = args.length > 0 || !/[\s"]/.test(request.command);
      let command = request.command;
      let commandArgs = args;
      if (!direct || !canExecute(command)) {
        if (process.platform === 'win32') {
          command = process.env.ComSpec || 'cmd.exe';
          commandArgs = ['/d', '/s', '/c', [request.command, ...args].join(' ')];
        } else {
          command = '/bin/sh';
          commandArgs = ['-c', [request.command, ...args].join(' ')];
        }
      }
      const child = spawn(command, commandArgs, {
        cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32',
        env: { ...process.env, ...Object.fromEntries((request.env ?? []).map(item => [item.name, item.value])) },
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(process.platform === 'win32' && command !== request.command ? { windowsVerbatimArguments: true } : {}),
      });
      const id = `term-${++sequence}`;
      const slot: { output: string; truncated: boolean; status?: TerminalExitStatus; done: Promise<void>; kill: () => void } = {
        output: '', truncated: false, done: Promise.resolve(), kill: () => killTree(child),
      };
      const push = (chunk: Buffer) => {
        if (slot.truncated) return;
        slot.output += chunk.toString('utf8');
        if (Buffer.byteLength(slot.output) > limit) { slot.output = slot.output.slice(0, limit); slot.truncated = true; }
      };
      child.stdout.on('data', push);
      child.stderr.on('data', push);
      slot.done = new Promise<void>(resolve => {
        child.once('exit', (code, signal) => { slot.status = { exitCode: code, signal }; resolve(); });
        child.once('error', () => resolve());
      });
      terminals.set(id, slot);
      return { terminalId: id };
    },
    async terminalOutput(terminalId): Promise<TerminalOutput> {
      calls.push(`output ${terminalId}`);
      const slot = terminals.get(terminalId);
      if (!slot) throw coded('TERMINAL_NOT_FOUND');
      return { output: slot.output, truncated: slot.truncated, ...(slot.status ? { exitStatus: slot.status } : {}) };
    },
    async waitForTerminalExit(terminalId) {
      calls.push(`wait ${terminalId}`);
      const slot = terminals.get(terminalId);
      if (!slot) throw coded('TERMINAL_NOT_FOUND');
      await slot.done;
      return slot.status ?? { exitCode: null, signal: null };
    },
    async killTerminal(terminalId) {
      calls.push(`kill ${terminalId}`);
      const slot = terminals.get(terminalId);
      if (!slot) throw coded('TERMINAL_NOT_FOUND');
      slot.kill();
    },
    async releaseTerminal(terminalId) {
      calls.push(`release ${terminalId}`);
      const slot = terminals.get(terminalId);
      if (!slot) return;
      slot.kill();
      terminals.delete(terminalId);
    },
  };
}

describe('opt-in real ACP agent', () => {
  it.skipIf(!enabled)(`creates a file and runs a command via ${realAgent ?? 'an unset agent'}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'your-bot-real-agent-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const marker = `proof-${randomBytes(8).toString('hex')}`;
    const calls: string[] = [];
    const proof = 'your-bot-proof.txt';
    const commandProof = 'your-bot-command.txt';
    const nodeProgram = `require('fs').writeFileSync(${JSON.stringify(commandProof)}, process.argv[1])`;
    const command = realAgent === 'grok' ? 'grok' : 'npx';
    const args = realAgent === 'grok'
      ? ['agent', 'stdio']
      : ['-y', '@agentclientprotocol/claude-agent-acp'];
    const adapter = new AcpAdapter({
      id: 'real', name: 'Real', kind: 'acp', enabled: true, command, args,
    }, { host: new HostLauncher(), timeoutMs: 180_000 });
    cleanup.push(() => adapter.close());
    const updates: AgentUpdate[] = [];
    const approvals: unknown[] = [];
    const context: AgentRunContextV2 = {
      taskId: 'real-task',
      session: {
        id: 'real-session', agentId: 'real', title: 'Real', createdAt: '', updatedAt: '',
        messages: [{
          id: 'm1', role: 'user', createdAt: '',
          content: [
            `Write a file named ${proof} in the workspace whose exact contents are ${marker}.`,
            `Then run this command and wait until it exits: ${process.execPath} -e ${JSON.stringify(nodeProgram)} ${marker}`,
            'Prefer the client filesystem and client terminal tools. Do not ask questions.',
          ].join('\n'),
        }],
      },
      principal: { id: 'owner', kind: 'local', capabilities: ['conversation', 'tool.execute', 'file.read', 'file.write', 'process.spawn'] },
      signal: new AbortController().signal,
      emit: update => updates.push(update),
      executeTool: vi.fn(async () => ({ ok: true, value: null })),
      requestPermission: async request => { approvals.push(request); return { requestId: 'allow', outcome: 'allow', scope: 'once' }; },
      profile: 'trusted',
      workspace: root,
      instructions: 'Follow the latest user message exactly and finish.',
      host: testHost(root, calls),
      state: memoryState(),
    };
    try { await adapter.run(context); }
    catch (error) {
      throw new Error(`${error instanceof Error ? error.message : 'real agent failed'} calls=${calls.join('|')} approvals=${approvals.length} text=${updates.filter(update => update.type === 'text').map(update => update.type === 'text' ? update.text : '').join('').slice(0, 500)}`, { cause: error });
    }
    expect(await readFile(path.join(root, proof), 'utf8'), calls.join('|')).toBe(marker);
    expect(await readFile(path.join(root, commandProof), 'utf8'), calls.join('|')).toContain(marker);
  }, 180_000);
});
