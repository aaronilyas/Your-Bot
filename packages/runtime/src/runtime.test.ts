import { lstat, mkdir, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRuntime, LOCAL_OWNER_CAPABILITIES } from './index.js';
/** POSIX permission bits; Windows has none (ACLs instead), so compare as equal there. */
const posixMode = (mode: number): number => (process.platform === 'win32' ? 0 : mode & 0o777);

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'your-bot-runtime-')));
  directories.push(dir);
  return dir;
}

describe('createRuntime', () => {
  it('lays out a private data directory, persists the host id, and keeps the key out of the database directory', async () => {
    const dataDir = await tempDir();
    const runtime = await createRuntime({ dataDir, hostName: 'bench' });
    directories.push(runtime.dataDir);
    expect(runtime.principal.capabilities).toEqual(LOCAL_OWNER_CAPABILITIES);
    expect(runtime.principal.capabilities).toContain('mcp.call');
    expect(runtime.host).toEqual({ id: expect.any(String), name: 'bench' });
    if (process.platform !== 'win32') {
      expect(posixMode((await stat(runtime.dataDir)).mode)).toBe(posixMode(0o700));
      expect(posixMode((await stat(join(runtime.dataDir, 'host.json'))).mode)).toBe(posixMode(0o600));
      expect(posixMode((await stat(join(runtime.dataDir, 'keys', 'secret.key'))).mode)).toBe(posixMode(0o600));
      expect(posixMode((await stat(join(runtime.dataDir, 'mcp', 'browser'))).mode)).toBe(posixMode(0o700));
    }
    expect(join(runtime.dataDir, 'keys', 'secret.key').includes(`${join('gateway', 'secret')}`)).toBe(false);
    const sync = await runtime.gateway.dispatch({ version: 2, id: 'sync', type: 'state.sync' }, runtime.principal);
    expect(sync).toMatchObject({ ok: true, snapshot: { host: runtime.host } });
    expect(await runtime.gateway.dispatch({ version: 2, id: 'devices', type: 'device.list' }, runtime.principal)).toMatchObject({ ok: false, error: { code: 'NOT_SUPPORTED' } });
    const id = runtime.host.id;
    await runtime.close();
    await runtime.close();
    const again = await createRuntime({ dataDir: runtime.dataDir });
    expect(again.host.id).toBe(id);
    expect(again.host.name).toBe('bench');
    await again.close();
  });

  it('refuses a symlinked data directory', async () => {
    const root = await tempDir();
    const real = join(root, 'real');
    const link = join(root, 'link');
    await mkdir(real);
    await symlink(real, link);
    await expect(createRuntime({ dataDir: link })).rejects.toThrow(/symlink/i);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });
});
