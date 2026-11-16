import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { onCleanup, tempDir, waitFor } from './v2-helpers.js';
/** POSIX permission bits; Windows has none (ACLs instead), so compare as equal there. */
const posixMode = (mode: number): number => (process.platform === 'win32' ? 0 : mode & 0o777);

const bin = fileURLToPath(new URL('../apps/host/dist/bin.js', import.meta.url));

function capture(child: ChildProcess): { stdout(): string; stderr(): string } {
  let out = '';
  let err = '';
  child.stdout?.on('data', chunk => { out += String(chunk); });
  child.stderr?.on('data', chunk => { err += String(chunk); });
  return { stdout: () => out, stderr: () => err };
}

function runHost(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const text = capture(child);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 1, stdout: text.stdout(), stderr: text.stderr() }));
  });
}

function frames(endpoint: string, messages: unknown[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    const lines: string[] = [];
    let buffer = '';
    const timer = setTimeout(() => { socket.destroy(); resolve(lines); }, 3_000);
    socket.on('data', chunk => {
      buffer += String(chunk);
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        lines.push(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('connect', () => { for (const message of messages) socket.write(`${JSON.stringify(message)}\n`); });
    socket.on('close', () => { clearTimeout(timer); resolve(lines); });
  });
}

const evilBot = {
  name: 'Nope', instructions: '', agentId: 'missing', profile: 'strict', mcpServers: [], skills: [], memoryEnabled: false,
};

describe('owner control channel', () => {
  it('rejects a missing or wrong token and accepts the owner token', async () => {
    const dataDir = await tempDir('your-bot-v2-ctl-');
    const init = await runHost(['init', '--data', dataDir, '--name', 'bench']);
    expect(init.code, init.stderr).toBe(0);
    const secret = (await readFile(join(dataDir, 'control.token'), 'utf8')).trim();
    expect(init.stdout).not.toContain(secret);
    const child = spawn(process.execPath, [bin, 'run', '--data', dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    const text = capture(child);
    onCleanup(async () => {
      if (child.exitCode !== null || child.signalCode) return;
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    });
    await waitFor(() => text.stdout().includes('\ncontrol ') || text.stdout().startsWith('control '), 'control socket', 20_000);
    expect(child.exitCode, text.stderr()).toBeNull();
    const endpoint = text.stdout().split('\n').find(line => line.startsWith('control '))?.slice('control '.length);
    expect(endpoint).toBeTruthy();
    expect(text.stdout()).not.toContain(secret);
    expect(text.stderr()).not.toContain(secret);
    if (process.platform !== 'win32') {
      expect(posixMode((await stat(dataDir)).mode)).toBe(posixMode(0o700));
      expect(posixMode((await stat(join(dataDir, 'control.token'))).mode)).toBe(posixMode(0o600));
      expect(posixMode((await stat(endpoint!)).mode)).toBe(posixMode(0o600));
    }
    const wrong = await frames(endpoint!, [{ token: 'not-the-owner-token-value-xxxx' }, { version: 2, id: 'evil', type: 'bot.create', bot: evilBot }]);
    expect(wrong.some(line => line.includes('UNAUTHORIZED'))).toBe(true);
    expect(wrong.some(line => line.includes('"ok":true'))).toBe(false);
    const missing = await frames(endpoint!, [{ version: 2, id: 'evil', type: 'bot.create', bot: evilBot }]);
    expect(missing.some(line => line.includes('UNAUTHORIZED'))).toBe(true);
    const ctl = await runHost(['ctl', '--data', dataDir, JSON.stringify({ type: 'state.sync' })]);
    expect(ctl.code, `${ctl.stderr}\n${ctl.stdout}`).toBe(0);
    const synced = JSON.parse(ctl.stdout) as { ok?: boolean; snapshot?: { bots?: unknown[] } };
    expect(synced.ok).toBe(true);
    expect(synced.snapshot?.bots ?? []).toEqual([]);
    child.kill('SIGTERM');
    await waitFor(() => child.exitCode !== null, 'host exit', 15_000);
    if (process.platform !== 'win32') await expect(stat(endpoint!)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
