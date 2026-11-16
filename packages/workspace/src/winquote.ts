import { WorkspaceError } from './errors.js';

/** Characters that need no quoting at all for cmd.exe and for the MS argv parser. */
const SAFE_ARGUMENT = /^[A-Za-z0-9_\-.:/\\@+]+$/;

/**
 * Quote one argument for a command line that is parsed by `cmd.exe` (first pass, `/c`) and then
 * possibly again by a batch file that forwards `%*`, and finally by the MS C runtime argv parser.
 *
 * - Anything outside a conservative safe set is wrapped in double quotes, so `& | < > ^ ( )` stay
 *   literal for both cmd parses.
 * - `"` becomes `""` (keeps cmd's quote parity; the CRT reads `""` inside quotes as one `"`).
 * - Backslashes that precede a `"` or the closing quote are doubled.
 * - `%` becomes `%%cd:~,%`: cmd expands `%cd:~,%` to nothing, which leaves a literal `%` that can
 *   not open a `%VAR%` expansion (the technique used by the Rust standard library).
 * - CR, LF and NUL cannot be represented safely and are rejected.
 */
export function quoteBatchArgument(argument: string): string {
  if (/[\0\r\n]/.test(argument)) throw new WorkspaceError('INVALID_REQUEST', 'arguments for .cmd/.bat files may not contain CR, LF or NUL');
  if (argument !== '' && SAFE_ARGUMENT.test(argument)) return argument;
  let out = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === '\\') { backslashes++; continue; }
    if (character === '"') { out += '\\'.repeat(backslashes * 2) + '""'; backslashes = 0; continue; }
    out += '\\'.repeat(backslashes);
    backslashes = 0;
    out += character === '%' ? '%%cd:~,%' : character;
  }
  return out + '\\'.repeat(backslashes * 2) + '"';
}

/** The batch file path itself is always quoted verbatim; `%` can not be neutralized there. */
export function quoteBatchPath(path: string): string {
  if (/[\0\r\n"%]/.test(path)) throw new WorkspaceError('INVALID_REQUEST', 'unsupported character in batch file path');
  return `"${path}"`;
}

/** The text that follows `cmd.exe /d /s /v:off /c` (already wrapped for `/s`). */
export function buildCmdCommandLine(batchPath: string, args: readonly string[]): string {
  return `"${[quoteBatchPath(batchPath), ...args.map(quoteBatchArgument)].join(' ')}"`;
}

/** Arguments for spawn(cmd.exe, ..., { windowsVerbatimArguments: true }). */
export function cmdExeArguments(batchPath: string, args: readonly string[]): string[] {
  return ['/d', '/s', '/v:off', '/c', buildCmdCommandLine(batchPath, args)];
}
