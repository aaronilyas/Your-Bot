import type { AppSettings, DesktopCommand, FileScope, JsonValue, Principal, ToolInvocation, ToolResult } from '@your-bot/contracts';

export class GatewayError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new GatewayError('INVALID_INPUT', message);
}
export function record(value: unknown, keys: string[], required: string[] = keys): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected an object');
  const object = value as Record<string, unknown>;
  assert(Object.getPrototypeOf(object) === Object.prototype || Object.getPrototypeOf(object) === null, 'Expected a plain object');
  assert(Object.keys(object).every(key => keys.includes(key)) && required.every(key => Object.hasOwn(object, key)), 'Unexpected or missing fields');
  return object;
}
export function string(value: unknown, name: string, max = 4096, empty = false): asserts value is string {
  assert(typeof value === 'string' && value.length <= max && (empty || value.length > 0) && !value.includes('\0'), `Invalid ${name}`);
}
function optionalString(object: Record<string, unknown>, name: string, max = 4096): void {
  if (Object.hasOwn(object, name)) string(object[name], name, max);
}
const capabilities = ['conversation', 'settings', 'tool.execute', 'file.read', 'file.write', 'file.delete', 'library.install', 'network', 'process.spawn'];
export function validatePrincipal(value: unknown): Principal {
  const object = record(value, ['id', 'kind', 'capabilities']);
  string(object.id, 'principal id', 256);
  assert(object.kind === 'local' || object.kind === 'remote', 'Invalid principal kind');
  assert(Array.isArray(object.capabilities) && object.capabilities.every(x => capabilities.includes(x)) && new Set(object.capabilities).size === object.capabilities.length, 'Invalid capabilities');
  return structuredClone(value) as Principal;
}
export function validatePaths(value: unknown): asserts value is FileScope[] {
  assert(Array.isArray(value) && value.length > 0 && value.length <= 128, 'Invalid paths');
  for (const path of value) {
    const object = record(path, ['path', 'access']);
    string(object.path, 'path');
    assert(['read', 'write', 'delete'].includes(object.access as string), 'Invalid file access');
  }
}
export function validatePackages(value: unknown): asserts value is string[] {
  assert(Array.isArray(value) && value.length > 0 && value.length <= 128, 'Invalid packages');
  // Package names and pinned versions only: no flags, URLs, paths or arbitrary pip arguments.
  for (const pkg of value) assert(typeof pkg === 'string' && pkg.length <= 256 && /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\[[a-zA-Z0-9,._-]+\])?(?:==[a-zA-Z0-9][a-zA-Z0-9.*+!_-]*)?$/.test(pkg), 'Only package names or == version pins are supported');
  assert(new Set(value).size === value.length, 'Duplicate packages');
}
function validateJson(value: unknown, depth = 0, seen = new Set<object>()): asserts value is JsonValue {
  assert(depth <= 40, 'JSON nesting too deep');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') { assert(Number.isFinite(value), 'Invalid JSON number'); return; }
  assert(typeof value === 'object' && value !== null && !seen.has(value), 'Invalid JSON value');
  seen.add(value);
  if (Array.isArray(value)) for (const item of value) validateJson(item, depth + 1, seen);
  else {
    assert(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'Invalid JSON object');
    for (const item of Object.values(value)) validateJson(item, depth + 1, seen);
  }
  seen.delete(value);
}
export function validateInvocation(value: unknown): ToolInvocation {
  const object = record(value, ['id', 'kind', 'skillId', 'input', 'code', 'packages', 'paths', 'timeoutMs'], ['id', 'kind', 'input']);
  string(object.id, 'tool id', 256);
  assert(['skill', 'python', 'library.install'].includes(object.kind as string), 'Invalid tool kind');
  optionalString(object, 'skillId', 256);
  optionalString(object, 'code', 1_000_000);
  if (object.kind === 'python') string(object.code, 'python code', 1_000_000);
  if (object.kind === 'skill') string(object.skillId, 'skill id', 256);
  if (Object.hasOwn(object, 'packages')) validatePackages(object.packages);
  if (object.kind === 'library.install') validatePackages(object.packages);
  if (Object.hasOwn(object, 'paths')) validatePaths(object.paths);
  if (Object.hasOwn(object, 'timeoutMs')) assert(Number.isSafeInteger(object.timeoutMs) && (object.timeoutMs as number) > 0 && (object.timeoutMs as number) <= 3_600_000, 'Invalid timeout');
  validateJson(object.input);
  assert(JSON.stringify(object.input).length <= 1_000_000, 'Tool input too large');
  return structuredClone(value) as ToolInvocation;
}
export function validateToolResult(value: unknown): ToolResult {
  const object = record(value, ['ok', 'value', 'error'], ['ok']);
  assert(typeof object.ok === 'boolean', 'Invalid tool result');
  if (Object.hasOwn(object, 'value')) validateJson(object.value);
  if (Object.hasOwn(object, 'error')) {
    const error = record(object.error, ['code', 'message', 'retryable'], ['code', 'message']);
    string(error.code, 'error code', 256); string(error.message, 'error message', 4096);
    if (Object.hasOwn(error, 'retryable')) assert(typeof error.retryable === 'boolean', 'Invalid retryable flag');
  }
  assert(JSON.stringify(value).length <= 1_000_000, 'Tool result too large');
  return structuredClone(value) as ToolResult;
}
export function validateSettings(value: unknown): AppSettings {
  const object = record(value, ['providers']);
  assert(Array.isArray(object.providers) && object.providers.length <= 128, 'Invalid providers');
  const ids = new Set<string>();
  for (const provider of object.providers) {
    const p = record(provider, ['id', 'name', 'kind', 'endpoint', 'modelId', 'apiKey', 'command', 'args', 'enabled'], ['id', 'name', 'kind', 'enabled']);
    string(p.id, 'provider id', 256); string(p.name, 'provider name', 256);
    assert(!ids.has(p.id), 'Duplicate provider id'); ids.add(p.id);
    assert(['lmstudio', 'llamacpp', 'openai-compatible', 'acp'].includes(p.kind as string), 'Invalid provider kind');
    assert(typeof p.enabled === 'boolean', 'Invalid enabled flag');
    for (const key of ['endpoint', 'modelId', 'command']) optionalString(p, key);
    if (Object.hasOwn(p, 'apiKey')) string(p.apiKey, 'apiKey', 4096, true);
    if (Object.hasOwn(p, 'args')) assert(Array.isArray(p.args) && p.args.length <= 128 && p.args.every(x => typeof x === 'string' && x.length <= 4096 && !x.includes('\0')), 'Invalid provider args');
  }
  return structuredClone(value) as AppSettings;
}
export function validatePermissionInput(value: unknown): { capability: Principal['capabilities'][number]; reason: string; paths?: FileScope[]; packages?: string[] } {
  const object = record(value, ['capability', 'reason', 'paths', 'packages'], ['capability', 'reason']);
  assert(capabilities.includes(object.capability as string), 'Invalid capability');
  string(object.reason, 'permission reason', 4096);
  if (Object.hasOwn(object, 'paths')) validatePaths(object.paths);
  if (Object.hasOwn(object, 'packages')) validatePackages(object.packages);
  if ((object.capability as string).startsWith('file.')) {
    validatePaths(object.paths);
    assert(object.paths.every(path => `file.${path.access}` === object.capability), 'Path access must match permission capability');
  } else assert(!Object.hasOwn(object, 'paths'), 'Paths require a file permission');
  if (object.capability === 'library.install') validatePackages(object.packages);
  else assert(!Object.hasOwn(object, 'packages'), 'Packages require an install permission');
  return structuredClone(value) as ReturnType<typeof validatePermissionInput>;
}
export function validateCommand(value: unknown): DesktopCommand {
  const base = record(value, ['version', 'id', 'type', 'afterSequence', 'title', 'agentId', 'modelId', 'sessionId', 'content', 'taskId', 'decision', 'settings', 'invocation'], ['version', 'id', 'type']);
  assert(base.version === 1, 'Unsupported contract version'); string(base.id, 'command id', 256);
  const fields: Record<string, [string[], string[]]> = {
    'state.sync': [['afterSequence'], []], 'session.create': [['title', 'agentId', 'modelId'], ['agentId']],
    'session.open': [['sessionId'], ['sessionId']], 'session.delete': [['sessionId'], ['sessionId']],
    'session.selectAgent': [['sessionId', 'agentId', 'modelId'], ['sessionId', 'agentId']],
    'message.send': [['sessionId', 'content'], ['sessionId', 'content']], 'task.cancel': [['taskId'], ['taskId']],
    'permission.decide': [['decision'], ['decision']], 'settings.update': [['settings'], ['settings']],
    'models.refresh': [['agentId'], []], 'tool.run': [['sessionId', 'invocation'], ['sessionId', 'invocation']]
  };
  string(base.type, 'command type', 64); const schema = Object.hasOwn(fields, base.type) ? fields[base.type] : undefined; assert(schema, 'Unknown command');
  record(value, ['version', 'id', 'type', ...schema[0]], ['version', 'id', 'type', ...schema[1]]);
  for (const key of ['sessionId', 'agentId', 'modelId', 'taskId']) optionalString(base, key, 256);
  if (Object.hasOwn(base, 'title')) string(base.title, 'title', 512, true);
  if (Object.hasOwn(base, 'content')) string(base.content, 'content', 1_000_000);
  if (Object.hasOwn(base, 'afterSequence')) assert(Number.isSafeInteger(base.afterSequence) && (base.afterSequence as number) >= 0, 'Invalid sequence');
  if (base.type === 'settings.update') validateSettings(base.settings);
  if (base.type === 'tool.run') validateInvocation(base.invocation);
  if (base.type === 'permission.decide') {
    const decision = record(base.decision, ['requestId', 'outcome', 'scope']); string(decision.requestId, 'request id', 256);
    assert(decision.outcome === 'allow' || decision.outcome === 'deny', 'Invalid decision outcome');
    assert(decision.scope === 'once' || decision.scope === 'task', 'Invalid decision scope');
  }
  return structuredClone(value) as DesktopCommand;
}
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => `${JSON.stringify(key)}:${stableJson(val)}`).join(',')}}`;
  return JSON.stringify(value);
}
