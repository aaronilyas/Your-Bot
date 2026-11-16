/**
 * Wire contract v2. Strictly additive over v1 (`./index.ts`), which stays valid and unchanged.
 *
 * Versioning rules
 * - A command's `version` selects its schema. v1 commands keep their exact v1 meaning.
 * - Every event carries the version of the contract that defines its type. A subscriber
 *   that did not opt into v2 (`SubscribeOptions.contractVersion !== 2`) receives only v1
 *   event types, with v1-shaped payloads (v2-only fields stripped; permission requests
 *   whose capability is not a v1 capability are withheld, and so are their permission.resolved).
 * - Wire values remain JSON serializable. Interfaces marked "non-wire" are in-process
 *   dependency-injection seams; they never cross a transport.
 *
 * Error codes added by v2 (StructuredError.code): PROFILE_UNSUPPORTED, WORKSPACE_UNAVAILABLE,
 *   INVALID_WORKSPACE, OUTSIDE_WORKSPACE, STANDING_FORBIDDEN, SECRET_CIPHER_REQUIRED,
 *   SECRET_CIPHER_MISMATCH, SECRET_CIPHER_FAILED, NOT_SUPPORTED, LIMIT_EXCEEDED, INVALID_CURSOR,
 *   TERMINAL_NOT_FOUND.
 *
 * Authority rules (normative; the gateway enforces them, transports and adapters cannot)
 * - Core is the only authority. Every file, command, network and MCP action requested by an
 *   agent is authorized by the gateway, then performed by a core-injected host service.
 *   Adapters never receive a WorkspaceHost, McpBroker or ToolExecutor.
 * - `strict` profile is the default and is exactly the v1 containment (fail-closed).
 *   `trusted` is opt-in per bot and may be set only by the local owner principal.
 * - Data ownership: a principal acts on the data of `ownerOf(principal)` = `ownerId ?? id`.
 *   Remote principals are derived server-side by an authenticated transport; they can never
 *   be `kind: 'local'` and never carry the local principal's `id`.
 */
import type {
  AgentAdapter, AgentRunContext, AppSettings, AppSnapshot, Capability, ChatMessage, CommandId,
  CommandPayload, CommandResult, DesktopGateway, EventPayload, FileScope, JsonValue,
  PermissionDecision, PermissionRequest, Principal, ProviderConfig, Session, SessionId,
  StructuredError, TaskId, Unsubscribe,
} from './index.js';

export const CONTRACT_VERSION_2 = 2 as const;
export const SUPPORTED_CONTRACT_VERSIONS = [1, 2] as const;
export type ContractVersion = typeof SUPPORTED_CONTRACT_VERSIONS[number];

/* ------------------------------------------------------------------ identity */

export type CapabilityV2 = Capability | 'mcp.call';
export const V1_CAPABILITIES: readonly Capability[] = ['conversation', 'settings', 'tool.execute', 'file.read', 'file.write', 'file.delete', 'library.install', 'network', 'process.spawn'];

/** Non-wire. Created by an authenticated host only. */
export interface PrincipalV2 extends Omit<Principal, 'capabilities'> {
  capabilities: CapabilityV2[];
  /** Account whose data this principal acts on. Absent means `id`. Paired devices set the local owner's id. */
  ownerId?: string;
  /** Set by the remote host for paired-device principals (`kind: 'remote'`). */
  deviceId?: string;
}

/* ---------------------------------------------------------------------- bots */

export type BotId = string;
export type ExecutionProfile = 'strict' | 'trusted';

interface McpServerBase {
  id: string;
  name: string;
  enabled: boolean;
  /** Known presets are expanded by the host composition. 'browser' = browser automation MCP server. */
  preset?: 'browser';
}
/**
 * `env` and `headers` values are secrets: encrypted at rest, scrubbed from output, and
 * returned in snapshots with every value replaced by "" (keys kept). An update that sends
 * "" for an existing key preserves the stored value.
 */
export type McpServerConfig =
  | (McpServerBase & { transport: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string })
  | (McpServerBase & { transport: 'http'; url: string; headers?: Record<string, string> });

export interface CompactionPolicy {
  /** Compact when a session holds more than this many live messages. */
  maxMessages: number;
  /** Messages kept verbatim after compaction (most recent). Must be < maxMessages. */
  keepRecent: number;
}

export interface Bot {
  id: BotId;
  name: string;
  /** Owner-authored standing instructions, delivered to the agent at session start. */
  instructions: string;
  agentId: string;
  modelId?: string;
  /** Canonical absolute folder on the host. Required when profile is 'trusted'. */
  workspace?: string;
  profile: ExecutionProfile;
  mcpServers: McpServerConfig[];
  /** Enabled skill ids (see SkillInfo). */
  skills: string[];
  memoryEnabled: boolean;
  compaction?: CompactionPolicy;
  createdAt: string;
  updatedAt: string;
}
export type BotInput = Omit<Bot, 'id' | 'createdAt' | 'updatedAt'>;
export type BotPatch = { [K in keyof BotInput]?: undefined extends BotInput[K] ? BotInput[K] | null : BotInput[K] };

/** v1 Session plus bot ownership and compaction state. `messages` holds only live (uncompacted) messages. */
export interface SessionV2 extends Session {
  botId?: BotId;
  /** Summary of compacted earlier messages, if any. */
  summary?: string;
  compactedCount?: number;
}

/** v1 ProviderConfig plus launch mode. 'host' launches an installed agent CLI uncontained and is usable only by trusted bots. */
export interface ProviderConfigV2 extends ProviderConfig {
  launch?: 'contained' | 'host';
  /** Extra environment variable NAMES passed through from the host to a host-launched agent (values never stored). */
  envPassthrough?: string[];
}
export interface AppSettingsV2 extends AppSettings { providers: ProviderConfigV2[]; }

/* --------------------------------------------------------------- permissions */

/** Additional detail a v2 permission request may carry. */
export interface PermissionDetailV2 {
  capability: CapabilityV2;
  botId?: BotId;
  /** process.spawn (ACP terminal/create): exact argv and canonical cwd. */
  /** `env` lists variables the command sets; a request with env never matches a standing grant. */
  command?: { command: string; args: string[]; cwd: string; env?: { name: string; value: string }[] };
  /** mcp.call */
  mcp?: { serverId: string; tool: string };
  /** tool.execute requested by a trusted agent for one of its own built-in tools (ACP session/request_permission). */
  agentTool?: { toolCallId: string; title: string; kind?: string };
  routineRunId?: string;
}
export interface PermissionRequestV2 extends Omit<PermissionRequest, 'capability'>, PermissionDetailV2 {}
export type PermissionInputV2 = Omit<PermissionRequestV2, 'id' | 'principalId' | 'sessionId' | 'taskId'>;

/**
 * Standing grant scope. All present fields must match; a request matches a grant only if
 * bot, capability and scope all match and the grant is neither revoked nor expired.
 * - file.read/file.write/file.delete: `folder` required; every request path must be the folder
 *   itself or canonically beneath it. Folder must lie inside the bot workspace.
 * - process.spawn: `commandPrefix` required (exact argv tokens; argv[0] compared after the host
 *   resolves nothing — literal match); cwd must lie inside `folder` (default: bot workspace).
 * - mcp.call: `mcp.serverId` required; `mcp.tool` absent means every tool of that server.
 * - tool.execute (agent built-in tools): `agentToolKind` required (ACP tool kind, e.g. 'edit').
 * Custom Python (`Execute custom Python sha256:`), library.install, network and settings can
 * never be granted standing.
 */
export interface StandingGrantScope {
  folder?: string;
  commandPrefix?: string[];
  mcp?: { serverId: string; tool?: string };
  agentToolKind?: string;
}
export interface StandingGrant {
  id: string;
  botId: BotId;
  capability: CapabilityV2;
  scope: StandingGrantScope;
  createdAt: string;
  createdBy: string;
  expiresAt?: string;
  revokedAt?: string;
  revokedBy?: string;
}
export interface StandingGrantInput { botId: BotId; capability: CapabilityV2; scope: StandingGrantScope; expiresAt?: string; }

/** Every authorization decision for a bot's task is audited, interactive or standing. */
export interface GrantAuditEntry {
  id: string;
  at: string;
  botId: BotId;
  taskId: TaskId;
  sessionId: SessionId;
  requestId: string;
  capability: CapabilityV2;
  /** Human-readable subject: canonical path(s), argv, or server/tool. */
  subject: string;
  outcome: 'allow' | 'deny';
  via: 'standing' | 'interactive' | 'policy';
  grantId?: string;
  /** Principal that decided (interactive) or that created the grant (standing). */
  decidedBy?: string;
  routineRunId?: string;
}

/**
 * v2 decision. `scope: 'standing'` allows this request AND creates a standing grant with
 * `standing` as its scope; the gateway rejects it unless the scope covers the request and the
 * decider may create grants (see grant.create).
 */
export interface PermissionDecisionV2 extends Omit<PermissionDecision, 'scope'> {
  scope: PermissionDecision['scope'] | 'standing';
  standing?: StandingGrantScope;
  standingExpiresAt?: string;
}

/* ---------------------------------------------------------------- continuity */

export interface MemoryEntry { id: string; botId: BotId; content: string; source: 'owner' | 'agent'; createdAt: string; }

/* ------------------------------------------------------------------ routines */

export type RoutineSchedule =
  | { kind: 'interval'; everyMinutes: number }
  /** 5-field cron (minute hour day-of-month month day-of-week) in `timezone` (IANA, default host local). */
  | { kind: 'cron'; expression: string; timezone?: string }
  | { kind: 'once'; at: string };
/** skip: drop missed occurrences. runOnce: one catch-up run. runAll: one run per missed occurrence, at most `maxCatchUp`. */
export type MissedRunPolicy = 'skip' | 'runOnce' | 'runAll';
export interface Routine {
  id: string;
  botId: BotId;
  name: string;
  prompt: string;
  schedule: RoutineSchedule;
  missedRunPolicy: MissedRunPolicy;
  maxCatchUp?: number;
  enabled: boolean;
  /** 'new' starts a session per run; 'reuse' continues `sessionId` (created on first run). */
  sessionMode: 'new' | 'reuse';
  sessionId?: SessionId;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
}
export type RoutineInput = Omit<Routine, 'id' | 'sessionId' | 'lastRunAt' | 'nextRunAt' | 'createdAt' | 'updatedAt'>;
export type RoutineRunStatus = 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled' | 'skipped' | 'interrupted';
export interface RoutineRun {
  id: string;
  routineId: string;
  botId: BotId;
  trigger: 'schedule' | 'catchup' | 'manual';
  scheduledFor: string;
  status: RoutineRunStatus;
  sessionId?: SessionId;
  taskId?: TaskId;
  /** Pending permission request ids while status is 'blocked'. */
  blockedOn?: string[];
  startedAt?: string;
  finishedAt?: string;
  error?: StructuredError;
}

/* ------------------------------------------------------------- notifications */

export interface OwnerNotification {
  id: string;
  kind: 'approval.required' | 'routine.failed' | 'routine.interrupted' | 'routine.skipped' | 'device.paired';
  title: string;
  body: string;
  botId?: BotId;
  routineRunId?: string;
  requestId?: string;
  createdAt: string;
  acknowledgedAt?: string;
}

/* ------------------------------------------------------------------- devices */

export interface DeviceInfo {
  id: string;
  name: string;
  capabilities: CapabilityV2[];
  pairedAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}
/** Returned once to the local owner. `code` is a single-use secret; it encodes host address and certificate fingerprint. */
export interface PairingOffer { code: string; expiresAt: string; hostFingerprint: string; urls: string[]; }

/* -------------------------------------------------------------------- skills */

export interface SkillInfo {
  /** Stable id: folder name, unique per source. */
  id: string;
  name: string;
  description: string;
  source: 'global' | 'workspace';
  /** Canonical folder containing SKILL.md. */
  folder: string;
  /** Present when the folder exists but failed validation; such a skill cannot be enabled. */
  error?: string;
}

/* ------------------------------------------------------------------ snapshot */

export interface AppSnapshotV2 extends Omit<AppSnapshot, 'sessions' | 'settings' | 'pendingPermissions'> {
  sessions: SessionV2[];
  settings: AppSettingsV2;
  pendingPermissions: PermissionRequestV2[];
  bots: Bot[];
  /** Active (unrevoked, unexpired) grants. */
  grants: StandingGrant[];
  routines: Routine[];
  /** Unfinished and recent runs (bounded). */
  routineRuns: RoutineRun[];
  notifications: OwnerNotification[];
  skills: SkillInfo[];
  /** Local owner only; empty for remote principals. */
  devices: DeviceInfo[];
  /** Identifies the host for multi-host clients. */
  host: { id: string; name: string };
}

/* ------------------------------------------------------------------ commands */

export type CommandPayloadV2 =
  /** An afterSequence beyond the latest event fails with error code INVALID_CURSOR. */
  | { type: 'state.sync'; afterSequence?: number }
  | { type: 'bot.create'; bot: BotInput }
  /** `null` clears an optional field (modelId, workspace, compaction). */
  | { type: 'bot.update'; botId: BotId; patch: BotPatch }
  | { type: 'bot.delete'; botId: BotId }
  | { type: 'bot.session.create'; botId: BotId; title?: string }
  | { type: 'permission.decide'; decision: PermissionDecisionV2 }
  | { type: 'settings.update'; settings: AppSettingsV2 }
  | { type: 'grant.create'; grant: StandingGrantInput }
  | { type: 'grant.revoke'; grantId: string }
  | { type: 'audit.list'; botId?: BotId; limit?: number; beforeId?: string }
  | { type: 'memory.list'; botId: BotId }
  | { type: 'memory.add'; botId: BotId; content: string }
  | { type: 'memory.delete'; botId: BotId; memoryId: string }
  | { type: 'session.compact'; sessionId: SessionId }
  | { type: 'routine.create'; routine: RoutineInput }
  | { type: 'routine.update'; routineId: string; patch: Partial<RoutineInput> }
  | { type: 'routine.delete'; routineId: string }
  | { type: 'routine.runNow'; routineId: string }
  | { type: 'routine.runs'; routineId: string; limit?: number }
  | { type: 'notification.ack'; notificationId: string }
  | { type: 'device.pair.start'; name?: string; capabilities?: CapabilityV2[] }
  | { type: 'device.list' }
  | { type: 'device.revoke'; deviceId: string }
  | { type: 'skills.refresh' }
  /** Every v1 command type is also valid with version 2 and keeps its v1 meaning. */
  | Exclude<CommandPayload, { type: 'state.sync' | 'permission.decide' | 'settings.update' }>;
export type DesktopCommandV2 = CommandPayloadV2 & { version: 2; id: CommandId };
export type AnyDesktopCommand = import('./index.js').DesktopCommand | DesktopCommandV2;

export type CommandResultV2 =
  | {
      ok: true; commandId: CommandId; sessionId?: SessionId; taskId?: TaskId;
      snapshot?: AppSnapshotV2; session?: SessionV2; bot?: Bot; grant?: StandingGrant;
      audit?: GrantAuditEntry[]; memory?: MemoryEntry[]; routine?: Routine; runs?: RoutineRun[];
      pairing?: PairingOffer; devices?: DeviceInfo[]; skills?: SkillInfo[];
    }
  | { ok: false; commandId: CommandId; error: StructuredError };
export type AnyCommandResult = CommandResult | CommandResultV2;

/* -------------------------------------------------------------------- events */

export type EventPayloadV2Only =
  | { type: 'bot.updated'; bot: Bot }
  | { type: 'bot.deleted'; botId: BotId }
  | { type: 'grant.updated'; grant: StandingGrant }
  | { type: 'grant.audited'; entry: GrantAuditEntry }
  | { type: 'memory.updated'; botId: BotId; memory: MemoryEntry[] }
  | { type: 'routine.updated'; routine: Routine }
  | { type: 'routine.deleted'; routineId: string }
  | { type: 'routine.run'; run: RoutineRun }
  | { type: 'notification'; notification: OwnerNotification }
  | { type: 'device.updated'; device: DeviceInfo }
  | { type: 'skills.updated'; skills: SkillInfo[] }
  /** v2 subscribers receive v2-shaped snapshots / sessions / requests under these v1 type names. */
  | { type: 'state.snapshot'; snapshot: AppSnapshotV2 }
  | { type: 'session.updated'; session: SessionV2 }
  | { type: 'permission.requested'; request: PermissionRequestV2 };
export type EventPayloadV2 = EventPayloadV2Only | Exclude<EventPayload, { type: 'state.snapshot' | 'session.updated' | 'permission.requested' }>;
export type DesktopEventV2 = EventPayloadV2 & { version: ContractVersion; sequence: number; timestamp: string; principalId: string };

export interface SubscribeOptions { contractVersion?: ContractVersion; }

/** Non-wire. A v2 gateway is also a valid v1 DesktopGateway. */
export interface DesktopGatewayV2 extends Omit<DesktopGateway, 'dispatch' | 'subscribe' | 'cancelTask'> {
  dispatch(command: AnyDesktopCommand, principal: Principal | PrincipalV2): Promise<AnyCommandResult>;
  subscribe(listener: (event: DesktopEventV2) => void, principal: Principal | PrincipalV2, options?: SubscribeOptions): Unsubscribe;
  cancelTask(taskId: TaskId, principal: Principal | PrincipalV2): Promise<void>;
}

/** Client-side transport for v2 commands/events (remote clients, v2 desktop renderer). */
export interface BackendTransportV2 {
  dispatch(command: DesktopCommandV2): Promise<CommandResultV2>;
  subscribe(listener: (event: DesktopEventV2) => void): Unsubscribe;
  close?(): Promise<void>;
}

/* ------------------------------------------------- adapter-facing (non-wire) */

export interface HostFileReadRequest { path: string; line?: number; limit?: number; }
export interface HostFileWriteRequest { path: string; content: string; }
/**
 * When `args` is absent/empty and `command` contains whitespace or shell syntax, `command` is a
 * shell command line run by the platform shell (`/bin/sh -c`; `cmd.exe /d /s /c` on Windows). Such a
 * line matches a standing `commandPrefix` grant only if it contains no shell syntax at all.
 */
export interface HostTerminalCreateRequest {
  command: string; args?: string[]; env?: { name: string; value: string }[]; cwd?: string; outputByteLimit?: number;
}
export interface TerminalExitStatus { exitCode: number | null; signal: string | null; }
export interface TerminalOutput { output: string; truncated: boolean; exitStatus?: TerminalExitStatus; }

/**
 * Core-implemented and core-authorized channel for ACP fs/terminal requests. Present on the run
 * context only for trusted bots. Paths are host paths; relative paths resolve against the
 * workspace. Every call is authorized (standing grant or live approval) before it is performed.
 * Failures reject with an Error carrying a `code` (StructuredError.code), e.g. PERMISSION_DENIED,
 * OUTSIDE_WORKSPACE, NOT_FOUND, TERMINAL_NOT_FOUND, LIMIT_EXCEEDED.
 */
export interface WorkspaceHostChannel {
  readTextFile(request: HostFileReadRequest): Promise<{ content: string }>;
  writeTextFile(request: HostFileWriteRequest): Promise<void>;
  createTerminal(request: HostTerminalCreateRequest): Promise<{ terminalId: string }>;
  terminalOutput(terminalId: string): Promise<TerminalOutput>;
  waitForTerminalExit(terminalId: string): Promise<TerminalExitStatus>;
  killTerminal(terminalId: string): Promise<void>;
  releaseTerminal(terminalId: string): Promise<void>;
}

/** Authenticated loopback MCP endpoint (streamable HTTP) owned by core for one task. */
export interface McpProxyEndpoint { name: string; url: string; headers: { name: string; value: string }[]; }

/** Opaque per (adapter, session) state, persisted by core. Values must be JSON and ≤ 64 KiB serialized. */
export interface AdapterStateStore {
  get(): Promise<JsonValue | undefined>;
  set(value: JsonValue): Promise<void>;
  clear(): Promise<void>;
}

export interface AgentRunContextV2 extends Omit<AgentRunContext, 'session' | 'requestPermission' | 'principal'> {
  session: SessionV2;
  principal: PrincipalV2;
  profile: ExecutionProfile;
  bot?: Bot;
  /** Canonical absolute workspace; present only for trusted bots. Agent cwd. */
  workspace?: string;
  /** Composed by core: bot instructions, memory and enabled skills. Adapters deliver it to the agent. */
  instructions?: string;
  /** Present only for trusted bots. */
  host?: WorkspaceHostChannel;
  /** Present when the bot has enabled MCP servers (or core built-ins) and the agent can reach loopback HTTP. */
  mcp?: McpProxyEndpoint;
  state: AdapterStateStore;
  requestPermission(request: PermissionInputV2): Promise<PermissionDecision>;
  /** Adapters must exclude time spent awaiting approvals from their run timeouts. */
}

/** Optional v2 adapter surface. Core feature-detects these members. */
export interface AgentAdapterV2 extends Omit<AgentAdapter, 'run'> {
  run(context: AgentRunContext | AgentRunContextV2): Promise<void>;
  /** Profiles this adapter can serve. Absent means ['strict']. */
  readonly profiles?: readonly ExecutionProfile[];
  /** Summarize messages for compaction. Absent: core uses its deterministic fallback. */
  summarize?(input: { previousSummary?: string; messages: ChatMessage[]; signal: AbortSignal }): Promise<string>;
}

/* --------------------------------------------- core-injected (non-wire) deps */

/**
 * Performs workspace operations AFTER core authorization. Implementations must confine every
 * operation to `root` (canonical), re-check confinement at the moment of use (symlink races),
 * spawn without a shell, bound output, and kill whole process trees on kill/release/task end.
 */
export interface WorkspaceHost {
  /** Canonical absolute path for `path` (relative to root). Rejects OUTSIDE_WORKSPACE. Target need not exist; its parent must. */
  resolve(root: string, path: string): Promise<string>;
  readTextFile(root: string, canonicalPath: string, options: { line?: number; limit?: number; signal: AbortSignal }): Promise<string>;
  writeTextFile(root: string, canonicalPath: string, content: string, options: { signal: AbortSignal }): Promise<void>;
  createTerminal(root: string, request: HostTerminalCreateRequest & { cwd: string }, options: { taskId: TaskId; signal: AbortSignal }): Promise<string>;
  terminalOutput(terminalId: string): Promise<TerminalOutput>;
  waitForTerminalExit(terminalId: string, signal: AbortSignal): Promise<TerminalExitStatus>;
  killTerminal(terminalId: string): Promise<void>;
  releaseTerminal(terminalId: string): Promise<void>;
  /** Kill and release every terminal of a task. */
  releaseTask(taskId: TaskId): Promise<void>;
  close(): Promise<void>;
}

export interface McpToolInfo { serverId: string; name: string; description?: string; inputSchema?: JsonValue; }
export interface McpCall { serverId: string; tool: string; arguments: JsonValue; }
/** A core-provided tool served through the same proxy (e.g. bot memory). */
export interface McpBuiltinTool { name: string; description: string; inputSchema: JsonValue; handle(args: JsonValue, signal: AbortSignal): Promise<JsonValue>; }
export interface McpProxySession {
  endpoint: McpProxyEndpoint;
  tools(): Promise<McpToolInfo[]>;
  close(): Promise<void>;
}
/**
 * Starts the bot's MCP servers and an authenticated loopback proxy for one task. The proxy MUST
 * reject requests without the session's bearer token, MUST call `authorize` for every tools/call
 * before forwarding, and MUST NOT listen on non-loopback interfaces.
 */
export interface McpBroker {
  open(input: {
    taskId: TaskId; botId: BotId; servers: McpServerConfig[]; builtins: McpBuiltinTool[];
    authorize(call: McpCall, signal: AbortSignal): Promise<boolean>; signal: AbortSignal;
  }): Promise<McpProxySession>;
  close(): Promise<void>;
}

/** Remote-host-owned device registry; core routes device.* commands (local owner only) to it. */
export interface DeviceManager {
  startPairing(input: { name?: string; capabilities?: CapabilityV2[] }): Promise<PairingOffer>;
  list(): Promise<DeviceInfo[]>;
  revoke(deviceId: string): Promise<void>;
}

/** Encrypts secrets (API keys, MCP env/headers) at rest. Ciphertext is an opaque string. */
export interface SecretCipher {
  readonly id: string;
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

export interface SkillCatalog {
  /** `workspaces` are canonical bot workspaces whose `.your-bot/skills` folders are scanned. */
  list(workspaces: string[]): Promise<SkillInfo[]>;
  /** Full SKILL.md body (frontmatter removed), bounded. */
  read(skill: SkillInfo): Promise<string>;
}

export interface Notifier { notify(notification: OwnerNotification): void; }

/* ------------------------------------------------- shared policy helpers */

/**
 * Environment entries agents set for presentation only (colour, progress, CI mode, terminal size,
 * agent session id). They cannot change which program runs or what it loads, so they do not stop a
 * standing grant from matching. Anything else (PATH, LD_*, NODE_OPTIONS, *_OPTS, ...) does — except
 * the two exact console-style values Grok Build sets for Gradle and Maven.
 */
const INERT_ENV_NAMES = new Set(['TERM', 'COLORTERM', 'FORCE_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE', 'NO_COLOR', 'CI', 'COLUMNS', 'LINES',
  'PIP_PROGRESS_BAR', 'NPM_CONFIG_PROGRESS', 'CARGO_TERM_COLOR', 'CARGO_TERM_PROGRESS_WHEN', 'CARGO_TERM_PROGRESS_WIDTH', 'GROK_SESSION_ID']);
const INERT_ENV_VALUES: Record<string, string> = { GRADLE_OPTS: '-Dorg.gradle.console=rich', MAVEN_OPTS: '-Dstyle.color=always' };
export function inertEnvironment(entry: { name: string; value: string }): boolean {
  if (/[\0\n\r]/.test(entry.value)) return false;
  return INERT_ENV_NAMES.has(entry.name) || INERT_ENV_VALUES[entry.name] === entry.value;
}

/** File scope helper re-export for package convenience. */
export type { FileScope };
