import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import type { AnyCommandResult, CommandPayloadV2, CommandResultV2 } from '@your-bot/contracts';

export const trustedFixture = fileURLToPath(new URL('./fixtures/trusted-workspace-agent.mjs', import.meta.url));

const directories: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

export async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  directories.push(dir);
  return dir;
}

export function onCleanup(close: () => Promise<void> | void): void {
  closers.push(close);
}

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await Promise.resolve(close()).catch(() => undefined);
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

let nextCommand = 0;
export function command<T extends CommandPayloadV2>(payload: T) {
  return { ...payload, version: 2 as const, id: `v2-${++nextCommand}` };
}

export function ok(result: AnyCommandResult): asserts result is Extract<CommandResultV2, { ok: true }> {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
}

export async function waitFor(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
