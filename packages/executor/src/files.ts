import { constants } from 'node:fs';
import { open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { FileScope } from '@your-bot/contracts';

export class ExecutorError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function canonicalSyntax(value: string): void {
  if (!path.isAbsolute(value) || path.normalize(value) !== value || value.includes('\0') || value === '/') {
    throw new ExecutorError('INVALID_PATH', 'File scopes must use exact absolute canonical paths');
  }
}
export interface BoundFile {
  scope: FileScope;
  file: FileHandle;
  parent: FileHandle;
  name: string;
  close(): Promise<void>;
}
/** Walk relative to pinned directory FDs. O_NOFOLLOW applies at every component. */
export async function pinFile(scope: FileScope, maxWriteBytes = Number.MAX_SAFE_INTEGER): Promise<BoundFile> {
  canonicalSyntax(scope.path);
  const components = scope.path.slice(1).split('/');
  const name = components.pop()!;
  let parent = await open('/', constants.O_RDONLY | constants.O_DIRECTORY);
  let file: FileHandle | undefined;
  try {
    for (const component of components) {
      const next = await open(`/proc/self/fd/${parent.fd}/${component}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await parent.close();
      parent = next;
    }
    const target = `/proc/self/fd/${parent.fd}/${name}`;
    const flags = constants.O_NOFOLLOW | constants.O_NONBLOCK |
      (scope.access === 'write' ? constants.O_RDWR : constants.O_RDONLY);
    try { file = await open(target, flags); }
    catch (error) {
      if (scope.access !== 'write' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // No directory binding is granted to Python; only this exact new inode.
      file = await open(target, flags | constants.O_CREAT | constants.O_EXCL, 0o600);
    }
    const stat = await file.stat();
    if (!stat.isFile() || (scope.access !== 'read' && stat.nlink !== 1)) {
      throw new ExecutorError('INVALID_PATH', 'Only regular files are supported; writable hardlinks are refused');
    }
    if (scope.access === 'write' && stat.size > maxWriteBytes) throw new ExecutorError('FILE_LIMIT', 'Writable file exceeds configured size limit');
    if (await realpath(`/proc/self/fd/${file.fd}`) !== scope.path) {
      throw new ExecutorError('INVALID_PATH', 'File changed during authorization or is not canonical');
    }
    const pinned = file;
    return { scope, file: pinned, parent, name, close: async () => { await pinned.close(); await parent.close(); } };
  } catch (error) {
    await file?.close();
    await parent.close();
    if (error instanceof ExecutorError) throw error;
    throw new ExecutorError('INVALID_PATH', 'Cannot bind file safely: ' + (error as Error).message);
  }
}
/** unlink never follows the leaf; the parent directory stays pinned. */
export async function deletePinned(file: BoundFile): Promise<void> {
  const current = await open(`/proc/self/fd/${file.parent.fd}/${file.name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const a = await current.stat();
    const b = await file.file.stat();
    if (a.dev !== b.dev || a.ino !== b.ino) throw new ExecutorError('INVALID_PATH', 'File changed before deletion');
    await unlink(`/proc/self/fd/${file.parent.fd}/${file.name}`);
  } finally { await current.close(); }
}
