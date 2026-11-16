import type { BotPatch,
  AppSettingsV2, BotInput, CapabilityV2, CompactionPolicy, DesktopCommandV2, HostFileReadRequest, HostFileWriteRequest,
  HostTerminalCreateRequest, McpServerConfig, PermissionDecisionV2, PermissionInputV2, PrincipalV2, RoutineInput,
  StandingGrantInput, StandingGrantScope,
} from '@your-bot/contracts';
import {
  assert, record, string, validateInvocation, validatePackages, validatePaths, validateSettings,
} from './validation.js';

/** Every v2 capability. */
export const CAPABILITIES_V2: readonly CapabilityV2[] = ['conversation', 'settings', 'tool.execute', 'file.read', 'file.write', 'file.delete', 'library.install', 'network', 'process.spawn', 'mcp.call'];
/** Capabilities that can never be granted standing (custom Python is excluded separately by reason). */
export const NEVER_STANDING: readonly CapabilityV2[] = ['conversation', 'settings', 'library.install', 'network'];
export const STANDING_CAPABILITIES: readonly CapabilityV2[] = ['file.read', 'file.write', 'file.delete', 'process.spawn', 'mcp.call', 'tool.execute'];
export const CUSTOM_PYTHON_PREFIX = 'Execute custom Python sha256:';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SKILL_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** MCP server ids become tool namespaces `<serverId>__<tool>`: no underscores, so the split is unambiguous. */
const MCP_SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const AGENT_TOOL_KIND = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function optional(object: Record<string, unknown>, key: string, check: (value: unknown) => void): void { if (Object.hasOwn(object, key)) check(object[key]); }
function boolean(value: unknown, name: string): asserts value is boolean { assert(typeof value === 'boolean', `Invalid ${name}`); }
function integer(value: unknown, name: string, min: number, max: number): asserts value is number {
  assert(Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max, `Invalid ${name}`);
}
export function id(value: unknown, name: string): asserts value is string { string(value, name, 256); assert(ID.test(value), `Invalid ${name}`); }
export function isoTime(value: unknown, name: string): asserts value is string {
  string(value, name, 64);
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), `Invalid ${name}`);
}
function absolutePath(value: unknown, name: string): asserts value is string {
  string(value, name, 4096);
  assert(value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'), `${name} must be absolute`);
}
function stringArray(value: unknown, name: string, maxItems: number, maxLength = 4096, empty = true): asserts value is string[] {
  assert(Array.isArray(value) && value.length <= maxItems && value.every(item => typeof item === 'string' && item.length <= maxLength && (empty || item.length > 0) && !item.includes('\0')), `Invalid ${name}`);
}
function stringMap(value: unknown, name: string, key: RegExp, maxValue: number): asserts value is Record<string, string> {
  const object = record(value, Object.keys(value as object ?? {}), []);
  const keys = Object.keys(object);
  assert(keys.length <= 64 && keys.every(entry => key.test(entry)), `Invalid ${name} names`);
  for (const entry of keys) string(object[entry], `${name} value`, maxValue, true);
}
function capabilitiesList(value: unknown): asserts value is CapabilityV2[] {
  assert(Array.isArray(value) && value.every(item => CAPABILITIES_V2.includes(item)) && new Set(value).size === value.length, 'Invalid capabilities');
}

export function validatePrincipalV2(value: unknown): PrincipalV2 {
  const object = record(value, ['id', 'kind', 'capabilities', 'ownerId', 'deviceId'], ['id', 'kind', 'capabilities']);
  string(object.id, 'principal id', 256);
  assert(object.kind === 'local' || object.kind === 'remote', 'Invalid principal kind');
  capabilitiesList(object.capabilities);
  optional(object, 'ownerId', v => string(v, 'owner id', 256));
  optional(object, 'deviceId', v => string(v, 'device id', 256));
  return structuredClone(value) as PrincipalV2;
}

export function validateMcpServer(value: unknown): McpServerConfig {
  const base = record(value, ['id', 'name', 'enabled', 'preset', 'transport', 'command', 'args', 'env', 'cwd', 'url', 'headers'], ['id', 'name', 'enabled', 'transport']);
  string(base.id, 'MCP server id', 64); assert(MCP_SERVER_ID.test(base.id), 'Invalid MCP server id');
  string(base.name, 'MCP server name', 256); boolean(base.enabled, 'MCP enabled flag');
  optional(base, 'preset', v => assert(v === 'browser', 'Invalid MCP preset'));
  if (base.transport === 'stdio') {
    record(value, ['id', 'name', 'enabled', 'preset', 'transport', 'command', 'args', 'env', 'cwd'], ['id', 'name', 'enabled', 'transport', 'command']);
    string(base.command, 'MCP command', 4096);
    optional(base, 'args', v => stringArray(v, 'MCP args', 256, 32_768));
    optional(base, 'env', v => stringMap(v, 'MCP env', ENV_NAME, 32_768));
    optional(base, 'cwd', v => absolutePath(v, 'MCP cwd'));
  } else if (base.transport === 'http') {
    record(value, ['id', 'name', 'enabled', 'preset', 'transport', 'url', 'headers'], ['id', 'name', 'enabled', 'transport', 'url']);
    string(base.url, 'MCP url', 4096);
    let url: URL;
    try { url = new URL(base.url); } catch { assert(false, 'Invalid MCP url'); }
    assert(url.protocol === 'https:' || url.protocol === 'http:', 'MCP url must be http(s)');
    assert(!url.username && !url.password, 'MCP url must not embed credentials');
    optional(base, 'headers', v => stringMap(v, 'MCP headers', HEADER_NAME, 32_768));
  } else assert(false, 'Invalid MCP transport');
  return structuredClone(value) as McpServerConfig;
}

function validateCompaction(value: unknown): CompactionPolicy {
  const object = record(value, ['maxMessages', 'keepRecent']);
  integer(object.maxMessages, 'compaction maxMessages', 2, 100_000);
  integer(object.keepRecent, 'compaction keepRecent', 0, 100_000);
  assert(object.keepRecent < object.maxMessages, 'keepRecent must be less than maxMessages');
  return object as unknown as CompactionPolicy;
}

const BOT_KEYS = ['name', 'instructions', 'agentId', 'modelId', 'workspace', 'profile', 'mcpServers', 'skills', 'memoryEnabled', 'compaction'];
function botField(key: string, value: unknown): void {
  switch (key) {
    case 'name': string(value, 'bot name', 256); break;
    case 'instructions': string(value, 'bot instructions', 65_536, true); break;
    case 'agentId': string(value, 'agent id', 256); break;
    // In a patch, "" clears an optional string field (JSON cannot carry undefined).
    case 'modelId': string(value, 'model id', 256, true); break;
    case 'workspace': if (value !== '') absolutePath(value, 'workspace'); break;
    case 'profile': assert(value === 'strict' || value === 'trusted', 'Invalid execution profile'); break;
    case 'mcpServers': {
      assert(Array.isArray(value) && value.length <= 32, 'Invalid MCP servers');
      const ids = value.map(server => validateMcpServer(server).id);
      assert(new Set(ids).size === ids.length, 'Duplicate MCP server id');
      break;
    }
    case 'skills':
      assert(Array.isArray(value) && value.length <= 200 && value.every(item => typeof item === 'string' && SKILL_ID.test(item)) && new Set(value).size === value.length, 'Invalid skills');
      break;
    case 'memoryEnabled': boolean(value, 'memoryEnabled'); break;
    case 'compaction': validateCompaction(value); break;
  }
}
export function validateBotInput(value: unknown): BotInput {
  const object = record(value, BOT_KEYS, ['name', 'instructions', 'agentId', 'profile', 'mcpServers', 'skills', 'memoryEnabled']);
  for (const key of Object.keys(object)) botField(key, object[key]);
  assert(object.modelId !== '' && object.workspace !== '', 'Empty optional fields must be omitted');
  return structuredClone(value) as BotInput;
}
const CLEARABLE = ['modelId', 'workspace', 'compaction'];
export function validateBotPatch(value: unknown): BotPatch {
  const object = record(value, BOT_KEYS, []);
  for (const key of Object.keys(object)) {
    // null clears an optional field; "" remains accepted for modelId/workspace (v2 pre-release form).
    if (object[key] === null) { assert(CLEARABLE.includes(key), `${key} cannot be cleared`); continue; }
    botField(key, object[key]);
  }
  return structuredClone(value) as BotPatch;
}

export function validateStandingScope(value: unknown): StandingGrantScope {
  const object = record(value, ['folder', 'commandPrefix', 'mcp', 'agentToolKind'], []);
  optional(object, 'folder', v => absolutePath(v, 'grant folder'));
  optional(object, 'commandPrefix', v => { stringArray(v, 'command prefix', 64, 4096, false); assert((v as string[]).length > 0, 'Empty command prefix'); });
  optional(object, 'mcp', v => {
    const mcp = record(v, ['serverId', 'tool'], ['serverId']);
    string(mcp.serverId, 'MCP server id', 64); optional(mcp, 'tool', t => string(t, 'MCP tool', 256));
  });
  optional(object, 'agentToolKind', v => { string(v, 'agent tool kind', 64); assert(AGENT_TOOL_KIND.test(v), 'Invalid agent tool kind'); });
  return structuredClone(value) as StandingGrantScope;
}
export function validateGrantInput(value: unknown): StandingGrantInput {
  const object = record(value, ['botId', 'capability', 'scope', 'expiresAt'], ['botId', 'capability', 'scope']);
  id(object.botId, 'bot id');
  assert(CAPABILITIES_V2.includes(object.capability as CapabilityV2), 'Invalid capability');
  validateStandingScope(object.scope);
  optional(object, 'expiresAt', v => isoTime(v, 'expiresAt'));
  return structuredClone(value) as StandingGrantInput;
}

export function validateDecisionV2(value: unknown): PermissionDecisionV2 {
  const object = record(value, ['requestId', 'outcome', 'scope', 'standing', 'standingExpiresAt'], ['requestId', 'outcome', 'scope']);
  string(object.requestId, 'request id', 256);
  assert(object.outcome === 'allow' || object.outcome === 'deny', 'Invalid decision outcome');
  assert(object.scope === 'once' || object.scope === 'task' || object.scope === 'standing', 'Invalid decision scope');
  if (object.scope === 'standing') {
    assert(object.outcome === 'allow', 'Only allow decisions can be standing');
    assert(Object.hasOwn(object, 'standing'), 'Standing decisions require a scope');
    validateStandingScope(object.standing);
    optional(object, 'standingExpiresAt', v => isoTime(v, 'standingExpiresAt'));
  } else assert(!Object.hasOwn(object, 'standing') && !Object.hasOwn(object, 'standingExpiresAt'), 'Standing fields require scope standing');
  return structuredClone(value) as PermissionDecisionV2;
}

export function validateSettingsV2(value: unknown): AppSettingsV2 {
  const object = record(value, ['providers']);
  assert(Array.isArray(object.providers) && object.providers.length <= 128, 'Invalid providers');
  const v1 = { providers: object.providers.map(provider => {
    const p = record(provider, ['id', 'name', 'kind', 'endpoint', 'modelId', 'apiKey', 'command', 'args', 'enabled', 'launch', 'envPassthrough'], ['id', 'name', 'kind', 'enabled']);
    optional(p, 'launch', v => assert(v === 'contained' || v === 'host', 'Invalid provider launch mode'));
    optional(p, 'envPassthrough', v => {
      assert(Array.isArray(v) && v.length <= 64 && v.every(name => typeof name === 'string' && ENV_NAME.test(name)) && new Set(v).size === v.length, 'Invalid envPassthrough');
    });
    const { launch: _launch, envPassthrough: _env, ...rest } = p;
    return rest;
  }) };
  validateSettings(v1);
  return structuredClone(value) as AppSettingsV2;
}

export function validatePermissionInputV2(value: unknown): PermissionInputV2 {
  const object = record(value, ['capability', 'reason', 'paths', 'packages', 'botId', 'command', 'mcp', 'agentTool', 'routineRunId'], ['capability', 'reason']);
  assert(CAPABILITIES_V2.includes(object.capability as CapabilityV2), 'Invalid capability');
  string(object.reason, 'permission reason', 1_001_024);
  if (Object.hasOwn(object, 'paths')) validatePaths(object.paths);
  if (Object.hasOwn(object, 'packages')) validatePackages(object.packages);
  const capability = object.capability as string;
  if (capability.startsWith('file.')) {
    validatePaths(object.paths);
    assert(object.paths.every(path => `file.${path.access}` === capability), 'Path access must match permission capability');
  } else assert(!Object.hasOwn(object, 'paths'), 'Paths require a file permission');
  if (capability === 'library.install') validatePackages(object.packages);
  else assert(!Object.hasOwn(object, 'packages'), 'Packages require an install permission');
  optional(object, 'botId', v => id(v, 'bot id'));
  optional(object, 'routineRunId', v => id(v, 'routine run id'));
  optional(object, 'command', v => {
    assert(capability === 'process.spawn', 'Command detail requires process.spawn');
    const command = record(v, ['command', 'args', 'cwd', 'env'], ['command', 'args', 'cwd']);
    string(command.command, 'command', 4096); stringArray(command.args, 'command args', 256, 32_768); absolutePath(command.cwd, 'command cwd');
    optional(command, 'env', e => {
      assert(Array.isArray(e) && e.length <= 128, 'Invalid command env');
      for (const entry of e) { const item = record(entry, ['name', 'value']); string(item.name, 'env name', 128); assert(ENV_NAME.test(item.name), 'Invalid env name'); string(item.value, 'env value', 32_768, true); }
    });
  });
  optional(object, 'mcp', v => {
    assert(capability === 'mcp.call', 'MCP detail requires mcp.call');
    const mcp = record(v, ['serverId', 'tool']); string(mcp.serverId, 'MCP server id', 256); string(mcp.tool, 'MCP tool', 256);
  });
  optional(object, 'agentTool', v => {
    assert(capability === 'tool.execute', 'Agent tool detail requires tool.execute');
    const tool = record(v, ['toolCallId', 'title', 'kind'], ['toolCallId', 'title']);
    string(tool.toolCallId, 'tool call id', 256); string(tool.title, 'tool title', 4096);
    optional(tool, 'kind', k => { string(k, 'agent tool kind', 64); assert(AGENT_TOOL_KIND.test(k), 'Invalid agent tool kind'); });
  });
  if (capability === 'mcp.call') assert(Object.hasOwn(object, 'mcp'), 'mcp.call requires MCP detail');
  return structuredClone(value) as PermissionInputV2;
}

export function validateHostRead(value: unknown): HostFileReadRequest {
  const object = record(value, ['path', 'line', 'limit'], ['path']);
  string(object.path, 'path', 4096);
  optional(object, 'line', v => integer(v, 'line', 1, Number.MAX_SAFE_INTEGER));
  optional(object, 'limit', v => integer(v, 'limit', 1, Number.MAX_SAFE_INTEGER));
  return structuredClone(value) as HostFileReadRequest;
}
export function validateHostWrite(value: unknown): HostFileWriteRequest {
  const object = record(value, ['path', 'content']);
  string(object.path, 'path', 4096); string(object.content, 'content', 10 * 1024 * 1024, true);
  return structuredClone(value) as HostFileWriteRequest;
}
export function validateTerminalCreate(value: unknown): HostTerminalCreateRequest {
  const object = record(value, ['command', 'args', 'env', 'cwd', 'outputByteLimit'], ['command']);
  string(object.command, 'command', 4096);
  optional(object, 'args', v => stringArray(v, 'args', 256, 32_768));
  optional(object, 'env', v => {
    assert(Array.isArray(v) && v.length <= 128, 'Invalid env');
    for (const entry of v) { const item = record(entry, ['name', 'value']); string(item.name, 'env name', 128); assert(ENV_NAME.test(item.name), 'Invalid env name'); string(item.value, 'env value', 32_768, true); }
  });
  optional(object, 'cwd', v => string(v, 'cwd', 4096));
  optional(object, 'outputByteLimit', v => integer(v, 'outputByteLimit', 1, 16 * 1024 * 1024));
  return structuredClone(value) as HostTerminalCreateRequest;
}
export function validateTerminalId(value: unknown): asserts value is string { string(value, 'terminal id', 256); }

export function validateRoutineInput(value: unknown, partial: boolean): void {
  const keys = ['botId', 'name', 'prompt', 'schedule', 'missedRunPolicy', 'maxCatchUp', 'enabled', 'sessionMode'];
  const object = record(value, keys, partial ? [] : ['botId', 'name', 'prompt', 'schedule', 'missedRunPolicy', 'enabled', 'sessionMode']);
  optional(object, 'botId', v => id(v, 'bot id'));
  optional(object, 'name', v => string(v, 'routine name', 256));
  optional(object, 'prompt', v => string(v, 'routine prompt', 1_000_000));
  optional(object, 'schedule', v => {
    const schedule = record(v, ['kind', 'everyMinutes', 'expression', 'timezone', 'at'], ['kind']);
    if (schedule.kind === 'interval') { record(v, ['kind', 'everyMinutes']); integer(schedule.everyMinutes, 'everyMinutes', 1, 525_600); }
    else if (schedule.kind === 'cron') {
      record(v, ['kind', 'expression', 'timezone'], ['kind', 'expression']);
      string(schedule.expression, 'cron expression', 256); assert(schedule.expression.trim().split(/\s+/).length === 5, 'Cron expression needs 5 fields');
      optional(schedule, 'timezone', t => string(t, 'timezone', 128));
    } else if (schedule.kind === 'once') { record(v, ['kind', 'at']); isoTime(schedule.at, 'at'); }
    else assert(false, 'Invalid schedule kind');
  });
  optional(object, 'missedRunPolicy', v => assert(v === 'skip' || v === 'runOnce' || v === 'runAll', 'Invalid missed run policy'));
  optional(object, 'maxCatchUp', v => integer(v, 'maxCatchUp', 1, 1000));
  optional(object, 'enabled', v => boolean(v, 'enabled'));
  optional(object, 'sessionMode', v => assert(v === 'new' || v === 'reuse', 'Invalid session mode'));
}

type Schema = [allowed: string[], required: string[]];
const V2_FIELDS: Record<string, Schema> = {
  'state.sync': [['afterSequence'], []],
  'bot.create': [['bot'], ['bot']],
  'bot.update': [['botId', 'patch'], ['botId', 'patch']],
  'bot.delete': [['botId'], ['botId']],
  'bot.session.create': [['botId', 'title'], ['botId']],
  'permission.decide': [['decision'], ['decision']],
  'settings.update': [['settings'], ['settings']],
  'grant.create': [['grant'], ['grant']],
  'grant.revoke': [['grantId'], ['grantId']],
  'audit.list': [['botId', 'limit', 'beforeId'], []],
  'memory.list': [['botId'], ['botId']],
  'memory.add': [['botId', 'content'], ['botId', 'content']],
  'memory.delete': [['botId', 'memoryId'], ['botId', 'memoryId']],
  'session.compact': [['sessionId'], ['sessionId']],
  'routine.create': [['routine'], ['routine']],
  'routine.update': [['routineId', 'patch'], ['routineId', 'patch']],
  'routine.delete': [['routineId'], ['routineId']],
  'routine.runNow': [['routineId'], ['routineId']],
  'routine.runs': [['routineId', 'limit'], ['routineId']],
  'notification.ack': [['notificationId'], ['notificationId']],
  'device.pair.start': [['name', 'capabilities'], []],
  'device.list': [[], []],
  'device.revoke': [['deviceId'], ['deviceId']],
  'skills.refresh': [[], []],
  // v1 command types keep their v1 meaning under version 2.
  'session.create': [['title', 'agentId', 'modelId'], ['agentId']],
  'session.open': [['sessionId'], ['sessionId']],
  'session.delete': [['sessionId'], ['sessionId']],
  'session.selectAgent': [['sessionId', 'agentId', 'modelId'], ['sessionId', 'agentId']],
  'message.send': [['sessionId', 'content'], ['sessionId', 'content']],
  'task.cancel': [['taskId'], ['taskId']],
  'models.refresh': [['agentId'], []],
  'tool.run': [['sessionId', 'invocation'], ['sessionId', 'invocation']],
};
export const V2_COMMAND_TYPES = Object.keys(V2_FIELDS);

/** Strict v2 command validation: exact keys per type, bounded strings, nested shapes. */
export function validateCommandV2(value: unknown): DesktopCommandV2 {
  const base = record(value, Object.keys(value as object ?? {}), ['version', 'id', 'type']);
  assert(base.version === 2, 'Unsupported contract version'); string(base.id, 'command id', 256);
  string(base.type, 'command type', 64);
  const schema = Object.hasOwn(V2_FIELDS, base.type) ? V2_FIELDS[base.type] : undefined; assert(schema, 'Unknown command');
  record(value, ['version', 'id', 'type', ...schema[0]], ['version', 'id', 'type', ...schema[1]]);
  for (const key of ['sessionId', 'agentId', 'modelId', 'taskId']) optional(base, key, v => string(v, key, 256));
  for (const key of ['botId', 'grantId', 'beforeId', 'memoryId', 'routineId', 'notificationId', 'deviceId']) optional(base, key, v => id(v, key));
  optional(base, 'title', v => string(v, 'title', 512, true));
  optional(base, 'afterSequence', v => assert(Number.isSafeInteger(v) && (v as number) >= 0, 'Invalid sequence'));
  optional(base, 'limit', v => integer(v, 'limit', 1, 500));
  switch (base.type) {
    case 'message.send': string(base.content, 'content', 1_000_000); break;
    case 'memory.add': string(base.content, 'memory content', 65_536); break;
    case 'tool.run': validateInvocation(base.invocation); break;
    case 'bot.create': validateBotInput(base.bot); break;
    case 'bot.update': validateBotPatch(base.patch); break;
    case 'permission.decide': validateDecisionV2(base.decision); break;
    case 'settings.update': validateSettingsV2(base.settings); break;
    case 'grant.create': validateGrantInput(base.grant); break;
    case 'routine.create': validateRoutineInput(base.routine, false); break;
    case 'routine.update': validateRoutineInput(base.patch, true); break;
    case 'device.pair.start':
      optional(base, 'name', v => string(v, 'device name', 256));
      optional(base, 'capabilities', v => capabilitiesList(v));
      break;
  }
  return structuredClone(value) as DesktopCommandV2;
}
