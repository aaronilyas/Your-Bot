import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkspaceHost } from './index.js';
import { isInside, lexicalResolve, samePath } from './paths.js';
import { cleanupTemp, expectCode, linkDir, linkFile, makeTemp } from './test-support.js';

afterEach(cleanupTemp);

describe('path policy (pure, any platform)', () => {
  const win = { platform: 'win32' as const };
  const mac = { platform: 'darwin' as const };
  const lin = { platform: 'linux' as const };

  it('compares case-insensitively only on win32/darwin', () => {
    expect(isInside(win, 'C:\\Work\\Proj', 'c:\\work\\proj\\a.txt')).toBe(true);
    expect(isInside(mac, '/Users/Me/Proj', '/users/me/PROJ/a')).toBe(true);
    expect(isInside(lin, '/home/me/proj', '/home/me/PROJ/a')).toBe(false);
    expect(samePath(mac, '/tmp/\u00e9', '/tmp/e\u0301')).toBe(true);
  });

  it('requires a separator boundary (no prefix confusion)', () => {
    expect(isInside(lin, '/home/me/proj', '/home/me/project/a')).toBe(false);
    expect(isInside(win, 'C:\\ws', 'C:\\ws2\\a')).toBe(false);
    expect(isInside(lin, '/', '/etc/passwd')).toBe(true);
    expect(isInside(win, 'C:\\', 'C:\\x')).toBe(true);
  });

  it('rejects lexical escapes on every flavour', () => {
    for (const code of [() => lexicalResolve(lin, '/ws', '../x'), () => lexicalResolve(lin, '/ws', '/etc/passwd'), () => lexicalResolve(lin, '/ws', 'a/../../x')]) {
      expect(code).toThrowError(expect.objectContaining({ code: 'OUTSIDE_WORKSPACE' }));
    }
    for (const input of ['..\\x', 'D:\\x', 'C:\\ws2\\a', '\\\\server\\share\\a', '\\\\?\\C:\\ws\\a', '\\\\.\\C:\\ws\\a', 'C:..\\x']) {
      expect(() => lexicalResolve(win, 'C:\\ws', input), input).toThrowError(expect.objectContaining({ code: 'OUTSIDE_WORKSPACE' }));
    }
    expect(lexicalResolve(win, 'C:\\ws', 'a/b\\..\\c.txt')).toBe('C:\\ws\\a\\c.txt');
    expect(lexicalResolve(win, 'C:\\ws', 'c:\\WS\\x')).toBe('c:\\WS\\x');
  });

  it('rejects Windows streams and device names', () => {
    for (const input of ['a.txt:stream', 'a\\NUL', 'con.txt', 'COM1', 'lpt3.log', 'nul.', 'dir\\AUX ']) {
      expect(() => lexicalResolve(win, 'C:\\ws', input), input).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    }
    expect(lexicalResolve(win, 'C:\\ws', 'console.txt')).toBe('C:\\ws\\console.txt');
  });
});

describe('WorkspaceHost.resolve', () => {
  async function setup() {
    const base = await makeTemp();
    const root = join(base, 'ws');
    const outside = join(base, 'outside');
    await mkdir(root); await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'SECRET');
    return { base, root, outside, host: createWorkspaceHost() };
  }

  it('resolves relative and absolute paths inside the root, nonexistent final component allowed', async () => {
    const { root, host } = await setup();
    await mkdir(join(root, 'src'));
    expect(await host.resolve(root, 'src/new.ts')).toBe(join(root, 'src', 'new.ts'));
    expect(await host.resolve(root, join(root, 'src', 'a.ts'))).toBe(join(root, 'src', 'a.ts'));
    expect(await host.resolve(root, 'src/./../src/x')).toBe(join(root, 'src', 'x'));
    expect(await host.resolve(root, '.')).toBe(root);
  });

  it('rejects .. and absolute escapes', async () => {
    const { root, outside, host } = await setup();
    await expectCode(host.resolve(root, '../outside/secret.txt'), 'OUTSIDE_WORKSPACE');
    await expectCode(host.resolve(root, join(outside, 'secret.txt')), 'OUTSIDE_WORKSPACE');
    await expectCode(host.resolve(root, 'a/../../outside'), 'OUTSIDE_WORKSPACE');
    await expectCode(host.resolve(root, join(root, '..')), 'OUTSIDE_WORKSPACE');
  });

  it('requires an existing parent and a sane request', async () => {
    const { root, host } = await setup();
    await expectCode(host.resolve(root, 'missing/dir/file.txt'), 'NOT_FOUND');
    await expectCode(host.resolve(root, ''), 'INVALID_REQUEST');
    await expectCode(host.resolve(root, 'a\0b'), 'INVALID_REQUEST');
    await writeFile(join(root, 'plain'), 'x');
    await expectCode(host.resolve(root, 'plain/child'), 'INVALID_REQUEST');
  });

  it('rejects a directory link (symlink / junction) that leaves the workspace', async () => {
    const { root, outside, host } = await setup();
    await linkDir(outside, join(root, 'escape'));
    await expectCode(host.resolve(root, 'escape/secret.txt'), 'OUTSIDE_WORKSPACE');
    await expectCode(host.resolve(root, 'escape/new.txt'), 'OUTSIDE_WORKSPACE');
    await expectCode(host.resolve(root, 'escape'), 'OUTSIDE_WORKSPACE');
  });

  it('rejects a file symlink whose target is outside, follows one that stays inside', async () => {
    const { root, outside, host } = await setup();
    await writeFile(join(root, 'real.txt'), 'x');
    if (await linkFile(join(outside, 'secret.txt'), join(root, 'leak.txt'))) {
      await expectCode(host.resolve(root, 'leak.txt'), 'OUTSIDE_WORKSPACE');
      await linkFile(join(root, 'real.txt'), join(root, 'alias.txt'));
      expect(await host.resolve(root, 'alias.txt')).toBe(join(root, 'real.txt'));
    }
  });

  it('refuses dangling symlinks and non-canonical roots', async () => {
    const { base, root, host } = await setup();
    if (process.platform !== 'win32') {
      await symlink(join(base, 'nowhere'), join(root, 'dangling'));
      await expectCode(host.resolve(root, 'dangling'), 'INVALID_REQUEST');
    }
    const aliasRoot = join(base, 'alias-root');
    await linkDir(root, aliasRoot);
    await expectCode(host.resolve(aliasRoot, 'x'), 'INVALID_REQUEST');
    await expectCode(host.resolve('relative/root', 'x'), 'INVALID_REQUEST');
    await expectCode(host.resolve(join(base, 'does-not-exist'), 'x'), 'NOT_FOUND');
  });

  if (process.platform === 'win32' || process.platform === 'darwin') it('is case-insensitive on this platform', async () => {
    const { root, host } = await setup();
    await writeFile(join(root, 'Mixed.txt'), 'x');
    const resolved = await host.resolve(root, join(root.toUpperCase() === root ? root.toLowerCase() : root.toUpperCase(), 'MIXED.TXT'));
    expect(resolved.toLowerCase()).toBe(join(root, 'Mixed.txt').toLowerCase());
  });
});
