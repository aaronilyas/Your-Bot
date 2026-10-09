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
