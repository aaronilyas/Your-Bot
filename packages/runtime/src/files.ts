import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const codeOf = (error: unknown): string | undefined => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;

/** Create `path` as a real directory and force mode 0700. A symlink is refused. */
export async function ensurePrivateDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const listed = await lstat(path);
  if (listed.isSymbolicLink()) throw new Error(`Refusing symlinked directory ${path}`);
  const real = await realpath(path);
  if (process.platform !== 'win32') await chmod(real, 0o700);
  return real;
}

async function assertOwnerFile(file: string): Promise<void> {
  const listed = await lstat(file);
  if (listed.isSymbolicLink() || !listed.isFile()) throw new Error(`${file} must be a regular file`);
  if (process.platform === 'win32') return;
  if (typeof process.getuid === 'function' && listed.uid !== process.getuid()) throw new Error(`${file} is owned by another user`);
  if ((listed.mode & 0o077) !== 0) throw new Error(`${file} is readable by group or others`);
}

/** Read a 0600 regular file. Missing file throws ENOENT. */
export async function readOwnerFile(file: string): Promise<string> {
  await assertOwnerFile(file);
  return await readFile(file, 'utf8');
}

/** Create or replace a regular file as mode 0600. Never follows a symlink. */
export async function writeOwnerFile(file: string, content: string | Buffer): Promise<void> {
  try {
    await assertOwnerFile(file);
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error;
  }
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
  try {
    if (process.platform !== 'win32') await handle.chmod(0o600);
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

function cleanName(value: string | undefined): string {
  const name = (value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 256);
  return name || 'host';
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

export interface DataLayout {
  dataDir: string;
  host: { id: string; name: string };
  browserCwd: string;
  pythonDir: string;
  skillsDir: string;
  gatewayDir: string;
}

/**
 * 0700 data directory: host identity, gateway DB directory, Python environment, global skills,
 * and the browser-preset working directory. The secret-key directory is separate from the DB directory.
 */
export async function prepareDataLayout(dataDir: string, hostName?: string): Promise<DataLayout> {
  const root = await ensurePrivateDirectory(dataDir);
  const host = await loadHostIdentity(join(root, 'host.json'), hostName);
  const skillsDir = await ensurePrivateDirectory(join(root, 'skills'));
  const gatewayDir = await ensurePrivateDirectory(join(root, 'gateway'));
  const pythonDir = await ensurePrivateDirectory(join(root, 'python'));
  const browserCwd = await ensurePrivateDirectory(join(await ensurePrivateDirectory(join(root, 'mcp')), 'browser'));
  await ensurePrivateDirectory(join(root, 'keys'));
  return { dataDir: root, host, browserCwd, pythonDir, skillsDir, gatewayDir };
}

async function loadHostIdentity(file: string, hostName?: string): Promise<{ id: string; name: string }> {
  let id: string | undefined;
  let storedName: string | undefined;
  try {
    const parsed = JSON.parse(await readOwnerFile(file)) as { id?: unknown; name?: unknown };
    if (!validId(parsed.id)) throw new Error(`${file} has no usable host id`);
    id = parsed.id;
    if (typeof parsed.name === 'string') storedName = cleanName(parsed.name);
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error;
  }
  const name = cleanName(hostName ?? storedName ?? hostname());
  const identity = { id: id ?? randomUUID(), name };
  if (identity.id !== id || identity.name !== storedName) await writeOwnerFile(file, JSON.stringify(identity) + '\n');
  return identity;
}
