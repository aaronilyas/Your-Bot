import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, link, mkdir, readdir, readFile, rename, rm, stat, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkspaceHost } from './index.js';
import { sliceLines } from './files.js';
import { cleanupTemp, expectCode, linkDir, linkFile, makeTemp, signal } from './test-support.js';

afterEach(cleanupTemp);

async function setup() {
  const base = await makeTemp();
  const root = join(base, 'ws');
  const outside = join(base, 'outside');
  await mkdir(root); await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'SECRET');
  return { base, root, outside, host: createWorkspaceHost() };
}

describe('sliceLines', () => {
  const text = 'a\nb\r\nc\nd';
  it('slices by 1-based line and limit, keeping terminators', () => {
    expect(sliceLines(text)).toBe(text);
    expect(sliceLines(text, 2, 2)).toBe('b\r\nc\n');
    expect(sliceLines(text, 3)).toBe('c\nd');
    expect(sliceLines(text, undefined, 1)).toBe('a\n');
    expect(sliceLines(text, 4, 10)).toBe('d');
    expect(sliceLines(text, 5, 1)).toBe('');
    expect(sliceLines(text, 1, 0)).toBe('');
    expect(sliceLines('a\n', 2)).toBe('');
    expect(sliceLines('', 1, 5)).toBe('');
  });
});

describe('readTextFile', () => {
  it('reads UTF-8 (BOM and invalid bytes do not throw) with line/limit slicing', async () => {
    const { root, host } = await setup();
    await writeFile(join(root, 'a.txt'), 'one\ntwo é中\nthree\nfour\n');
    const path = await host.resolve(root, 'a.txt');
    expect(await host.readTextFile(root, path, { signal: signal() })).toBe('one\ntwo é中\nthree\nfour\n');
    expect(await host.readTextFile(root, path, { line: 2, limit: 2, signal: signal() })).toBe('two é中\nthree\n');
    expect(await host.readTextFile(root, path, { line: 4, signal: signal() })).toBe('four\n');
    await expectCode(host.readTextFile(root, path, { line: 0, signal: signal() }), 'INVALID_REQUEST');
    await expectCode(host.readTextFile(root, path, { limit: -1, signal: signal() }), 'INVALID_REQUEST');
    await writeFile(join(root, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x'), Buffer.from([0xff])]));
    expect(await host.readTextFile(root, await host.resolve(root, 'bom.txt'), { signal: signal() })).toBe('﻿x�');
  });

  it('enforces the 10 MiB limit exactly', async () => {
    const { root, host } = await setup();
    await writeFile(join(root, 'ok.txt'), Buffer.alloc(10 * 1024 * 1024, 0x61));
    await writeFile(join(root, 'big.txt'), Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
    expect((await host.readTextFile(root, await host.resolve(root, 'ok.txt'), { signal: signal() })).length).toBe(10 * 1024 * 1024);
    await expectCode(host.readTextFile(root, await host.resolve(root, 'big.txt'), { signal: signal() }), 'LIMIT_EXCEEDED');
  });

  it('reports missing files, directories and non-canonical input', async () => {
    const { root, host } = await setup();
    await mkdir(join(root, 'dir'));
    await writeFile(join(root, 'f.txt'), 'x');
    await expectCode(host.readTextFile(root, join(root, 'nope.txt'), { signal: signal() }), 'NOT_FOUND');
    await expectCode(host.readTextFile(root, join(root, 'dir'), { signal: signal() }), 'INVALID_REQUEST');
    await expectCode(host.readTextFile(root, 'f.txt', { signal: signal() }), 'INVALID_REQUEST');
    await expectCode(host.readTextFile(root, join(root, '..', 'outside', 'secret.txt'), { signal: signal() }), 'OUTSIDE_WORKSPACE');
  });

  it('honours an aborted signal', async () => {
    const { root, host } = await setup();
    await writeFile(join(root, 'f.txt'), 'x');
    const controller = new AbortController();
    controller.abort();
    await expectCode(host.readTextFile(root, join(root, 'f.txt'), { signal: controller.signal }), 'ABORTED');
  });

  if (process.platform !== 'win32') {
    it('does not hang on a FIFO planted in the workspace', async () => {
      const { root, host } = await setup();
      expect(spawnSync('mkfifo', [join(root, 'pipe')]).status).toBe(0);
      await expectCode(host.readTextFile(root, join(root, 'pipe'), { signal: signal() }), 'INVALID_REQUEST');
    });
  }

  it('refuses a file that was replaced by a link to an outside file after resolve', async () => {
    const { root, outside, host } = await setup();
    await writeFile(join(root, 'f.txt'), 'inside');
    const path = await host.resolve(root, 'f.txt');
    await unlink(path);
    if (await linkFile(join(outside, 'secret.txt'), path)) {
      await expectCode(host.readTextFile(root, path, { signal: signal() }), 'OUTSIDE_WORKSPACE');
    }
  });

  it('refuses a directory that was swapped for a link to the outside after resolve', async () => {
    const { root, outside, host } = await setup();
    await mkdir(join(root, 'd'));
    await writeFile(join(root, 'd', 'secret.txt'), 'inside');
    const path = await host.resolve(root, 'd/secret.txt');
    await rename(join(root, 'd'), join(root, 'd.bak'));
    await linkDir(outside, join(root, 'd'));
    await expectCode(host.readTextFile(root, path, { signal: signal() }), 'OUTSIDE_WORKSPACE');
  });
});

describe('writeTextFile', () => {
  it('creates and atomically replaces files, leaving no temp files', async () => {
    const { root, host } = await setup();
    const path = await host.resolve(root, 'new.txt');
    await host.writeTextFile(root, path, 'v1 é', { signal: signal() });
    expect(await readFile(path, 'utf8')).toBe('v1 é');
    await host.writeTextFile(root, path, 'v2', { signal: signal() });
    expect(await readFile(path, 'utf8')).toBe('v2');
    expect(await readdir(root)).toEqual(['new.txt']);
    await host.writeTextFile(root, path, '', { signal: signal() });
    expect(await readFile(path, 'utf8')).toBe('');
  });

  it('is atomic: concurrent readers only ever see a complete old or new version', async () => {
    const { root, host } = await setup();
    const a = 'A'.repeat(3_000_000);
    const b = 'B'.repeat(3_000_000);
    const path = await host.resolve(root, 'big.txt');
    await host.writeTextFile(root, path, a, { signal: signal() });
    let stop = false;
    const seen = new Set<string>();
    const reader = (async () => {
      while (!stop) {
        const content = await readFile(path, 'utf8').catch(() => undefined); // Windows may briefly deny/miss during a replace
        if (content !== undefined) seen.add(content === a ? 'a' : content === b ? 'b' : `torn:${content.length}`);
        await new Promise(resolve => setTimeout(resolve, 3)); // give a Windows rename a gap between opens
      }
    })();
    try {
      for (let i = 0; i < 8; i++) await host.writeTextFile(root, path, i % 2 === 0 ? b : a, { signal: signal() });
    } finally {
      stop = true;
      await reader;
    }
    expect([...seen].filter(value => value.startsWith('torn'))).toEqual([]);
  });

  if (process.platform !== 'win32') {
    it('keeps the mode of an existing file', async () => {
      const { root, host } = await setup();
      await writeFile(join(root, 'run.sh'), '#!/bin/sh\n');
      await chmod(join(root, 'run.sh'), 0o750);
      await host.writeTextFile(root, await host.resolve(root, 'run.sh'), '#!/bin/sh\necho hi\n', { signal: signal() });
      expect((await stat(join(root, 'run.sh'))).mode & 0o777).toBe(0o750);
    });
  }

  it('rejects directories, missing parents, escapes and non-canonical paths', async () => {
    const { root, outside, host } = await setup();
    await mkdir(join(root, 'dir'));
    await expectCode(host.writeTextFile(root, join(root, 'dir'), 'x', { signal: signal() }), 'INVALID_REQUEST');
    await expectCode(host.writeTextFile(root, root, 'x', { signal: signal() }), 'INVALID_REQUEST');
    await expectCode(host.writeTextFile(root, join(root, 'missing', 'f.txt'), 'x', { signal: signal() }), 'NOT_FOUND');
    await expectCode(host.writeTextFile(root, join(outside, 'x.txt'), 'x', { signal: signal() }), 'OUTSIDE_WORKSPACE');
    await expectCode(host.writeTextFile(root, 'relative.txt', 'x', { signal: signal() }), 'INVALID_REQUEST');
    expect(await readdir(outside)).toEqual(['secret.txt']);
  });

  it('never writes through a link: a swapped-in directory link is refused', async () => {
    const { root, outside, host } = await setup();
    await mkdir(join(root, 'd'));
    const path = await host.resolve(root, 'd/out.txt');
    await rename(join(root, 'd'), join(root, 'd.bak'));
    await linkDir(outside, join(root, 'd'));
    await expectCode(host.writeTextFile(root, path, 'PWNED', { signal: signal() }), 'OUTSIDE_WORKSPACE');
    expect(await readdir(outside)).toEqual(['secret.txt']);
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('SECRET');
  });

  it('never writes through a link: an existing file swapped for a link to an outside file', async () => {
    const { root, outside, host } = await setup();
    await writeFile(join(root, 'f.txt'), 'inside');
    const path = await host.resolve(root, 'f.txt');
    await unlink(path);
    if (await linkFile(join(outside, 'secret.txt'), path)) {
      await expectCode(host.writeTextFile(root, path, 'PWNED', { signal: signal() }), 'OUTSIDE_WORKSPACE');
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('SECRET');
    }
  });

  it('replaces (not follows) a hardlink, so the outside inode is untouched', async () => {
    const { root, outside, host } = await setup();
    await link(join(outside, 'secret.txt'), join(root, 'hard.txt'));
    await host.writeTextFile(root, await host.resolve(root, 'hard.txt'), 'NEW', { signal: signal() });
    expect(await readFile(join(root, 'hard.txt'), 'utf8')).toBe('NEW');
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('SECRET');
  });

  it('honours an aborted signal without leaving files', async () => {
    const { root, host } = await setup();
    const controller = new AbortController();
    controller.abort();
    await expectCode(host.writeTextFile(root, join(root, 'f.txt'), 'x', { signal: controller.signal }), 'ABORTED');
    expect(await readdir(root)).toEqual([]);
  });
});

describe('swap-after-resolve race against a concurrent attacker process', () => {
  // The attacker flips `d` between a real directory and a link to `outside` as fast as it can.
  const flipper = `
    const fs = require('fs');
    const [root, outside] = process.argv.slice(1);
    const d = root + '/d', real = root + '/d.real';
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    const stopFile = root + '/stop';
    while (!fs.existsSync(stopFile)) {
      try { fs.renameSync(d, real); } catch { continue; }
      try { fs.symlinkSync(outside, d, type); } catch {}
      try { fs.unlinkSync(d); } catch { try { fs.rmdirSync(d); } catch {} }
      try { fs.renameSync(real, d); } catch {}
    }
  `;

  it('writes and reads never reach the outside directory', async () => {
    const { root, outside, host } = await setup();
    await mkdir(join(root, 'd'));
    await writeFile(join(root, 'd', 'f.txt'), 'inside');
    const path = await host.resolve(root, 'd/f.txt');
    const attacker = spawn(process.execPath, ['-e', flipper, root, outside], { stdio: 'ignore' });
    await writeFile(join(outside, 'f.txt'), 'OUTSIDE-SECRET');
    let leaked = false;
    const codes: Record<string, number> = {};
    try {
      const deadline = Date.now() + 4000;
      let attempts = 0;
      while (Date.now() < deadline && attempts < 400) {
        attempts++;
        await host.writeTextFile(root, path, 'PWNED-MARKER', { signal: signal() }).catch((e: { code: string }) => { codes[e.code] = (codes[e.code] ?? 0) + 1; });
        const content = await host.readTextFile(root, path, { signal: signal() }).catch((e: { code: string }) => { codes[e.code] = (codes[e.code] ?? 0) + 1; return ''; });
        if (content.includes('OUTSIDE-SECRET')) leaked = true;
      }
    } finally {
      await writeFile(join(root, 'stop'), '');
      await new Promise(resolve => attacker.once('exit', resolve));
    }
    expect(Object.keys(codes).length).toBeGreaterThan(0); // the attacker really interfered
    // Linux identifies where a misplaced temp file landed and removes it, so nothing stray remains.
    if (process.platform === 'linux') expect((await readdir(outside)).sort()).toEqual(['f.txt', 'secret.txt']);
    expect(leaked).toBe(false);
    // The pre-existing outside file was never modified, and no outside file ever received content.
    expect(await readFile(join(outside, 'f.txt'), 'utf8')).toBe('OUTSIDE-SECRET');
    for (const name of await readdir(outside)) {
      expect((await readFile(join(outside, name), 'utf8')).includes('PWNED-MARKER'), name).toBe(false);
    }
  }, 30000);
});
