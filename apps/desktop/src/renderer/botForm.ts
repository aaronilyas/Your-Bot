import type { Bot, BotInput, BotPatch, CompactionPolicy, ExecutionProfile, McpServerConfig } from '@your-bot/contracts';

export interface KeyValueRow { key: string; value: string; /** Stored secret: the host returns the key with an empty value. */ stored: boolean; }
export interface McpForm {
  /** True while the server has never been saved: its id may still be edited. */
  isNew: boolean;
  id: string; name: string; enabled: boolean; preset?: 'browser';
  transport: 'stdio' | 'http';
  command: string; args: string; cwd: string; env: KeyValueRow[];
  url: string; headers: KeyValueRow[];
}
export interface BotForm {
  name: string; instructions: string; agentId: string; modelId: string; workspace: string;
  profile: ExecutionProfile; understood: boolean;
  mcp: McpForm[]; skills: string[]; memoryEnabled: boolean;
  compact: boolean; maxMessages: string; keepRecent: string;
}

const rows = (values: Record<string, string> | undefined): KeyValueRow[] => Object.keys(values ?? {}).map(key => ({ key, value: '', stored: true }));
export function mcpFormFromServer(server: McpServerConfig): McpForm {
  const common = { isNew: false, id: server.id, name: server.name, enabled: server.enabled, ...(server.preset ? { preset: server.preset } : {}) };
  return server.transport === 'stdio'
    ? { ...common, transport: 'stdio', command: server.command, args: (server.args ?? []).join('\n'), cwd: server.cwd ?? '', env: rows(server.env), url: '', headers: [] }
    : { ...common, transport: 'http', command: '', args: '', cwd: '', env: [], url: server.url, headers: rows(server.headers) };
}
export const browserPreset = (): McpForm => ({ isNew: true, id: 'browser', name: 'Browser automation', enabled: true, preset: 'browser', transport: 'stdio', command: 'npx', args: '', cwd: '', env: [], url: '', headers: [] });
export const blankMcp = (existing: McpForm[]): McpForm => {
  let n = existing.length + 1; while (existing.some(server => server.id === `server-${n}`)) n++;
  return { isNew: true, id: `server-${n}`, name: '', enabled: true, transport: 'stdio', command: '', args: '', cwd: '', env: [], url: '', headers: [] };
};
const toMap = (list: KeyValueRow[]): Record<string, string> | undefined => {
  const entries = list.filter(row => row.key.trim()).map(row => [row.key.trim(), row.value] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
};
export function mcpServerFromForm(form: McpForm): McpServerConfig {
  const base = { id: form.id.trim(), name: form.name.trim(), enabled: form.enabled, ...(form.preset ? { preset: form.preset } : {}) };
  if (form.transport === 'http') {
    const headers = toMap(form.headers);
    return { ...base, transport: 'http', url: form.url.trim(), ...(headers ? { headers } : {}) };
  }
  const args = form.args.split('\n').map(line => line.trim()).filter(Boolean);
  const env = toMap(form.env);
  return { ...base, transport: 'stdio', command: form.command.trim(), ...(args.length ? { args } : {}), ...(env ? { env } : {}), ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}) };
}
export function formFromBot(bot: Bot): BotForm {
  return {
    name: bot.name, instructions: bot.instructions, agentId: bot.agentId, modelId: bot.modelId ?? '', workspace: bot.workspace ?? '',
    profile: bot.profile, understood: bot.profile === 'trusted', mcp: bot.mcpServers.map(mcpFormFromServer), skills: [...bot.skills], memoryEnabled: bot.memoryEnabled,
    compact: Boolean(bot.compaction), maxMessages: String(bot.compaction?.maxMessages ?? 60), keepRecent: String(bot.compaction?.keepRecent ?? 12),
  };
}
export const blankBotForm = (agentId = '', modelId = ''): BotForm => ({
  name: '', instructions: '', agentId, modelId, workspace: '', profile: 'strict', understood: false, mcp: [], skills: [], memoryEnabled: true, compact: false, maxMessages: '60', keepRecent: '12',
});

const MCP_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const ABSOLUTE = /^(\/|[A-Za-z]:[\\/]|\\\\)/;
export function compactionOf(form: BotForm): CompactionPolicy | undefined {
  return form.compact ? { maxMessages: Number(form.maxMessages), keepRecent: Number(form.keepRecent) } : undefined;
}
export function validateBotForm(form: BotForm): string | undefined {
  if (!form.name.trim()) return 'Give the bot a name.';
  if (!form.agentId) return 'Choose an agent.';
  if (form.workspace && !ABSOLUTE.test(form.workspace)) return 'The workspace must be an absolute folder path.';
  if (form.profile === 'trusted') {
    if (!form.workspace) return 'Trusted bots need a workspace folder.';
    if (!form.understood) return 'Confirm that you understand a trusted bot runs its agent uncontained.';
  }
  const ids = new Set<string>();
  for (const server of form.mcp) {
    const label = server.name.trim() || server.id;
    if (!server.name.trim()) return 'Give every MCP server a name.';
    if (!MCP_ID.test(server.id.trim())) return `MCP server id “${server.id}” may only contain letters, digits and hyphens.`;
    if (ids.has(server.id.trim())) return `MCP server id “${server.id}” is used twice.`;
    ids.add(server.id.trim());
    if (server.transport === 'stdio' && !server.command.trim()) return `MCP server “${label}” needs a command.`;
    if (server.cwd.trim() && !ABSOLUTE.test(server.cwd.trim())) return `MCP server “${label}” needs an absolute working folder.`;
    if (server.transport === 'http') { try { const url = new URL(server.url.trim()); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(); } catch { return `MCP server “${label}” needs an http(s) URL without embedded credentials.`; } }
    for (const row of [...server.env, ...server.headers]) if (row.key.trim() === '' && row.value !== '') return `MCP server “${label}” has a value without a name.`;
  }
  if (form.compact) {
    const max = Number(form.maxMessages), keep = Number(form.keepRecent);
    if (!Number.isInteger(max) || max < 2 || !Number.isInteger(keep) || keep < 0 || keep >= max) return 'Compaction: keep fewer recent messages than the maximum (maximum at least 2).';
  }
  return undefined;
}
export function botInputFromForm(form: BotForm): BotInput {
  const compaction = compactionOf(form);
  return {
    name: form.name.trim(), instructions: form.instructions, agentId: form.agentId, ...(form.modelId ? { modelId: form.modelId } : {}),
    ...(form.workspace.trim() ? { workspace: form.workspace.trim() } : {}), profile: form.profile, mcpServers: form.mcp.map(mcpServerFromForm),
    skills: form.skills, memoryEnabled: form.memoryEnabled, ...(compaction ? { compaction } : {}),
  };
}
/** Only changed fields; null clears modelId, workspace and compaction. Empty when nothing changed. */
export function botPatchFromForm(bot: Bot, form: BotForm): BotPatch {
  const input = botInputFromForm(form);
  const patch: BotPatch = {};
  if (input.name !== bot.name) patch.name = input.name;
  if (input.instructions !== bot.instructions) patch.instructions = input.instructions;
  if (input.agentId !== bot.agentId) patch.agentId = input.agentId;
  if (input.profile !== bot.profile) patch.profile = input.profile;
  if (input.memoryEnabled !== bot.memoryEnabled) patch.memoryEnabled = input.memoryEnabled;
  if (input.modelId !== bot.modelId) patch.modelId = input.modelId ?? null;
  if (input.workspace !== bot.workspace) patch.workspace = input.workspace ?? null;
  if (JSON.stringify(input.mcpServers) !== JSON.stringify(bot.mcpServers.map(server => mcpServerFromForm(mcpFormFromServer(server))))) patch.mcpServers = input.mcpServers;
  if (JSON.stringify(input.skills) !== JSON.stringify(bot.skills)) patch.skills = input.skills;
  if (JSON.stringify(input.compaction) !== JSON.stringify(bot.compaction)) patch.compaction = input.compaction ?? null;
  return patch;
}
