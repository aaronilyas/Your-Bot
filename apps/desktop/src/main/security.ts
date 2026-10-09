import { z } from 'zod';
import type { CommandResult, DesktopCommand, DesktopEvent, AppSnapshot, Principal } from '@your-bot/contracts';
const id = z.string().min(1).max(256);
const short = z.string().max(2048);
const fileScope = z.strictObject({ path: z.string().min(1).max(8192), access: z.enum(['read', 'write', 'delete']) });
const provider = z.strictObject({
  id, name: short, kind: z.enum(['lmstudio', 'llamacpp', 'openai-compatible', 'acp']),
  endpoint: short.optional(), modelId: id.optional(), apiKey: z.string().max(8192).optional(),
  command: short.optional(), args: z.array(short).max(128).optional(), enabled: z.boolean(),
});
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
  z.strictObject({ ...base, type: z.literal('tool.run'), sessionId: id, invocation: z.strictObject({ id, kind: z.enum(['skill', 'python', 'library.install']), skillId: id.optional(), input: z.json(), code: z.string().max(262144).optional(), packages: z.array(short).max(256).optional(), paths: z.array(fileScope).max(256).optional(), timeoutMs: z.number().int().positive().max(3600000).optional() }) }),
]);
export function parseCommand(value: unknown): DesktopCommand {
  // Bound both bytes and depth before recursive schema validation.
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
  return commandSchema.parse(value) as DesktopCommand;
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
export function redactSnapshot(snapshot: AppSnapshot): AppSnapshot {
  return { ...snapshot, settings: { providers: snapshot.settings.providers.map(({ apiKey: _secret, ...config }) => config) } };
}
export function redactResult(result: CommandResult): CommandResult {
  return result.ok && result.snapshot ? { ...result, snapshot: redactSnapshot(result.snapshot) } : result;
}
export function rendererEvent(event: DesktopEvent, principal: Principal): DesktopEvent | undefined {
  if (event.principalId !== principal.id) return undefined;
  return event.type === 'state.snapshot' ? { ...event, snapshot: redactSnapshot(event.snapshot) } : event;
}
