import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const codeOf = (error: unknown): string | undefined => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;

export function tokenPath(dataDir: string): string {
  return join(dataDir, 'control.token');
}

/** Read the owner token. Refuses a symlink, another user's file, or a group/world-readable file. */
export async function readControlToken(file: string): Promise<string> {
  const listed = await lstat(file);
  if (listed.isSymbolicLink() || !listed.isFile()) throw new Error('Control token must be a regular file');
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && listed.uid !== process.getuid()) throw new Error('Control token is owned by another user');
    if ((listed.mode & 0o077) !== 0) throw new Error('Control token is readable by group or others');
  }
  const token = (await readFile(file, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{20,512}$/.test(token)) throw new Error('Control token is empty or malformed');
  return token;
}

/** Create the token if it is absent. An existing token is kept (permissions are re-checked). */
export async function ensureControlToken(file: string): Promise<void> {
  try {
    await readControlToken(file);
    return;
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error;
  }
  const token = randomBytes(32).toString('base64url') + '\n';
  let handle;
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (error) {
    if (codeOf(error) === 'EEXIST') return;
    throw error;
  }
  try {
    if (process.platform !== 'win32') await handle.chmod(0o600);
    await handle.writeFile(token);
  } finally {
    await handle.close();
  }
}

/** Constant-time match. A non-string or a different length never matches. */
export function tokenEquals(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const left = Buffer.from(given);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
