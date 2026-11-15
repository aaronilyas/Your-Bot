import { z } from 'zod';
import type { AnyCommandResult, Bot, DesktopCommand, DesktopCommandV2, DesktopEventV2, McpServerConfig, Principal, PrincipalV2 } from '@your-bot/contracts';
const id = z.string().min(1).max(256);
const short = z.string().max(2048);
const fileScope = z.strictObject({ path: z.string().min(1).max(8192), access: z.enum(['read', 'write', 'delete']) });
const provider = z.strictObject({
  id, name: short, kind: z.enum(['lmstudio', 'llamacpp', 'openai-compatible', 'acp']),
  endpoint: short.optional(), modelId: id.optional(), apiKey: z.string().max(8192).optional(),
  command: short.optional(), args: z.array(short).max(128).optional(), enabled: z.boolean(),
});
const toolInvocation = z.strictObject({ id, kind: z.enum(['skill', 'python', 'library.install']), skillId: id.optional(), input: z.json(), code: z.string().max(262144).optional(), packages: z.array(short).max(256).optional(), paths: z.array(fileScope).max(256).optional(), timeoutMs: z.number().int().positive().max(3600000).optional() });
const base = { version: z.literal(1), id };
const commandSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...base, type: z.literal('state.sync'), afterSequence: z.number().int().nonnegative().optional() }),
  z.strictObject({ ...base, type: z.literal('session.create'), title: short.optional(), agentId: id, modelId: id.optional() }),
  z.strictObject({ ...base, type: z.literal('session.open'), sessionId: id }),
  z.strictObject({ ...base, type: z.literal('session.delete'), sessionId: id }),
  z.strictObject({ ...base, type: z.literal('session.selectAgent'), sessionId: id, agentId: id, modelId: id.optional() }),
  z.strictObject({ ...base, type: z.literal('message.send'), sessionId: id, content: z.string().min(1).max(262144) }),
  z.strictObject({ ...base, type: z.literal('task.cancel'), taskId: id }),
  z.strictObject({ ...base, type: z.literal('permission.decide'), decision: z.strictObject({ requestId: id, outcome: z.enum(['allow', 'deny']), scope: z.enum(['once', 'task']) }) }),
  z.strictObject({ ...base, type: z.literal('settings.update'), settings: z.strictObject({ providers: z.array(provider).max(64) }) }),
  z.strictObject({ ...base, type: z.literal('models.refresh'), agentId: id.optional() }),
  z.strictObject({ ...base, type: z.literal('tool.run'), sessionId: id, invocation: toolInvocation }),
]);
/** Bound both bytes and depth before recursive schema validation. */
function bounded(value: unknown): void {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { throw new Error('Command must be JSON'); }
  if (!encoded || encoded.length > 1048576) throw new Error('Command is too large');
  const visit = (v: unknown, depth: number): void => {
    if (depth > 24) throw new Error('Command is too deeply nested');
    if (v && typeof v === 'object') {
      if (Object.keys(v).some(k => ['__proto__', 'constructor', 'prototype'].includes(k))) throw new Error('Unsafe command key');
      for (const child of Object.values(v)) visit(child, depth + 1);
    }
  };
  visit(value, 0);
}
export function parseCommand(value: unknown): DesktopCommand {
  bounded(value);
  return commandSchema.parse(value) as DesktopCommand;
}

/* ------------------------------------------------------------ contract v2 */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SKILL_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MCP_SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const KIND = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const noNul = (v: string) => !v.includes('\0');
const text = (max: number, empty = false) => z.string().max(max).refine(noNul, 'NUL is not allowed').refine(v => empty || v.length > 0, 'Required');
const entityId = z.string().regex(ID);
const absolute = text(4096).refine(v => v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v) || v.startsWith('\\\\'), 'Absolute path required');
const isoTime = z.string().max(64).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/).refine(v => Number.isFinite(Date.parse(v)), 'Invalid time');
const secretMap = (key: RegExp) => z.record(z.string().regex(key), text(32768, true)).refine(v => Object.keys(v).length <= 64, 'Too many entries');
const mcpBase = { id: z.string().regex(MCP_SERVER_ID), name: text(256), enabled: z.boolean(), preset: z.literal('browser').optional() };
const mcpServer = z.discriminatedUnion('transport', [
  z.strictObject({ ...mcpBase, transport: z.literal('stdio'), command: text(4096), args: z.array(text(32768, true)).max(256).optional(), env: secretMap(ENV_NAME).optional(), cwd: absolute.optional() }),
  z.strictObject({ ...mcpBase, transport: z.literal('http'), url: text(4096).refine(v => { try { const u = new URL(v); return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password; } catch { return false; } }, 'Invalid MCP URL'), headers: secretMap(HEADER_NAME).optional() }),
]);
const mcpServers = z.array(mcpServer).max(32).refine(list => new Set(list.map(server => server.id)).size === list.length, 'Duplicate MCP server id');
const compaction = z.strictObject({ maxMessages: z.number().int().min(2).max(100000), keepRecent: z.number().int().min(0).max(100000) }).refine(v => v.keepRecent < v.maxMessages, 'keepRecent must be below maxMessages');
const skills = z.array(z.string().regex(SKILL_ID)).max(200).refine(list => new Set(list).size === list.length, 'Duplicate skill');
const botFields = {
  name: text(256), instructions: text(65536, true), agentId: text(256), modelId: text(256), workspace: absolute,
  profile: z.enum(['strict', 'trusted']), mcpServers, skills, memoryEnabled: z.boolean(), compaction,
};
const botInput = z.strictObject({
  name: botFields.name, instructions: botFields.instructions, agentId: botFields.agentId, modelId: botFields.modelId.optional(), workspace: botFields.workspace.optional(),
  profile: botFields.profile, mcpServers, skills, memoryEnabled: botFields.memoryEnabled, compaction: compaction.optional(),
});
const botPatch = z.strictObject({
  name: botFields.name.optional(), instructions: botFields.instructions.optional(), agentId: botFields.agentId.optional(),
  modelId: botFields.modelId.nullable().optional(), workspace: botFields.workspace.nullable().optional(), profile: botFields.profile.optional(),
  mcpServers: mcpServers.optional(), skills: skills.optional(), memoryEnabled: botFields.memoryEnabled.optional(), compaction: compaction.nullable().optional(),
});
const capabilityV2 = z.enum(['conversation', 'settings', 'tool.execute', 'file.read', 'file.write', 'file.delete', 'library.install', 'network', 'process.spawn', 'mcp.call']);
const standingScope = z.strictObject({
  folder: absolute.optional(), commandPrefix: z.array(text(4096)).min(1).max(64).optional(),
  mcp: z.strictObject({ serverId: text(64), tool: text(256).optional() }).optional(), agentToolKind: z.string().regex(KIND).optional(),
});
const decisionV2 = z.strictObject({
  requestId: id, outcome: z.enum(['allow', 'deny']), scope: z.enum(['once', 'task', 'standing']), standing: standingScope.optional(), standingExpiresAt: isoTime.optional(),
}).superRefine((value, ctx) => {
  const standing = value.scope === 'standing';
  if (standing && (value.outcome !== 'allow' || !value.standing)) ctx.addIssue({ code: 'custom', message: 'Standing decisions must allow and carry a scope' });
  if (!standing && (value.standing || value.standingExpiresAt)) ctx.addIssue({ code: 'custom', message: 'Standing fields require scope standing' });
});
const providerV2 = z.strictObject({ ...provider.shape, launch: z.enum(['contained', 'host']).optional(), envPassthrough: z.array(z.string().regex(ENV_NAME)).max(64).optional() });
const schedule = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('interval'), everyMinutes: z.number().int().min(1).max(525600) }),
  z.strictObject({ kind: z.literal('cron'), expression: text(256).refine(v => v.trim().split(/\s+/).length === 5, 'Five fields required'), timezone: text(128).optional() }),
  z.strictObject({ kind: z.literal('once'), at: isoTime }),
]);
const routineFields = {
  botId: entityId, name: text(256), prompt: text(1000000), schedule, missedRunPolicy: z.enum(['skip', 'runOnce', 'runAll']),
  maxCatchUp: z.number().int().min(1).max(1000), enabled: z.boolean(), sessionMode: z.enum(['new', 'reuse']),
};
const routineInput = z.strictObject({ ...routineFields, maxCatchUp: routineFields.maxCatchUp.optional() });
const routinePatch = z.strictObject(Object.fromEntries(Object.entries(routineFields).map(([key, schema]) => [key, schema.optional()])) as { [K in keyof typeof routineFields]: z.ZodOptional<(typeof routineFields)[K]> });
const base2 = { version: z.literal(2), id };
const commandSchemaV2 = z.discriminatedUnion('type', [
  z.strictObject({ ...base2, type: z.literal('state.sync'), afterSequence: z.number().int().nonnegative().optional() }),
  z.strictObject({ ...base2, type: z.literal('bot.create'), bot: botInput }),
  z.strictObject({ ...base2, type: z.literal('bot.update'), botId: entityId, patch: botPatch }),
  z.strictObject({ ...base2, type: z.literal('bot.delete'), botId: entityId }),
  z.strictObject({ ...base2, type: z.literal('bot.session.create'), botId: entityId, title: text(512, true).optional() }),
  z.strictObject({ ...base2, type: z.literal('permission.decide'), decision: decisionV2 }),
  z.strictObject({ ...base2, type: z.literal('settings.update'), settings: z.strictObject({ providers: z.array(providerV2).max(128) }) }),
  z.strictObject({ ...base2, type: z.literal('grant.create'), grant: z.strictObject({ botId: entityId, capability: capabilityV2, scope: standingScope, expiresAt: isoTime.optional() }) }),
  z.strictObject({ ...base2, type: z.literal('grant.revoke'), grantId: entityId }),
  z.strictObject({ ...base2, type: z.literal('audit.list'), botId: entityId.optional(), limit: z.number().int().min(1).max(500).optional(), beforeId: entityId.optional() }),
  z.strictObject({ ...base2, type: z.literal('memory.list'), botId: entityId }),
  z.strictObject({ ...base2, type: z.literal('memory.add'), botId: entityId, content: text(65536) }),
  z.strictObject({ ...base2, type: z.literal('memory.delete'), botId: entityId, memoryId: entityId }),
  z.strictObject({ ...base2, type: z.literal('session.compact'), sessionId: id }),
  z.strictObject({ ...base2, type: z.literal('routine.create'), routine: routineInput }),
  z.strictObject({ ...base2, type: z.literal('routine.update'), routineId: entityId, patch: routinePatch }),
  z.strictObject({ ...base2, type: z.literal('routine.delete'), routineId: entityId }),
  z.strictObject({ ...base2, type: z.literal('routine.runNow'), routineId: entityId }),
  z.strictObject({ ...base2, type: z.literal('routine.runs'), routineId: entityId, limit: z.number().int().min(1).max(500).optional() }),
  z.strictObject({ ...base2, type: z.literal('notification.ack'), notificationId: entityId }),
  z.strictObject({ ...base2, type: z.literal('device.pair.start'), name: text(256).optional(), capabilities: z.array(capabilityV2).max(10).optional() }),
  z.strictObject({ ...base2, type: z.literal('device.list') }),
  z.strictObject({ ...base2, type: z.literal('device.revoke'), deviceId: entityId }),
  z.strictObject({ ...base2, type: z.literal('skills.refresh') }),
  // v1 command types keep their v1 meaning under version 2.
  z.strictObject({ ...base2, type: z.literal('session.create'), title: short.optional(), agentId: id, modelId: id.optional() }),
  z.strictObject({ ...base2, type: z.literal('session.open'), sessionId: id }),
  z.strictObject({ ...base2, type: z.literal('session.delete'), sessionId: id }),
  z.strictObject({ ...base2, type: z.literal('session.selectAgent'), sessionId: id, agentId: id, modelId: id.optional() }),
  z.strictObject({ ...base2, type: z.literal('message.send'), sessionId: id, content: z.string().min(1).max(262144) }),
  z.strictObject({ ...base2, type: z.literal('task.cancel'), taskId: id }),
  z.strictObject({ ...base2, type: z.literal('models.refresh'), agentId: id.optional() }),
  z.strictObject({ ...base2, type: z.literal('tool.run'), sessionId: id, invocation: toolInvocation }),
]);
export function parseCommandV2(value: unknown): DesktopCommandV2 {
  bounded(value);
  return commandSchemaV2.parse(value) as DesktopCommandV2;
}
/** Accepts exactly the v1 and v2 command frames; the version field selects the schema. */
export function parseAnyCommand(value: unknown): DesktopCommand | DesktopCommandV2 {
  const version = typeof value === 'object' && value !== null && 'version' in value ? value.version : undefined;
  if (version === 1) return parseCommand(value);
  if (version === 2) return parseCommandV2(value);
  throw new Error('Unsupported contract version');
}
export function trustedRendererURL(url: string, expected: string): boolean {
  try {
    const actual = new URL(url), allowed = new URL(expected);
    actual.hash = ''; allowed.hash = '';
    return actual.href === allowed.href;
  } catch { return false; }
}
export function validateDevelopmentURL(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('Development renderer must be a loopback HTTP origin with no path, credentials, or query');
  }
  return parsed.href;
}
export const PRODUCTION_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'";
export function rendererCSP(developmentURL?: string): string {
  if (!developmentURL) return PRODUCTION_CSP;
  const origin = new URL(validateDevelopmentURL(developmentURL)).origin;
  return PRODUCTION_CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace("style-src 'self'", "style-src 'self' 'unsafe-inline'").replace("connect-src 'none'", `connect-src ${origin} ${origin.replace('http:', 'ws:')}`);
}
const blank = (values: Record<string, string> | undefined): Record<string, string> | undefined => values && Object.fromEntries(Object.keys(values).map(key => [key, '']));
/** Defense in depth: MCP env/header values never reach the renderer, whatever the gateway sent. */
export function redactBot(bot: Bot): Bot {
  if (!Array.isArray(bot.mcpServers)) return bot;
  return { ...bot, mcpServers: bot.mcpServers.map((server): McpServerConfig => server.transport === 'stdio'
    ? { ...server, ...(server.env ? { env: blank(server.env) } : {}) }
    : { ...server, ...(server.headers ? { headers: blank(server.headers) } : {}) }) };
}
export function redactSnapshot<T extends { settings: { providers: { apiKey?: string }[] }; bots?: Bot[] }>(snapshot: T): T {
  return {
    ...snapshot,
    settings: { ...snapshot.settings, providers: snapshot.settings.providers.map(({ apiKey: _secret, ...config }) => config) },
    ...(Array.isArray(snapshot.bots) ? { bots: snapshot.bots.map(redactBot) } : {}),
  };
}
export function redactResult(result: AnyCommandResult): AnyCommandResult {
  if (!result.ok) return result;
  return {
    ...result,
    ...(result.snapshot ? { snapshot: redactSnapshot(result.snapshot as Parameters<typeof redactSnapshot>[0]) as typeof result.snapshot } : {}),
    ...('bot' in result && result.bot ? { bot: redactBot(result.bot) } : {}),
  } as AnyCommandResult;
}
export function rendererEvent(event: DesktopEventV2, principal: Principal | PrincipalV2): DesktopEventV2 | undefined {
  if (event.principalId !== principal.id) return undefined;
  if (event.type === 'state.snapshot') return { ...event, snapshot: redactSnapshot(event.snapshot) };
  if (event.type === 'bot.updated') return { ...event, bot: redactBot(event.bot) };
  return event;
}
