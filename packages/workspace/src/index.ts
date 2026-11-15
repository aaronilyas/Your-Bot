import type { HostTerminalCreateRequest, TaskId, TerminalExitStatus, TerminalOutput, WorkspaceHost } from '@your-bot/contracts';
import { readTextFile, writeTextFile } from './files.js';
import { resolveInRoot } from './paths.js';
import { TerminalManager } from './terminals.js';

export { WorkspaceError } from './errors.js';
export type { WorkspaceErrorCode } from './errors.js';
export { quoteBatchArgument, buildCmdCommandLine, cmdExeArguments } from './winquote.js';
export { OutputBuffer } from './output.js';
export { buildEnvironment, DEFAULT_OUTPUT_BYTE_LIMIT, MAX_RUNNING_TERMINALS_PER_TASK } from './terminals.js';
export { MAX_READ_BYTES } from './files.js';

export interface WorkspaceHostOptions {
  /** Environment the terminal allowlist (PATH, HOME, ...) is taken from. Default: process.env. */
  baseEnv?: NodeJS.ProcessEnv;
}

export function createWorkspaceHost(options: WorkspaceHostOptions = {}): WorkspaceHost {
  const terminals = new TerminalManager({ baseEnv: options.baseEnv });
  return {
    resolve: (root: string, path: string) => resolveInRoot(root, path),
    readTextFile: (root, canonicalPath, opts) => readTextFile(root, canonicalPath, opts),
    writeTextFile: (root, canonicalPath, content, opts) => writeTextFile(root, canonicalPath, content, opts),
    createTerminal: (root: string, request: HostTerminalCreateRequest & { cwd: string }, opts: { taskId: TaskId; signal: AbortSignal }) => terminals.create(root, request, opts),
    terminalOutput: async (terminalId: string): Promise<TerminalOutput> => terminals.output(terminalId),
    waitForTerminalExit: (terminalId: string, signal: AbortSignal): Promise<TerminalExitStatus> => terminals.waitForExit(terminalId, signal),
    killTerminal: (terminalId: string) => terminals.kill(terminalId),
    releaseTerminal: (terminalId: string) => terminals.release(terminalId),
    releaseTask: (taskId: TaskId) => terminals.releaseTask(taskId),
    close: () => terminals.close(),
  };
}
