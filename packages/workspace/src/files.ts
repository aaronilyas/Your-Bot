import { constants as fsc } from 'node:fs';
import { lstat, open, readlink, realpath, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import * as nodePath from 'node:path';
import { WorkspaceError, errnoOf, mapFsError, throwIfAborted } from './errors.js';
import { hostPolicy, isInside, resolveInRoot, samePath, verifyRoot } from './paths.js';

export const MAX_READ_BYTES = 10 * 1024 * 1024;

const O_NOFOLLOW = fsc.O_NOFOLLOW ?? 0;
const O_NONBLOCK = fsc.O_NONBLOCK ?? 0;
const O_NOCTTY = fsc.O_NOCTTY ?? 0;

/**
 * The caller must pass the canonical path returned by `resolve`. It is re-resolved right now;
 * if the result differs (a directory was swapped for a link, the file became a link, ...) the
 * operation is refused instead of following the new location.
 */
export async function recheckCanonical(root: string, canonicalPath: string): Promise<{ root: string; target: string }> {
  const normalizedRoot = await verifyRoot(root);
  if (typeof canonicalPath !== 'string' || canonicalPath.includes('\0') || !nodePath.isAbsolute(canonicalPath)) {
    throw new WorkspaceError('INVALID_REQUEST', 'expected the canonical absolute path returned by resolve');
  }
  const again = await resolveInRoot(normalizedRoot, canonicalPath);
  if (!samePath(hostPolicy, again, nodePath.resolve(canonicalPath))) {
    throw new WorkspaceError('INVALID_REQUEST', 'path is not canonical or changed since it was resolved');
  }
  return { root: normalizedRoot, target: again };
}

/** Linux only: where the kernel says the open file lives right now (not racy: the fd pins the inode). */
async function kernelPathOf(handle: FileHandle): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  try { return await readlink(`/proc/self/fd/${handle.fd}`); } catch { return undefined; }
}

/**
 * After opening `handle` for `path`, prove the open file is the one at `path` inside the root.
 * Linux: the kernel's own path for the fd (closes the swap race completely). Elsewhere: the path
 * must still lead to the very same inode and canonicalize to itself, checked twice; this narrows
 * the race window but cannot close it (no openat/O_BENEATH in Node) - see README.
 */
async function verifyOpened(root: string, path: string, handle: FileHandle): Promise<void> {
  const actual = await kernelPathOf(handle);
  if (actual !== undefined) {
    if (!isInside(hostPolicy, root, actual)) throw new WorkspaceError('OUTSIDE_WORKSPACE', 'opened file is outside the workspace');
    if (!samePath(hostPolicy, actual, path)) throw new WorkspaceError('OUTSIDE_WORKSPACE', 'path changed while opening');
    return;
  }
  const opened = await handle.stat({ bigint: true });
  for (let round = 0; round < 2; round++) {
    let real: string;
    try { real = await realpath(path); } catch (error) { throw mapFsError(error, 'verify'); }
    if (!isInside(hostPolicy, root, real)) throw new WorkspaceError('OUTSIDE_WORKSPACE', 'path resolves outside the workspace');
    if (!samePath(hostPolicy, real, path)) throw new WorkspaceError('OUTSIDE_WORKSPACE', 'path changed while opening');
    let named;
    try { named = await lstat(path, { bigint: true }); } catch (error) {
      if (errnoOf(error) === 'ENOENT') throw new WorkspaceError('OUTSIDE_WORKSPACE', 'path changed while opening');
      throw mapFsError(error, 'verify');
    }
    if (named.isSymbolicLink()) throw new WorkspaceError('OUTSIDE_WORKSPACE', 'path became a symbolic link');
    if (named.ino !== opened.ino || named.dev !== opened.dev) throw new WorkspaceError('OUTSIDE_WORKSPACE', 'path changed while opening');
  }
}

/** Select lines [line, line+limit) (1-based) keeping line terminators. */
export function sliceLines(content: string, line?: number, limit?: number): string {
  if (line === undefined && limit === undefined) return content;
  const start = (line ?? 1) - 1;
  let index = 0;
  let lineNo = 0;
  let from = start === 0 ? 0 : -1;
  let to = content.length;
  while (index < content.length) {
    const newline = content.indexOf('\n', index);
    const end = newline === -1 ? content.length : newline + 1;
    if (lineNo === start) from = index;
    lineNo++;
    if (limit !== undefined && from !== -1 && lineNo === start + limit) { to = end; break; }
    index = end;
  }
  if (from === -1) return '';
  if (limit === 0) return '';
  return content.slice(from, to);
}

function checkSlice(line: number | undefined, limit: number | undefined): void {
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) throw new WorkspaceError('INVALID_REQUEST', 'line must be an integer >= 1');
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new WorkspaceError('INVALID_REQUEST', 'limit must be an integer >= 0');
}

export async function readTextFile(root: string, canonicalPath: string, options: { line?: number; limit?: number; signal: AbortSignal }): Promise<string> {
  throwIfAborted(options.signal);
  checkSlice(options.line, options.limit);
  const { root: normalizedRoot, target } = await recheckCanonical(root, canonicalPath);
  let handle: FileHandle;
  try {
    const before = await lstat(target);
    if (!before.isFile()) throw new WorkspaceError('INVALID_REQUEST', before.isDirectory() ? 'path is a directory' : 'not a regular file');
    // O_NONBLOCK: opening a FIFO planted in the workspace must not hang the host.
    handle = await open(target, fsc.O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY);
  } catch (error) {
    throw mapFsError(error, 'read');
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new WorkspaceError('INVALID_REQUEST', 'not a regular file');
    if (stats.size > MAX_READ_BYTES) throw new WorkspaceError('LIMIT_EXCEEDED', `file exceeds the ${MAX_READ_BYTES} byte read limit`);
    await verifyOpened(normalizedRoot, target, handle);
    throwIfAborted(options.signal);
    const buffer = Buffer.allocUnsafe(Math.min(Math.max(stats.size, 1), MAX_READ_BYTES) + 1);
    let length = 0;
    for (;;) {
      if (length >= buffer.length) throw new WorkspaceError('LIMIT_EXCEEDED', `file exceeds the ${MAX_READ_BYTES} byte read limit`);
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
      throwIfAborted(options.signal);
    }
    if (length > MAX_READ_BYTES) throw new WorkspaceError('LIMIT_EXCEEDED', `file exceeds the ${MAX_READ_BYTES} byte read limit`);
    return sliceLines(buffer.toString('utf8', 0, length), options.line, options.limit);
  } catch (error) {
    throw mapFsError(error, 'read');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function renameReplacing(from: string, to: string): Promise<void> {
  // Windows refuses to replace a file that another process (reader, antivirus, indexer) has open.
  // Retry for about two seconds before giving up.
  const transient = new Set(['EPERM', 'EACCES', 'EBUSY']);
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; } catch (error) {
      if (process.platform !== 'win32' || !transient.has(errnoOf(error) ?? '') || attempt >= 24) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(10 * (attempt + 1), 150)));
    }
  }
}

export async function writeTextFile(root: string, canonicalPath: string, content: string, options: { signal: AbortSignal }): Promise<void> {
  throwIfAborted(options.signal);
  if (typeof content !== 'string') throw new WorkspaceError('INVALID_REQUEST', 'content must be a string');
  const { root: normalizedRoot, target } = await recheckCanonical(root, canonicalPath);
  if (samePath(hostPolicy, target, normalizedRoot)) throw new WorkspaceError('INVALID_REQUEST', 'path is a directory');
  let mode = 0o666;
  try {
    const existing = await lstat(target);
    if (!existing.isFile()) throw new WorkspaceError('INVALID_REQUEST', existing.isDirectory() ? 'path is a directory' : 'not a regular file');
    mode = existing.mode & 0o7777;
  } catch (error) {
    if (errnoOf(error) !== 'ENOENT') throw mapFsError(error, 'write');
  }
  const directory = nodePath.dirname(target);
  const temp = nodePath.join(directory, `.${randomBytes(9).toString('hex')}.ybtmp`);
  let handle: FileHandle | undefined;
  try {
    try {
      handle = await open(temp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | O_NOFOLLOW | O_NOCTTY, mode);
    } catch (error) { throw mapFsError(error, 'write'); }
    // Nothing has been written yet. If `directory` was swapped for a link between the pre-check
    // and the create, the temp file is not where we think it is: refuse before writing content.
    try { await verifyOpened(normalizedRoot, temp, handle); } catch (error) {
      // Linux can tell where the temp file really went; remove it from there.
      const misplaced = await kernelPathOf(handle);
      if (misplaced !== undefined && misplaced !== temp && nodePath.basename(misplaced) === nodePath.basename(temp)) await unlink(misplaced).catch(() => undefined);
      throw error;
    }
    if (process.platform !== 'win32') await handle.chmod(mode);
    throwIfAborted(options.signal);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    throwIfAborted(options.signal);
    // Last confinement check immediately before the atomic replace.
    await recheckCanonical(normalizedRoot, target);
    try { await renameReplacing(temp, target); } catch (error) { throw mapFsError(error, 'write'); }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    throw mapFsError(error, 'write');
  }
}
