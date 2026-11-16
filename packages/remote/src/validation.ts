/**
 * Strict validation of untrusted remote frames, mirroring the Electron IPC rigor
 * (apps/desktop/src/main/security.ts): byte/depth bounds, no prototype keys, strict schemas
 * (unknown keys rejected), and v2 commands only. Core re-validates; this is defense in depth
 * and keeps malformed or oversized input away from the gateway.
 */
import { z } from 'zod';
import type { AppSnapshotV2, CommandResultV2, DesktopCommandV2, DesktopEventV2 } from '@your-bot/contracts';
import { ALL_CAPABILITIES_V2, MAX_FRAME_BYTES } from './protocol.js';

const id = z.string().min(1).max(256);
const short = z.string().max(2048);
const text = (max: number) => z.string().max(max);
const iso = z.string().min(1).max(64);
const capability = z.enum(ALL_CAPABILITIES_V2 as [string, ...string[]]);
const fileScope = z.strictObject({ path: z.string().min(1).max(8192), access: z.enum(['read', 'write', 'delete']) });
const record = z.record(z.string().min(1).max(256), text(8192));
const mcpBase = { id, name: short, enabled: z.boolean(), preset: z.literal('browser').optional() };
const mcpServer = z.discriminatedUnion('transport', [
  z.strictObject({ ...mcpBase, transport: z.literal('stdio'), command: short, args: z.array(short).max(128).optional(), env: record.optional(), cwd: text(8192).optional() }),
  z.strictObject({ ...mcpBase, transport: z.literal('http'), url: short, headers: record.optional() }),
]);
const botFields = {
  name: short, instructions: text(65536), agentId: id, modelId: id.optional(), workspace: text(8192).optional(),
  profile: z.enum(['strict', 'trusted']), mcpServers: z.array(mcpServer).max(64), skills: z.array(id).max(200),
  memoryEnabled: z.boolean(), compaction: z.strictObject({ maxMessages: z.number().int().positive().max(100000), keepRecent: z.number().int().nonnegative().max(100000) }).optional(),
};
const bot = z.strictObject(botFields);
const botPatch = z.strictObject(botFields).partial();
const schedule = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('interval'), everyMinutes: z.number().int().positive().max(527040) }),
  z.strictObject({ kind: z.literal('cron'), expression: text(256), timezone: text(128).optional() }),
  z.strictObject({ kind: z.literal('once'), at: iso }),
]);
const routineFields = {
  botId: id, name: short, prompt: text(262144), schedule, missedRunPolicy: z.enum(['skip', 'runOnce', 'runAll']),
  maxCatchUp: z.number().int().nonnegative().max(1000).optional(), enabled: z.boolean(), sessionMode: z.enum(['new', 'reuse']),
};
const standingScope = z.strictObject({
  folder: text(8192).optional(), commandPrefix: z.array(short).min(1).max(128).optional(),
  mcp: z.strictObject({ serverId: id, tool: id.optional() }).optional(), agentToolKind: id.optional(),
});
const base = { version: z.literal(2), id };
const cmd = <T extends z.ZodRawShape>(type: string, shape: T) => z.strictObject({ ...base, type: z.literal(type), ...shape });

const commandSchema = z.discriminatedUnion('type', [
  cmd('state.sync', { afterSequence: z.number().int().nonnegative().optional() }),
  cmd('session.create', { title: short.optional(), agentId: id, modelId: id.optional() }),
  cmd('session.open', { sessionId: id }),
  cmd('session.delete', { sessionId: id }),
  cmd('session.selectAgent', { sessionId: id, agentId: id, modelId: id.optional() }),
  cmd('message.send', { sessionId: id, content: z.string().min(1).max(262144) }),
  cmd('task.cancel', { taskId: id }),
  cmd('models.refresh', { agentId: id.optional() }),
  cmd('tool.run', { sessionId: id, invocation: z.strictObject({ id, kind: z.enum(['skill', 'python', 'library.install']), skillId: id.optional(), input: z.json(), code: z.string().max(262144).optional(), packages: z.array(short).max(256).optional(), paths: z.array(fileScope).max(256).optional(), timeoutMs: z.number().int().positive().max(3600000).optional() }) }),
  cmd('permission.decide', { decision: z.strictObject({ requestId: id, outcome: z.enum(['allow', 'deny']), scope: z.enum(['once', 'task', 'standing']), standing: standingScope.optional(), standingExpiresAt: iso.optional() }) }),
  cmd('bot.create', { bot }),
  cmd('bot.update', { botId: id, patch: botPatch }),
  cmd('bot.delete', { botId: id }),
  cmd('bot.session.create', { botId: id, title: short.optional() }),
  cmd('grant.create', { grant: z.strictObject({ botId: id, capability, scope: standingScope, expiresAt: iso.optional() }) }),
  cmd('grant.revoke', { grantId: id }),
  cmd('audit.list', { botId: id.optional(), limit: z.number().int().positive().max(1000).optional(), beforeId: id.optional() }),
  cmd('memory.list', { botId: id }),
  cmd('memory.add', { botId: id, content: z.string().min(1).max(65536) }),
  cmd('memory.delete', { botId: id, memoryId: id }),
  cmd('session.compact', { sessionId: id }),
  cmd('routine.create', { routine: z.strictObject(routineFields) }),
  cmd('routine.update', { routineId: id, patch: z.strictObject(routineFields).partial() }),
  cmd('routine.delete', { routineId: id }),
  cmd('routine.runNow', { routineId: id }),
  cmd('routine.runs', { routineId: id, limit: z.number().int().positive().max(1000).optional() }),
  cmd('notification.ack', { notificationId: id }),
  cmd('skills.refresh', {}),
]);

/** Owner-only (local principal) commands: never forwarded from a remote device. */
export const OWNER_ONLY_COMMANDS: ReadonlySet<string> = new Set(['settings.update', 'device.pair.start', 'device.list', 'device.revoke']);

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Rejects deep nesting and prototype-polluting keys before schema validation. */
export function checkShape(value: unknown, maxDepth = 24): void {
  const visit = (v: unknown, depth: number): void => {
    if (depth > maxDepth) throw new Error('Too deeply nested');
    if (v && typeof v === 'object') {
      for (const key of Object.keys(v)) if (UNSAFE_KEYS.has(key)) throw new Error('Unsafe key');
      for (const child of Object.values(v)) visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

/** Parses one text frame into a plain object; throws on bounds or JSON errors. */
export function parseFrame(data: string): Record<string, unknown> {
  if (Buffer.byteLength(data, 'utf8') > MAX_FRAME_BYTES) throw new Error('Frame too large');
  const value: unknown = JSON.parse(data);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Frame must be an object');
  checkShape(value);
  return value as Record<string, unknown>;
}

export type CommandCheck = { ok: true; command: DesktopCommandV2 } | { ok: false; commandId: string; code: string; message: string };
/** Validates an untrusted command. Only contract v2 is accepted over the remote transport. */
export function parseRemoteCommand(value: unknown): CommandCheck {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const commandId = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id.slice(0, 256) : 'invalid';
  if (raw.version !== 2) return { ok: false, commandId, code: 'UNSUPPORTED_VERSION', message: 'Remote transport accepts contract v2 commands only' };
  if (typeof raw.type === 'string' && OWNER_ONLY_COMMANDS.has(raw.type)) return { ok: false, commandId, code: 'FORBIDDEN', message: 'This command is available to the local owner only' };
  const parsed = commandSchema.safeParse(value);
  if (!parsed.success) return { ok: false, commandId, code: 'INVALID_COMMAND', message: 'Command does not match contract v2' };
  return { ok: true, command: parsed.data as unknown as DesktopCommandV2 };
}

/* ------------------------------------------------------------------ redaction */

const blank = (values?: Record<string, string>) => values && Object.fromEntries(Object.keys(values).map(k => [k, '']));
/** Defense in depth: credentials and owner-only data never leave the host, whatever core sends. */
export function redactSnapshot(snapshot: AppSnapshotV2): AppSnapshotV2 {
  return {
    ...snapshot,
    settings: snapshot.settings && { ...snapshot.settings, providers: (snapshot.settings.providers ?? []).map(({ apiKey: _secret, ...provider }) => provider) },
    bots: (snapshot.bots ?? []).map(b => ({ ...b, mcpServers: (b.mcpServers ?? []).map(s => s.transport === 'stdio' ? { ...s, ...(s.env ? { env: blank(s.env) } : {}) } : { ...s, ...(s.headers ? { headers: blank(s.headers) } : {}) }) })),
    devices: [],
  };
}
export function redactResult(result: CommandResultV2): CommandResultV2 {
  if (!result.ok) return { ok: false, commandId: result.commandId, error: { code: String(result.error?.code ?? 'ERROR'), message: String(result.error?.message ?? ''), ...(result.error?.retryable !== undefined ? { retryable: result.error.retryable } : {}) } };
  const { devices: _devices, pairing: _pairing, ...rest } = result;
  if (rest.bot) rest.bot = redactSnapshot({ bots: [rest.bot] } as AppSnapshotV2).bots[0]!;
  return rest.snapshot ? { ...rest, snapshot: redactSnapshot(rest.snapshot) } : rest;
}
/** Returns undefined for events a remote device must not receive (device registry is local-owner only). */
export function redactEvent(event: DesktopEventV2): DesktopEventV2 | undefined {
  if (event.type === 'device.updated') return undefined;
  if (event.type === 'state.snapshot') return { ...event, snapshot: redactSnapshot(event.snapshot) };
  if (event.type === 'bot.updated') return { ...event, bot: redactSnapshot({ bots: [event.bot] } as AppSnapshotV2).bots[0]! };
  return event;
}
