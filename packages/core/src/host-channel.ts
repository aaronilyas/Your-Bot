import type { PermissionInputV2, TerminalExitStatus, TerminalOutput, WorkspaceHost, WorkspaceHostChannel } from '@your-bot/contracts';
import { isDatabasePath, isWithin } from './paths.js';
import { GatewayError, record, string } from './validation.js';
import { validateHostRead, validateHostWrite, validateTerminalCreate, validateTerminalId } from './validation-v2.js';

export type HostPermission = PermissionInputV2 & {
  /** Terminal requests that set environment variables never match standing grants. */
  env?: boolean;
};
export interface HostChannelDependencies {
  host: WorkspaceHost;
  /** Canonical workspace of the trusted bot. */
  workspace: string;
  taskId: string;
  botId: string;
  signal: AbortSignal;
  databasePath: string;
  live(): boolean;
  /** The single gateway authorization pipeline. Resolves true only for an allow. */
  authorize(request: HostPermission): Promise<boolean>;
  /** Audits a policy denial (no prompt) and returns the error to reject with. */
  policyDeny(request: HostPermission, code: string, message: string): Error;
  /** Terminals created by this task. Follow-up calls are limited to these ids. */
  terminals: Set<string>;
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
function validTerminalId(value: unknown): string {
  string(value, 'terminal id', 256); return value;
}

/**
 * Core-implemented WorkspaceHostChannel. Every file or process operation is resolved to a canonical
 * path inside the workspace, authorized through the gateway pipeline with that canonical path (or
 * argv + canonical cwd), and only then performed by the injected WorkspaceHost. Terminal follow-up
 * calls need no approval but must name a terminal this task created.
 */
export function createHostChannel(deps: HostChannelDependencies): WorkspaceHostChannel {
  const ensureLive = () => { if (!deps.live() || deps.signal.aborted) throw new GatewayError('CANCELLED', 'Task is no longer active'); };
  const resolve = async (path: string, request: (canonical: string) => HostPermission): Promise<string> => {
    let canonical: string;
    try { canonical = await deps.host.resolve(deps.workspace, path); }
    catch (error) {
      if (codeOf(error) === 'OUTSIDE_WORKSPACE') throw deps.policyDeny(request(path), 'OUTSIDE_WORKSPACE', 'Path is outside the bot workspace');
      throw error;
    }
    string(canonical, 'resolved path', 4096);
    // Defence in depth: never trust the host's confinement alone.
    if (!isWithin(deps.workspace, canonical)) throw deps.policyDeny(request(canonical), 'OUTSIDE_WORKSPACE', 'Path is outside the bot workspace');
    if (isDatabasePath(canonical, deps.databasePath)) throw deps.policyDeny(request(canonical), 'PERMISSION_DENIED', 'Gateway database files cannot be accessed');
    return canonical;
  };
  const owned = (terminalId: unknown): string => {
    const id = validTerminalId(terminalId);
    if (!deps.terminals.has(id)) throw new GatewayError('TERMINAL_NOT_FOUND', 'Terminal not found for this task');
    return id;
  };
  const allow = async (request: HostPermission) => {
    if (!await deps.authorize(request)) throw new GatewayError('PERMISSION_DENIED', 'Permission was denied');
    ensureLive();
  };

  return {
    async readTextFile(raw) {
      ensureLive(); const input = validateHostRead(raw);
      const read = (path: string): HostPermission => ({ capability: 'file.read', reason: `Agent reads ${path}`, paths: [{ path, access: 'read' }], botId: deps.botId });
      const path = await resolve(input.path, read);
      await allow(read(path));
      const content = await deps.host.readTextFile(deps.workspace, path, { ...(input.line !== undefined ? { line: input.line } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}), signal: deps.signal });
      string(content, 'file content', 64 * 1024 * 1024, true);
      return { content };
    },
    async writeTextFile(raw) {
      ensureLive(); const input = validateHostWrite(raw);
      const write = (path: string): HostPermission => ({ capability: 'file.write', reason: `Agent writes ${path} (${Buffer.byteLength(input.content)} bytes)`, paths: [{ path, access: 'write' }], botId: deps.botId });
      const path = await resolve(input.path, write);
      await allow(write(path));
      await deps.host.writeTextFile(deps.workspace, path, input.content, { signal: deps.signal });
    },
    async createTerminal(raw) {
      ensureLive(); const input = validateTerminalCreate(raw);
      const args = input.args ?? [];
      const env = input.env ?? [];
      const spawn = (cwd: string): HostPermission => ({
        capability: 'process.spawn', botId: deps.botId, command: { command: input.command, args, cwd },
        reason: `Agent runs ${JSON.stringify([input.command, ...args])} in ${cwd}${env.length ? `\nEnvironment: ${env.map(entry => `${entry.name}=${entry.value}`).join('\n')}` : ''}`,
        ...(env.length ? { env: true } : {}),
      });
      // `env` is not part of the contract's command detail; it is reflected in the reason only.
      const cwd = await resolve(input.cwd ?? deps.workspace, spawn);
      await allow(spawn(cwd));
      const terminalId = await deps.host.createTerminal(deps.workspace, { ...input, cwd }, { taskId: deps.taskId, signal: deps.signal });
      const id = validTerminalId(terminalId);
      deps.terminals.add(id);
      return { terminalId: id };
    },
    async terminalOutput(terminalId) {
      ensureLive(); const output: TerminalOutput = await deps.host.terminalOutput(owned(terminalId));
      record(output, ['output', 'truncated', 'exitStatus'], ['output', 'truncated']);
      return structuredClone(output);
    },
    async waitForTerminalExit(terminalId) {
      ensureLive(); const status: TerminalExitStatus = await deps.host.waitForTerminalExit(owned(terminalId), deps.signal);
      return structuredClone(status);
    },
    async killTerminal(terminalId) { ensureLive(); await deps.host.killTerminal(owned(terminalId)); },
    async releaseTerminal(terminalId) {
      ensureLive(); const id = owned(terminalId);
      await deps.host.releaseTerminal(id); deps.terminals.delete(id);
    },
  };
}
