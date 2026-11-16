import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { FileScope } from '@your-bot/contracts';
import { GatewayError } from './validation.js';

export async function canonicalPaths(paths: FileScope[], databasePath: string): Promise<FileScope[]> {
  const result: FileScope[] = [];
  for (const scope of paths) {
    if (!isAbsolute(scope.path)) throw new GatewayError('UNSAFE_PATH', 'File scopes require absolute paths');
    const original = resolve(scope.path);
    let current = original; const tail: string[] = [];
    let canonical: string;
    while (true) {
      try { canonical = join(await realpath(current), ...tail); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || scope.access !== 'write' || dirname(current) === current) throw new GatewayError('UNSAFE_PATH', 'File target cannot be resolved');
        try {
          if ((await lstat(current)).isSymbolicLink()) throw new GatewayError('UNSAFE_PATH', 'Dangling symbolic links cannot be granted');
        } catch (linkError) { if ((linkError as NodeJS.ErrnoException).code !== 'ENOENT') throw linkError; }
        tail.unshift(basename(current)); current = dirname(current);
      }
    }
    if (tail.length === 0) {
      const info = await lstat(canonical);
      if (!info.isFile()) throw new GatewayError('UNSAFE_PATH', 'File scopes must name individual regular files');
      if (databasePath !== ':memory:') {
        const database = await lstat(databasePath);
        if (info.dev === database.dev && info.ino === database.ino) throw new GatewayError('UNSAFE_PATH', 'Gateway database files cannot be granted');
      }
    }
    if (databasePath !== ':memory:' && (canonical === databasePath || canonical.startsWith(`${databasePath}-`))) throw new GatewayError('UNSAFE_PATH', 'Gateway database files cannot be granted');
    if (!result.some(x => x.path === canonical && x.access === scope.access)) result.push({ path: canonical, access: scope.access });
  }
  return result;
}

/** Platforms whose default filesystems compare names case-insensitively. */
export function caseInsensitive(platform: NodeJS.Platform = process.platform): boolean { return platform === 'win32' || platform === 'darwin'; }

/**
 * Canonical, segment-based containment: `path` equals `folder` or lies beneath it. Both inputs must
 * already be canonical absolute paths (realpath); this never touches the filesystem, so a
 * symlink inside `folder` that points elsewhere is only safe because callers canonicalize first.
 * `/a/bc` is never within `/a/b`. Comparison is case-insensitive on win32/darwin.
 */
export function isWithin(folder: string, path: string, platform: NodeJS.Platform = process.platform): boolean {
  const separator = platform === 'win32' ? '\\' : '/';
  const normalize = (value: string) => {
    let result = platform === 'win32' ? value.replace(/\//g, '\\') : value;
    if (caseInsensitive(platform)) result = result.toLowerCase();
    while (result.length > 1 && result.endsWith(separator) && !(platform === 'win32' && /^[a-z]:\\$/i.test(result))) result = result.slice(0, -1);
    return result;
  };
  const base = normalize(folder); const target = normalize(path);
  if (!base || !target) return false;
  if (target === base) return true;
  return target.startsWith(base.endsWith(separator) ? base : base + separator);
}

/** Canonical existing directory (realpath), or throws `code`. */
export async function canonicalDirectory(path: string, code = 'INVALID_WORKSPACE'): Promise<string> {
  if (!isAbsolute(path)) throw new GatewayError(code, 'Folder must be an absolute path');
  let canonical: string;
  try { canonical = await realpath(path); } catch { throw new GatewayError(code, 'Folder does not exist'); }
  let info;
  try { info = await lstat(canonical); } catch { throw new GatewayError(code, 'Folder does not exist'); }
  if (!info.isDirectory()) throw new GatewayError(code, 'Folder must be a directory');
  return canonical;
}

/** True for the gateway database file and its SQLite sidecars. */
export function isDatabasePath(path: string, databasePath: string, platform: NodeJS.Platform = process.platform): boolean {
  if (databasePath === ':memory:') return false;
  const fold = (value: string) => caseInsensitive(platform) ? value.toLowerCase() : value;
  const target = fold(path); const db = fold(databasePath);
  return target === db || target.startsWith(`${db}-`);
}
