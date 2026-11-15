import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];

/** Canonical (realpath) temp directory; removed by `cleanupTemp`. */
export async function makeTemp(prefix = 'ybws-'): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

export async function cleanupTemp(): Promise<void> {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
}

/** Directory link: symlink on POSIX, junction on Windows (no privilege needed). */
export async function linkDir(target: string, link: string): Promise<void> {
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/** File symlink; returns false when the platform/user may not create one (Windows without privilege). */
export async function linkFile(target: string, link: string): Promise<boolean> {
  try { await symlink(target, link, 'file'); return true; } catch (error) {
    if (process.platform === 'win32' && (error as { code?: string }).code === 'EPERM') return false;
    throw error;
  }
}

export async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try { await promise; } catch (error) {
    const actual = (error as { code?: string }).code;
    if (actual !== code) throw new Error(`expected error code ${code}, got ${actual}: ${(error as Error).message}`);
    return;
  }
  throw new Error(`expected rejection with ${code}, but it resolved`);
}

export const signal = () => new AbortController().signal;

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: string }).code === 'EPERM'; }
}

export { writeFile };
