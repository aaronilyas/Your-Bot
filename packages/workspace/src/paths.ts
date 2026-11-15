import { realpath, lstat, stat } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { WorkspaceError, errnoOf, mapFsError } from './errors.js';

/** Path flavour parameter so confinement logic is unit-testable for any platform. */
export interface PathPolicy {
  platform: NodeJS.Platform;
}

export const hostPolicy: PathPolicy = { platform: process.platform };

export function caseInsensitive(policy: PathPolicy): boolean {
  return policy.platform === 'win32' || policy.platform === 'darwin';
}

function api(policy: PathPolicy): nodePath.PlatformPath {
  return policy.platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

/** Comparison key: case/normalization folded on win32/darwin, identity elsewhere. */
export function fold(policy: PathPolicy, p: string): string {
  if (!caseInsensitive(policy)) return p;
  const n = policy.platform === 'darwin' ? p.normalize('NFC') : p;
  return n.toLowerCase();
}

export function samePath(policy: PathPolicy, a: string, b: string): boolean {
  return fold(policy, a) === fold(policy, b);
}

/** True when `candidate` equals `root` or is a descendant of it (both absolute, normalized). */
export function isInside(policy: PathPolicy, root: string, candidate: string): boolean {
  const sep = api(policy).sep;
  const r = fold(policy, root);
  const c = fold(policy, candidate);
  if (c === r) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return c.startsWith(prefix);
}

const WIN_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** Windows-only name checks on the part of the path below the root. */
function checkWindowsSegments(rel: string): void {
  for (const segment of rel.split(/[\\/]+/)) {
    if (segment === '') continue;
    if (segment.includes(':')) throw new WorkspaceError('INVALID_REQUEST', 'alternate data streams and drive-relative names are not allowed');
    if (WIN_RESERVED.test(segment.replace(/[ .]+$/, ''))) throw new WorkspaceError('INVALID_REQUEST', `reserved device name: ${segment}`);
  }
}

/**
 * Lexical step: absolute, normalized candidate for `input` relative to `root`. Rejects `..` and
 * absolute escapes without touching the filesystem.
 */
export function lexicalResolve(policy: PathPolicy, root: string, input: string): string {
  if (typeof input !== 'string' || input.length === 0) throw new WorkspaceError('INVALID_REQUEST', 'path must be a non-empty string');
  if (input.includes('\0')) throw new WorkspaceError('INVALID_REQUEST', 'path contains a NUL byte');
  const p = api(policy);
  const absolute = p.resolve(root, input);
  if (!isInside(policy, root, absolute)) throw new WorkspaceError('OUTSIDE_WORKSPACE', 'path is outside the workspace');
  if (policy.platform === 'win32' && !samePath(policy, absolute, root)) checkWindowsSegments(p.relative(root, absolute));
  return absolute;
}

/** `root` must be an absolute, already-canonical (realpath) directory. Returns it normalized. */
export async function verifyRoot(root: string, policy: PathPolicy = hostPolicy): Promise<string> {
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0')) throw new WorkspaceError('INVALID_REQUEST', 'workspace root must be a non-empty string');
  const p = api(policy);
  if (!p.isAbsolute(root)) throw new WorkspaceError('INVALID_REQUEST', 'workspace root must be absolute');
  const normalized = p.resolve(root);
  let real: string;
  try { real = await realpath(normalized); } catch (error) { throw mapFsError(error, 'workspace root'); }
  if (!samePath(policy, real, normalized)) throw new WorkspaceError('INVALID_REQUEST', 'workspace root is not canonical (resolve symlinks first)');
  return normalized;
}

/**
 * Canonical absolute path for `input` (relative to `root`, or absolute inside it). The final
 * component may not exist; its parent must. Symlinks/junctions anywhere on the path are
 * resolved and the result must still be inside `root`.
 */
export async function resolveInRoot(root: string, input: string, policy: PathPolicy = hostPolicy): Promise<string> {
  const normalizedRoot = await verifyRoot(root, policy);
  const p = api(policy);
  const absolute = lexicalResolve(policy, normalizedRoot, input);
  if (samePath(policy, absolute, normalizedRoot)) return normalizedRoot;

  let real: string | undefined;
  try {
    real = await realpath(absolute);
  } catch (error) {
    const errno = errnoOf(error);
    if (errno !== 'ENOENT') throw mapFsError(error, 'resolve');
  }
  if (real !== undefined) {
    if (!isInside(policy, normalizedRoot, real)) throw new WorkspaceError('OUTSIDE_WORKSPACE', 'path resolves outside the workspace');
    return real;
  }

  // Final component does not exist (or is a dangling link): canonicalize the parent.
  const parent = p.dirname(absolute);
  const base = p.basename(absolute);
  let realParent: string;
  try { realParent = await realpath(parent); } catch (error) { throw mapFsError(error, 'parent directory'); }
  if (!isInside(policy, normalizedRoot, realParent)) throw new WorkspaceError('OUTSIDE_WORKSPACE', 'parent directory resolves outside the workspace');
  try {
    if (!(await stat(realParent)).isDirectory()) throw new WorkspaceError('INVALID_REQUEST', 'parent is not a directory');
  } catch (error) { throw mapFsError(error, 'parent directory'); }
  try {
    await lstat(absolute);
    // lstat succeeded although realpath failed: a dangling symlink/junction.
    throw new WorkspaceError('INVALID_REQUEST', 'path is a dangling symbolic link');
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    if (errnoOf(error) !== 'ENOENT') throw mapFsError(error, 'resolve');
  }
  return p.join(realParent, base);
}
