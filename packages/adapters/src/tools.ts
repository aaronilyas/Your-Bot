import type { JsonValue, ToolInvocation } from '@your-bot/contracts';
import { AdapterError, record } from './errors.js';

export const TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'execute_tool',
    description: 'Request a Your Bot tool. The host validates and authorizes every operation. File paths and packages require host approval.',
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['kind', 'input'],
      properties: {
        kind: { type: 'string', enum: ['skill', 'python', 'library.install'] },
        input: { description: 'JSON input to the tool.' },
        skillId: { type: 'string' }, code: { type: 'string' },
        packages: { type: 'array', items: { type: 'string' } },
        paths: { type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['path', 'access'], properties: { path: { type: 'string' }, access: { type: 'string', enum: ['read', 'write', 'delete'] } } } },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 3_600_000 },
      },
    },
  },
} as const;

function invalid(): never { throw new AdapterError('INVALID_TOOL_CALL', 'Provider requested an invalid tool.'); }

/** This validates shape only. Authorization belongs to context.executeTool, never to the adapter. */
export function parseToolInvocation(name: string, args: unknown, id: string): ToolInvocation {
  if (name !== 'execute_tool' || !id || id.length > 256) invalid();
  let value: Record<string, unknown>;
  try { value = record(typeof args === 'string' ? JSON.parse(args) as unknown : args); } catch { invalid(); }
  const allowed = new Set(['kind', 'input', 'skillId', 'code', 'packages', 'paths', 'timeoutMs']);
  if (Object.keys(value).some(key => !allowed.has(key)) || !Object.hasOwn(value, 'input')) invalid();
  if (typeof value.kind !== 'string' || !['skill', 'python', 'library.install'].includes(value.kind)) invalid();
  for (const field of ['skillId', 'code']) if (value[field] !== undefined && typeof value[field] !== 'string') invalid();
  if (value.kind === 'skill' && (typeof value.skillId !== 'string' || !value.skillId)) invalid();
  if (value.kind === 'python' && typeof value.code !== 'string') invalid();
  if (value.packages !== undefined && (!Array.isArray(value.packages) || value.packages.some(p => typeof p !== 'string' || !p))) invalid();
  if (value.kind === 'library.install' && (!Array.isArray(value.packages) || !value.packages.length)) invalid();
  if (value.timeoutMs !== undefined && (!Number.isSafeInteger(value.timeoutMs) || Number(value.timeoutMs) < 1 || Number(value.timeoutMs) > 3_600_000)) invalid();
  if (value.paths !== undefined) {
    if (!Array.isArray(value.paths)) invalid();
    for (const item of value.paths) {
      const path = record(item);
      if (Object.keys(path).some(k => k !== 'path' && k !== 'access') || typeof path.path !== 'string' || !path.path || typeof path.access !== 'string' || !['read', 'write', 'delete'].includes(path.access)) invalid();
    }
  }
  // Reject non-JSON inputs in extension calls too; RPC JSON is already restricted.
  const json = (item: unknown, depth = 0): item is JsonValue => {
    if (depth > 64) return false;
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (Array.isArray(item)) return item.every(v => json(v, depth + 1));
    return typeof item === 'object' && item !== null && Object.getPrototypeOf(item) === Object.prototype && Object.values(item).every(v => json(v, depth + 1));
  };
  if (!json(value.input)) invalid();
  return { ...value, id } as unknown as ToolInvocation;
}
