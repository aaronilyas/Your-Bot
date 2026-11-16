import { access, stat } from 'node:fs/promises';
import { constants as fsc } from 'node:fs';
import * as nodePath from 'node:path';
import { WorkspaceError } from './errors.js';

export interface ResolvedCommand {
  /** Absolute path of the file to execute (the batch file itself for `.cmd`/`.bat`). */
  file: string;
  /** True when the file is a batch script that must be run through cmd.exe. */
  batch: boolean;
}

const DIRECT_EXTENSIONS = ['.exe', '.com'];
const BATCH_EXTENSIONS = ['.cmd', '.bat'];

function envValue(env: Record<string, string>, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/** PATHEXT entries we can actually run without a shell, in PATHEXT order. */
export function executableExtensions(env: Record<string, string>): string[] {
  const configured = (envValue(env, 'PATHEXT', 'win32') ?? '.COM;.EXE;.BAT;.CMD').split(';').map(item => item.trim().toLowerCase()).filter(Boolean);
  const supported = new Set([...DIRECT_EXTENSIONS, ...BATCH_EXTENSIONS]);
  const ordered = configured.filter(extension => supported.has(extension));
  return ordered.length > 0 ? ordered : ['.com', '.exe', '.bat', '.cmd'];
}

async function isExecutableFile(file: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    if (platform !== 'win32') await access(file, fsc.X_OK);
    return true;
  } catch { return false; }
}

function classify(file: string): ResolvedCommand {
  const extension = nodePath.win32.extname(file).toLowerCase();
  return { file, batch: BATCH_EXTENSIONS.includes(extension) };
}

/**
 * Resolve `command` to an absolute executable using the PATH of `env` (the environment the child
 * will see). Commands containing a separator are taken relative to `cwd`. The current directory
 * is never searched implicitly. Windows: only .exe/.com (direct) and .cmd/.bat (via cmd.exe).
 */
export async function resolveCommand(command: string, env: Record<string, string>, cwd: string, platform: NodeJS.Platform = process.platform): Promise<ResolvedCommand> {
  if (typeof command !== 'string' || command.length === 0 || command.includes('\0')) throw new WorkspaceError('INVALID_REQUEST', 'command must be a non-empty string');
  const win = platform === 'win32';
  const api = win ? nodePath.win32 : nodePath.posix;
  const extensions = win ? executableExtensions(env) : [''];
  const supportedExplicit = new Set([...DIRECT_EXTENSIONS, ...BATCH_EXTENSIONS]);

  const candidatesFor = (base: string): string[] => {
    if (!win) return [base];
    return supportedExplicit.has(api.extname(base).toLowerCase()) ? [base, ...extensions.map(extension => base + extension)] : extensions.map(extension => base + extension);
  };

  const hasSeparator = win ? /[\\/]/.test(command) : command.includes('/');
  const bases: string[] = [];
  if (hasSeparator) {
    bases.push(api.resolve(cwd, command));
  } else {
    const pathValue = envValue(env, 'PATH', platform) ?? '';
    for (const entry of pathValue.split(win ? ';' : ':')) {
      const trimmed = win ? entry.trim().replace(/^"(.*)"$/, '$1') : entry;
      if (trimmed === '') continue;
      bases.push(api.join(api.resolve(cwd, trimmed), command));
    }
  }
  for (const base of bases) {
    for (const candidate of candidatesFor(base)) {
      if (await isExecutableFile(candidate, platform)) return win ? classify(candidate) : { file: candidate, batch: false };
    }
  }
  throw new WorkspaceError('NOT_FOUND', `command not found: ${command}`);
}
