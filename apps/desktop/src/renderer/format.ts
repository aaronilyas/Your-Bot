import type { Bot, CapabilityV2, PermissionRequestV2, RoutineSchedule, StandingGrant, StandingGrantScope } from '@your-bot/contracts';

export function formatTime(iso: string | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
export function describeSchedule(schedule: RoutineSchedule): string {
  switch (schedule.kind) {
    case 'interval': return schedule.everyMinutes % 60 === 0 && schedule.everyMinutes >= 60 ? `Every ${schedule.everyMinutes / 60} h` : `Every ${schedule.everyMinutes} min`;
    case 'cron': return `Cron ${schedule.expression}${schedule.timezone ? ` (${schedule.timezone})` : ''}`;
    case 'once': return `Once at ${formatTime(schedule.at)}`;
  }
}
export function describeScope(scope: StandingGrantScope): string {
  const parts: string[] = [];
  if (scope.folder) parts.push(`folder ${scope.folder}`);
  if (scope.commandPrefix) parts.push(`command ${scope.commandPrefix.join(' ')} …`);
  if (scope.mcp) parts.push(scope.mcp.tool ? `MCP ${scope.mcp.serverId} · ${scope.mcp.tool}` : `MCP ${scope.mcp.serverId} · every tool`);
  if (scope.agentToolKind) parts.push(`agent tool kind “${scope.agentToolKind}”`);
  return parts.join(' · ') || 'no scope';
}
/** One-line subject of a request, used in lists. */
export function requestSubject(request: PermissionRequestV2): string {
  if (request.paths?.length) return request.paths.map(path => path.path).join(', ');
  if (request.command) return [request.command.command, ...request.command.args].join(' ');
  if (request.mcp) return `${request.mcp.serverId} · ${request.mcp.tool}`;
  if (request.agentTool) return request.agentTool.title;
  if (request.packages?.length) return request.packages.join(', ');
  return request.reason.slice(0, 120);
}
export const botName = (bots: Bot[], id: string | undefined): string => bots.find(bot => bot.id === id)?.name ?? (id ? `Unknown bot (${id.slice(0, 8)})` : 'No bot');
export const capabilityLabel = (capability: CapabilityV2): string => capability;
export function grantLabel(grant: StandingGrant, bots: Bot[]): string { return `${botName(bots, grant.botId)} · ${grant.capability} · ${describeScope(grant.scope)}`; }
