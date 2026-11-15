import type { Bot, CapabilityV2, PermissionInputV2, StandingGrant, StandingGrantScope } from '@your-bot/contracts';
import { canonicalDirectory, isWithin } from './paths.js';
import { GatewayError } from './validation.js';
import { CUSTOM_PYTHON_PREFIX, STANDING_CAPABILITIES } from './validation-v2.js';

/** Fields a standing scope may carry per capability: [required, optional]. */
const SCOPE_FIELDS: Partial<Record<CapabilityV2, [string[], string[]]>> = {
  'file.read': [['folder'], []], 'file.write': [['folder'], []], 'file.delete': [['folder'], []],
  'process.spawn': [['commandPrefix'], ['folder']],
  'mcp.call': [['mcp'], []],
  'tool.execute': [['agentToolKind'], []],
};
/** Built-in MCP server namespace served by core (P4). */
export const BUILTIN_MCP_SERVER = 'your_bot';

/**
 * Semantic validation of a standing scope for `capability` and `bot` (shape is validated already).
 * Returns the scope with its folder canonicalized. Folders must exist, be directories, and lie
 * inside the bot workspace.
 */
export async function normalizeStandingScope(capability: CapabilityV2, scope: StandingGrantScope, bot: Bot, platform: NodeJS.Platform = process.platform): Promise<StandingGrantScope> {
  const fields = STANDING_CAPABILITIES.includes(capability) ? SCOPE_FIELDS[capability] : undefined;
  if (!fields) throw new GatewayError('STANDING_FORBIDDEN', `${capability} can never be granted standing`);
  const present = Object.keys(scope);
  const [required, optional] = fields;
  if (!required.every(key => present.includes(key)) || !present.every(key => required.includes(key) || optional.includes(key))) {
    throw new GatewayError('INVALID_INPUT', `Standing ${capability} grants require exactly: ${required.join(', ')}${optional.length ? ` (optional ${optional.join(', ')})` : ''}`);
  }
  const result = structuredClone(scope);
  if (capability.startsWith('file.') || capability === 'process.spawn') {
    if (!bot.workspace) throw new GatewayError('INVALID_INPUT', 'Folder and command grants require a bot workspace');
    if (scope.folder !== undefined) {
      const folder = await canonicalDirectory(scope.folder, 'INVALID_INPUT');
      if (!isWithin(bot.workspace, folder, platform)) throw new GatewayError('OUTSIDE_WORKSPACE', 'Grant folder must lie inside the bot workspace');
      result.folder = folder;
    }
  }
  if (capability === 'mcp.call' && scope.mcp!.serverId !== BUILTIN_MCP_SERVER && !bot.mcpServers.some(server => server.id === scope.mcp!.serverId)) {
    throw new GatewayError('NOT_FOUND', 'MCP server is not configured for this bot');
  }
  return result;
}

export function active(grant: StandingGrant, now = Date.now()): boolean {
  return !grant.revokedAt && (grant.expiresAt === undefined || Date.parse(grant.expiresAt) > now);
}

/** True when the request is of a type that may never be satisfied by a standing grant. */
export function standingForbidden(request: PermissionInputV2): boolean {
  return !STANDING_CAPABILITIES.includes(request.capability) || (request.capability === 'tool.execute' && (request.reason.startsWith(CUSTOM_PYTHON_PREFIX) || !request.agentTool));
}

/**
 * Exact StandingGrantScope semantics: bot, capability and every scope field must match, and the
 * grant must be neither revoked nor expired. `request` paths/cwd must already be canonical.
 * `workspace` is the task's canonical workspace; folders outside it never match.
 */
export function matches(grant: StandingGrant, request: PermissionInputV2 & {env?: boolean}, botId: string, workspace: string | undefined, now = Date.now(), platform: NodeJS.Platform = process.platform): boolean {
  if (grant.botId !== botId || grant.capability !== request.capability || !active(grant, now) || standingForbidden(request)) return false;
  const scope = grant.scope;
  switch (request.capability) {
    case 'file.read': case 'file.write': case 'file.delete':
      return !!workspace && !!scope.folder && isWithin(workspace, scope.folder, platform) && !!request.paths?.length
        && request.paths.every(path => isWithin(scope.folder!, path.path, platform) && isWithin(workspace, path.path, platform));
    case 'process.spawn': {
      const command = request.command; const prefix = scope.commandPrefix;
      if (!workspace || !command || !prefix?.length || request.env) return false;
      const folder = scope.folder ?? workspace;
      if (!isWithin(workspace, folder, platform) || !isWithin(folder, command.cwd, platform)) return false;
      const argv = [command.command, ...command.args];
      return prefix.length <= argv.length && prefix.every((token, index) => token === argv[index]);
    }
    case 'mcp.call':
      return !!request.mcp && !!scope.mcp && scope.mcp.serverId === request.mcp.serverId && (scope.mcp.tool === undefined || scope.mcp.tool === request.mcp.tool);
    case 'tool.execute':
      return !!scope.agentToolKind && request.agentTool?.kind === scope.agentToolKind;
    default: return false;
  }
}

/** Human-readable audit subject: canonical path(s), argv, server/tool, or tool title. */
export function subject(request: PermissionInputV2): string {
  let text: string;
  if (request.paths?.length) text = request.paths.map(path => path.path).join('\n');
  else if (request.command) text = `${JSON.stringify([request.command.command, ...request.command.args])} in ${request.command.cwd}`;
  else if (request.mcp) text = `${request.mcp.serverId}/${request.mcp.tool}`;
  else if (request.agentTool) text = `${request.agentTool.kind ?? 'tool'}: ${request.agentTool.title}`;
  else if (request.packages?.length) text = request.packages.join(' ');
  else text = request.reason.split('\n')[0];
  return text.slice(0, 4096);
}
