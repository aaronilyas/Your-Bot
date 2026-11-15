import type { Bot, PermissionDecisionV2, PermissionRequestV2, StandingGrantScope } from '@your-bot/contracts';

/** Request that never gets a standing option: reasons that identify arbitrary code. */
export const CUSTOM_PYTHON_PREFIX = 'Execute custom Python sha256:';
export type StandingKind = 'folder' | 'command' | 'mcp' | 'tool';

/**
 * Which standing-grant scope shape (if any) the UI may offer for a request. Custom Python,
 * library.install, network and settings requests never qualify, nor do commands that set env
 * (they never match a standing grant), nor requests without a bot.
 */
export function standingKind(request: PermissionRequestV2): StandingKind | undefined {
  if (!request.botId || request.reason.startsWith(CUSTOM_PYTHON_PREFIX)) return undefined;
  switch (request.capability) {
    case 'file.read': case 'file.write': case 'file.delete':
      return request.paths?.length && request.paths.every(path => `file.${path.access}` === request.capability) ? 'folder' : undefined;
    case 'process.spawn': return request.command && !request.command.env?.length ? 'command' : undefined;
    case 'mcp.call': return request.mcp ? 'mcp' : undefined;
    case 'tool.execute': return request.agentTool?.kind ? 'tool' : undefined;
    default: return undefined;
  }
}

/* ---- path helpers (POSIX and Windows spellings; Windows compares case-insensitively) ---- */
interface ParsedPath { windows: boolean; root: string; parts: string[]; }
const isWindowsPath = (path: string): boolean => /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
export function parsePath(path: string): ParsedPath | undefined {
  if (path.includes('\0')) return undefined;
  if (isWindowsPath(path)) {
    const normal = path.replace(/\//g, '\\');
    const unc = normal.startsWith('\\\\');
    const parts = normal.split('\\').filter(Boolean);
    const root = unc ? `\\\\${parts.shift() ?? ''}\\${parts.shift() ?? ''}` : parts.shift()!;
    return { windows: true, root, parts };
  }
  return path.startsWith('/') ? { windows: false, root: '/', parts: path.split('/').filter(Boolean) } : undefined;
}
export function formatPath(path: ParsedPath): string {
  if (!path.windows) return `/${path.parts.join('/')}`;
  return path.parts.length ? `${path.root}\\${path.parts.join('\\')}` : `${path.root}\\`;
}
const same = (windows: boolean, a: string, b: string): boolean => windows ? a.toLowerCase() === b.toLowerCase() : a === b;
export function isWithinFolder(path: string, folder: string): boolean {
  const p = parsePath(path), f = parsePath(folder);
  if (!p || !f || p.windows !== f.windows || !same(p.windows, p.root, f.root) || f.parts.length > p.parts.length) return false;
  return f.parts.every((part, index) => same(p.windows, part, p.parts[index]));
}
export function parentFolder(path: string): string | undefined {
  const p = parsePath(path);
  return p ? formatPath({ ...p, parts: p.parts.slice(0, -1) }) : undefined;
}
/** The deepest folder containing every path (each path's parent directory). */
export function commonParent(paths: string[]): string | undefined {
  const parents = paths.map(path => { const folder = parentFolder(path); return folder ? parsePath(folder) : undefined; });
  if (!parents.length || parents.some(parent => !parent)) return undefined;
  const first = parents[0]!;
  let depth = first.parts.length;
  for (const parent of parents as ParsedPath[]) {
    if (parent.windows !== first.windows || !same(first.windows, parent.root, first.root)) return undefined;
    let shared = 0;
    while (shared < Math.min(depth, parent.parts.length) && same(first.windows, parent.parts[shared], first.parts[shared])) shared++;
    depth = shared;
  }
  return formatPath({ ...first, parts: first.parts.slice(0, depth) });
}

export const argvOf = (request: PermissionRequestV2): string[] => request.command ? [request.command.command, ...request.command.args] : [];

/** Defaults offered when the owner opens "Always allow…". */
export function defaultStandingScope(request: PermissionRequestV2): StandingGrantScope | undefined {
  switch (standingKind(request)) {
    case 'folder': { const folder = commonParent(request.paths!.map(path => path.path)); return folder ? { folder } : undefined; }
    case 'command': return { commandPrefix: [request.command!.command] };
    case 'mcp': return { mcp: { serverId: request.mcp!.serverId, tool: request.mcp!.tool } };
    case 'tool': return { agentToolKind: request.agentTool!.kind! };
    default: return undefined;
  }
}

/** Returns an error message, or undefined when the scope is acceptable for this request (and bot). */
export function standingScopeError(request: PermissionRequestV2, scope: StandingGrantScope, bot?: Bot): string | undefined {
  switch (standingKind(request)) {
    case 'folder': {
      const folder = scope.folder?.trim();
      if (!folder || !parsePath(folder)) return 'Enter an absolute folder path.';
      if (!request.paths!.every(path => isWithinFolder(path.path, folder))) return 'The folder must be the requested file’s folder or a parent of every requested path.';
      if (bot?.workspace && !isWithinFolder(folder, bot.workspace)) return 'The folder must be inside this bot’s workspace.';
      return undefined;
    }
    case 'command': {
      const argv = argvOf(request), prefix = scope.commandPrefix ?? [];
      if (!prefix.length || prefix.some(token => token.length === 0)) return 'The command prefix needs at least one token and no empty tokens.';
      if (prefix.length > argv.length || prefix.some((token, index) => token !== argv[index])) return 'The prefix must match the beginning of the requested command.';
      return undefined;
    }
    case 'mcp': return scope.mcp?.serverId === request.mcp!.serverId && (!scope.mcp.tool || scope.mcp.tool === request.mcp!.tool) ? undefined : 'The scope must cover this MCP call.';
    case 'tool': return scope.agentToolKind === request.agentTool!.kind ? undefined : 'The scope must match the requested tool kind.';
    default: return 'This kind of request can never be allowed permanently.';
  }
}

export function standingDecision(request: PermissionRequestV2, scope: StandingGrantScope, expiresAt?: string): PermissionDecisionV2 {
  return { requestId: request.id, outcome: 'allow', scope: 'standing', standing: scope, ...(expiresAt ? { standingExpiresAt: expiresAt } : {}) };
}
