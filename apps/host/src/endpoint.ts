import { createHash } from 'node:crypto';
import { lstat, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const codeOf = (error: unknown): string | undefined => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;

/**
 * POSIX: `<data>/control.sock` inside the 0700 data directory.
 * Windows: a named pipe whose name is a hash of the real data directory (pipes cannot live in that directory).
 */
export async function controlEndpoint(dataDir: string): Promise<string> {
  const root = await realpath(resolve(dataDir));
  if (process.platform === 'win32') {
    const hash = createHash('sha256').update(root).digest('hex').slice(0, 32);
    return `\\\\.\\pipe\\your-bot-${hash}`;
  }
  return join(root, 'control.sock');
}

/** Remove a leftover socket. A symlink or any non-socket at that path is refused. */
export async function prepareSocketPath(endpoint: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const listed = await lstat(endpoint);
    if (listed.isSymbolicLink()) throw new Error('Control socket path is a symlink');
    if (!listed.isSocket()) throw new Error('Control socket path exists and is not a socket');
    await unlink(endpoint);
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error;
  }
}
