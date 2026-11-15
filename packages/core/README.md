# Core integration

`@your-bot/core` implements the frozen v1 `DesktopGateway` and the additive v2
`DesktopGatewayV2` (bots, execution profiles, standing grants, audit, host
channel, MCP, devices), without Electron, HTTP listeners, provider code, or
sandbox implementation. It uses the built-in `node:sqlite` API and requires
Node 22.13+ (or an Electron main runtime providing that API).

Public exports:

- `createGateway(options): Promise<DesktopGateway>` — v1 factory. Accepts only
  `version: 1` commands and v1 subscriptions (unchanged contract), while using
  the same storage, ownership, bot and authorization model internally.
- `createGatewayV2(options): Promise<DesktopGatewayV2>` — accepts `version: 1 | 2`
  commands and `subscribe(listener, principal, { contractVersion: 2 })`.
- `GatewayOptions`, `AnyAgentAdapter`, and helpers `ownerOf(principal)`,
  `publicBot(bot)` (MCP secret values blanked) and `isWithin(folder, path, platform?)`
  (the canonical segment-based containment used for grants).

The v2 sections are at the end of this document; everything before them
describes behaviour shared by both factories.

## Host wiring

Build contracts before core. Construct one gateway in the authenticated host:

```ts
import { createGateway } from '@your-bot/core';
import type { AppSettings, BackendTransport, Principal } from '@your-bot/contracts';

const principal: Principal = {
  id: 'desktop-owner', kind: 'local',
  capabilities: ['conversation', 'settings', 'tool.execute', 'file.read',
    'file.write', 'file.delete', 'library.install', 'network', 'process.spawn'],
};
const gateway = await createGateway({
  databasePath: '/absolute/private-app-data/gateway.sqlite',
  localPrincipalId: principal.id,
  adapters, // AgentAdapter[] supplied by @your-bot/adapters
  executor, // ToolExecutor supplied by @your-bot/executor
  onSettingsChanged: async (settings: AppSettings, { signal }) => {
    // Host-owned factory: receives API keys; never send these settings to IPC.
    // Build adapters atomically. Observe signal during discovery/initialization.
    return buildAdapters(settings, signal);
  },
  cleanupTimeoutMs: 1000,
});

// Main/preload must validate the IPC sender, then bind the identity itself.
// Renderer receives commands/events only; never accept a Principal from it.
const transport: BackendTransport = {
  dispatch: command => gateway.dispatch(command, principal),
  subscribe: listener => gateway.subscribe(listener, principal),
};
// Await gateway.close() at application shutdown. Subscribe before initial sync.
```

`onSettingsChanged` is optional for fixed adapters. It is called once on startup
with the stored settings (initially `{ providers: [] }`), and on every successful
settings update. Returning an array, including an empty one, replaces adapters;
returning `undefined` preserves them. Removed adapter instances are closed. A
rejected callback leaves persisted settings unchanged; the callback must handle
rollback of its own external side effects. Settings updates require all tasks
to be idle. An omitted `apiKey` preserves the existing key for that provider ID;
an empty string explicitly clears it. Removing the provider removes its active
configuration. Retired credentials remain in a private redaction registry so
old events cannot expose them during replay.

Only the configured `localPrincipalId` may have `kind: 'local'`; remote identities
cannot reuse it. The DB permanently binds that local identity, and binds each
remote identity to its principal kind. Capabilities come from the authenticated
host on every dispatch. Ownership (`ownerOf(principal) = ownerId ?? id`, see
"Ownership" below) is enforced independently on session/task operations, event
delivery, replay and permission decisions; command deduplication is per
principal id. Provider settings are readable/updatable only by the local owner
with the settings capability. Remote snapshots receive empty provider settings.

## Tasks and permissions

`message.send` and `tool.run` return accepted `taskId`/`sessionId` values. Observe
`task.started`, deltas/status/tool output, and exactly one terminal task event.
One active task is permitted per session. Successful tool results are persisted
as `role: 'tool'` messages whose JSON content is `{ toolCallId, result }`; adapters
also receive the `ToolResult` directly from `executeTool`. Successful assistant
responses are persisted on completion. A cancelled/failed assistant response
is not committed as a complete message; its already emitted deltas remain in
event history.

Both `AgentRunContext.executeTool` and `{type: 'tool'}` updates enter the same
serialized execution queue. No principal capability silently authorizes a tool
action. Before execution, core requests `tool.execute`, each required file
access, and a separate package-install approval. Missing principal capabilities
fail before generating these requests. Additional adapter/executor requests
return through the same gateway, and cannot request settings or conversation
permissions.

Display `permission.requested`, then dispatch exactly:

```ts
{
  version: 1, id: crypto.randomUUID(), type: 'permission.decide',
  decision: { requestId, outcome: 'allow', scope: 'once' }
}
```

The decision supplies no editable task, principal, paths, or packages. Extra
fields are rejected. Only the owning identity can decide a live request. IDs are
gateway-generated, single-resolution, and invalid after task termination.
Grants copy the original request and are appended only after an authorized
allow. `once` grants are consumed by one invocation attempt, including a denied
attempt; `task` grants cover only the same capability and exact approved paths /
package strings within that task. Other paths/packages generate new approvals.
Tool execution is serialized so concurrent calls cannot reuse a once grant.
Generic `tool.execute` grants have capability-level granularity within the task.
Custom Python requests additionally bind the complete code and SHA-256 in the
request reason; different code requires a different approval. File and package
grants remain exact. Files are requested individually, and each writable mount
requires a separate read grant, including for a new write target.

While an executor awaits its `context.requestPermission`, an authorized grant
is appended to that same `context.authorization.grants` array. A denial adds
nothing. Executors must check the outcome and validate the principal, task,
capability, and scopes; approval never means a sandbox may expose other files,
network, processes, or arbitrary package arguments. An executor is a trusted
injected component, and core cannot contain a malicious executor by itself.

The full `gateway.requestPermission(request)` contract method only awaits an
unchanged, registered live request. Context callbacks issue requests. Direct
external construction, identity/task mutation, and ID spoofing are rejected.

File scopes require absolute paths to individual regular files. Existing links
resolve to their canonical target; new write targets resolve through their
nearest existing ancestor. Directory grants, dangling links, and DB files /
sidecars / DB hard-link aliases are refused. Targets are rechecked after
approval, and a changed canonical target fails closed. The executor must also
protect against filesystem changes between this check and use (for example
with secure descriptor/bind setup); core does not hold files open or provide
the sandbox boundary. Packages support names, extras, and optional `==` pins;
flags, URLs, paths, shell fragments, and arbitrary pip arguments are rejected.

Cancellation immediately aborts the task signal, denies unresolved requests,
revokes grants, emits `task.cancelled`, and calls adapter/executor cancellation.
Late updates/results are suppressed. Close also aborts provider discovery /
reload waits, settles tasks, closes dependencies and SQLite, and removes
listeners. Cleanup callbacks are awaited up to `cleanupTimeoutMs`; injected
components must honor cancellation because JS cannot forcibly stop a callback.

## Persistence, sync, and security

Use a **dedicated** app-data directory: core changes the DB parent directory to
0700 and the DB file to 0600, checks current-user ownership, and refuses linked,
nonregular, or hard-linked DB files. SQLite uses full synchronous commits,
delete journaling and `secure_delete`; credentials remain local in this DB. These
filesystem modes are a POSIX guarantee. A Windows host must provide equivalent
private ACLs. Credentials are encrypted at rest only when a `secretCipher` is
injected (see "Secrets at rest"). Core has no authenticated transport or OS
sandbox.

Every newly emitted event has a durable globally increasing sequence, owner ID,
and ISO timestamp. Other owners produce sequence gaps. `state.sync` returns and
emits an authoritative owner snapshot. With `afterSequence`, it first redelivers
that owner's persisted events after the cursor, preserving their original
sequences, then emits a fresh snapshot. Replay intentionally includes historical
task/permission/snapshot events: finish by replacing UI state from the new
snapshot and deduplicate events by sequence. Never treat a historical permission
event as proof that its request is still live. A cursor ahead of this owner's
latest sequence is rejected. Subscribe before syncing.

Command IDs are deduplicated durably per identity. Retrying a valid command with
the same ID/content returns its original result and emits no new events.
Reusing an ID with changed content returns `COMMAND_CONFLICT`. Use a fresh ID
for a new sync. A receipt is persisted before side effects; a crash during the
command returns `INTERRUPTED` on retry, rather than replaying its effects. Sync
and inspect state before issuing a replacement command. Task rows still active
on restart become cancelled; grants and pending approvals are never restored.
Sessions/messages, settings, accepted command results, and events survive restart.

Snapshots, event payloads, tool results and command results omit `apiKey` fields;
known API-key strings are redacted from free text, including keys split across
text or tool-output chunks. Streaming may hold back a possible key prefix until
the next chunk and conservatively redact an incomplete prefix at completion.
Protocol identifiers are retained for routing. This is credential scrubbing,
not a general arbitrary-secret or covert-channel filter. The provider reload
callback is the sole public route to actual stored credentials.

Event, command and audit history currently have no retention/compaction policy.
Core does not negotiate sandbox capabilities or verify an ACP launch containment
implementation: adapters/executor must enforce the architecture security rules.

## Contract v2

### Versioning

A command's `version` selects its schema; every v2 command shape is validated
strictly (exact keys, bounded strings, nested bot/MCP/grant/decision/routine
shapes). v1 command types keep their v1 meaning under version 2. v1 commands get
v1-shaped results (`session` without `botId`, v1 snapshot); v2 commands get v2
shapes. Events are stored v2-shaped and converted per subscriber: a v1
subscriber receives only v1 event types, with v2-only fields stripped; permission
requests (and their resolutions) whose capability is not a v1 capability
(`mcp.call`) are withheld. Every event carries the version of the contract that
defines its type (`bot.updated`, `grant.audited`, … are version 2). Snapshot and
replay events are delivered only to the principal that synced.

### Ownership

`ownerOf(p) = p.ownerId ?? p.id` keys all data and event routing. A local
principal must be exactly `localPrincipalId` with no `ownerId`/`deviceId`. A
remote principal can never use the local id, and its `ownerId`, if present, must
equal the local id. Such a paired device acts on the local owner's sessions,
bots, tasks, events and audit, can answer the owner's approvals (it still needs
the request's capability) and cancel the owner's tasks. It can never perform
local-owner-only actions, whatever capabilities it carries:

- `settings.update`, all `device.*`;
- creating a trusted bot or any update that sets `profile: 'trusted'`;
- changing `workspace`, `mcpServers` or `agentId` of a trusted bot, or
  `session.selectAgent` on a trusted bot's session.

Other management (`bot.*`, `grant.*`) requires the `settings` capability and the
same owner. `audit.list`, `bot.session.create` and session commands require
`conversation`.

### Bots, sessions and profiles

Bots live in SQLite per owner (`bot.create|update|delete`, `bot.session.create`;
sessions carry `botId`). v1 `session.create` binds the session to an
automatically created per-(owner, agent) default bot (strict, no MCP), and a
startup migration does the same for existing sessions. `session.selectAgent` on
a default-bot session moves it to the new agent's default bot; a custom bot keeps
its session. The session's `agentId`/`modelId` select the adapter for a run;
`bot.update` of `agentId`/`modelId` affects new sessions. In `bot.update`
patches, `modelId: ""` / `workspace: ""` clear the field. Deleting a bot cancels
and deletes its sessions, revokes its grants and keeps its audit history.

A bot's `workspace` is stored canonical (realpath) and must be an existing
directory. `trusted` requires a workspace. Every run gets an
`AgentRunContextV2` (a superset of the v1 context, so v1 adapters keep working)
with `profile`, `bot` (MCP secrets blanked), `instructions` (bot instructions;
memory/skills composition is P4), and an `AdapterStateStore`. The adapter must
list the profile in `profiles` (absent means `['strict']`), otherwise the task
fails `PROFILE_UNSUPPORTED`; a trusted-only adapter is therefore never used for a
strict bot. A trusted run re-verifies that the workspace still exists and is
canonical (`WORKSPACE_UNAVAILABLE` otherwise). Only trusted runs receive
`workspace`, `host` (with `GatewayOptions.workspaceHost`) and `mcp` (with
`GatewayOptions.mcpBroker` and at least one enabled server). Executor tools
(`tool.run`, `executeTool`) always run under the strict executor.

`AdapterStateStore` is persisted per (owner, session, adapter), must be JSON of at
most 64 KiB serialized (`LIMIT_EXCEEDED`), and is deleted with the session.

### Authorization pipeline

One function authorizes executor tool requests, executor/adapter
`requestPermission`, agent built-in tools (`agentTool`), host-channel operations
and MCP calls:

1. **Capability** held by the task principal, else `FORBIDDEN` (audited as policy).
2. **Policy**: paths canonicalized by core (DB files refused); host-channel paths
   and command `cwd` must lie inside the task workspace (`OUTSIDE_WORKSPACE`,
   denied without prompting); agent built-in tools need a trusted run; adapters
   cannot submit `command`, `mcp` or `routineRunId` detail themselves.
3. **Standing grant** of the task's bot that matches (see below): allow, audited
   `via: 'standing'` with `grantId` and `decidedBy` = grant creator.
4. **Existing once/task grant** of this task (v1 semantics; v2 detail must match:
   same agent tool kind, identical command reason/argv/cwd, same MCP server/tool).
5. **Live approval** (`permission.requested`), audited `via: 'interactive'` with
   the deciding principal. Task end denies open requests (audited `policy`).

Once approvals from the host channel, MCP and agent built-in tools are never
retained: each such request needs its own approval or standing grant. Every
decision for a bot task is written to the `audit` table and emitted as
`grant.audited`. `audit.list {botId?, limit? (≤500, default 50), beforeId?}` pages
newest first; an unknown cursor is `INVALID_CURSOR`.

### Standing grants

`grant.create {botId, capability, scope, expiresAt?}`, `grant.revoke`, and
`permission.decide` with `scope: 'standing'` (allow only; requires the
`settings` capability; the scope must cover the request, otherwise the command
fails and the request stays pending). Scope fields are exact per capability:

| capability | required | optional | match |
| --- | --- | --- | --- |
| `file.read/write/delete` | `folder` | | every canonical request path is the folder or beneath it |
| `process.spawn` | `commandPrefix` | `folder` | argv starts with the literal tokens; canonical `cwd` inside `folder` (default workspace); requests with environment variables never match |
| `mcp.call` | `mcp.serverId` | `mcp.tool` | same server; same tool if given |
| `tool.execute` | `agentToolKind` | | agent built-in tool of that ACP kind |

`settings`, `conversation`, `library.install`, `network` and custom Python
(`Execute custom Python sha256:`) can never be standing (`STANDING_FORBIDDEN`);
executor `tool.execute` requests never match. Folders are canonicalized at
creation, must exist, and must lie inside the bot workspace (also re-checked at
match time against the task's workspace). Matching is canonical and
segment-based (`/a/bc` never matches `/a/b`; a symlink inside the folder that
resolves elsewhere is judged by its target) and case-insensitive on
win32/darwin (simple lower-casing). `mcp.serverId` must be a configured server
of the bot (or `your_bot`). Grants are read from SQLite on every request, so
revocation and expiry apply to the next request, including inside running
tasks. Snapshots list active grants; `grant.updated` reports changes.

### Host channel

For trusted runs with `GatewayOptions.workspaceHost`, core implements
`WorkspaceHostChannel`. Each file call resolves the path with
`WorkspaceHost.resolve` (relative to the workspace), re-checks canonical
containment itself, authorizes `file.read`/`file.write` with the canonical path
and only then performs the operation. `createTerminal` authorizes `process.spawn`
with `{command, args, cwd}` (canonical cwd; environment variables are shown in
the request reason). Terminal follow-up calls need no approval but only accept
terminals created by the same task (`TERMINAL_NOT_FOUND`). At task end core calls
`WorkspaceHost.releaseTask(taskId)`. Errors carry a `code`
(`PERMISSION_DENIED`, `OUTSIDE_WORKSPACE`, `TERMINAL_NOT_FOUND`, `CANCELLED`,
`INVALID_INPUT`, `UNSAFE_PATH` for missing/irregular targets, or the host's own
code).

### MCP, devices and host identity

With `GatewayOptions.mcpBroker`, a trusted run whose bot has enabled MCP servers
gets a per-task proxy (`broker.open` with decrypted server configs and
`authorize` = pipeline with `mcp.call` + `{serverId, tool}` detail; arguments are
shown in the reason, truncated to 4 KiB). The principal needs the `mcp.call`
capability. The proxy is closed at task end; open failures are reported as a
task status and the run continues without MCP. `device.*` commands are routed to
`GatewayOptions.devices` for the local owner only (`NOT_SUPPORTED` without it);
devices appear only in the local owner's snapshot and `device.updated` is sent
only to the local principal. `host` defaults to a persisted random id and the OS
host name. Snapshot fields owned by P4 (`routines`, `routineRuns`,
`notifications`, `skills`) are empty, and the P4 commands (`memory.*`,
`routine.*`, `session.compact`, `notification.ack`, `skills.refresh`) return
`NOT_SUPPORTED`.

The gateway closes the injected executor, adapters, `workspaceHost` and
`mcpBroker` on `close()`; it does not close the `DeviceManager`.

### Secrets at rest

With `GatewayOptions.secretCipher`, provider `apiKey`s, the credential redaction
registry and MCP `env`/`headers` values are stored only as ciphertext tagged with
the cipher id. On open, existing plaintext is migrated and the file is VACUUMed.
Opening encrypted data without a cipher fails `SECRET_CIPHER_REQUIRED`, with a
different cipher id `SECRET_CIPHER_MISMATCH`. Without a cipher, storage keeps the
v1 plaintext format. MCP secret values are returned as `""` (keys kept) in every
snapshot, result and event; an update sending `""` for an existing key keeps the
stored value. Values of at least 8 characters are added to the redaction
registry (shorter values would corrupt ordinary output).

### Limits and known gaps

- Bots: name 256, instructions 64 KiB, ≤32 MCP servers, ≤200 skills; MCP server
  ids `^[A-Za-z0-9][A-Za-z0-9-]{0,63}$` (no `_`, so `<serverId>__<tool>` is
  unambiguous); http MCP URLs must be http(s) without embedded credentials.
- Command-prefix grants trust the argv literally: a prefix such as `["git"]`
  allows every git subcommand and its options (including ones that touch paths
  outside the workspace). Keep prefixes narrow.
- Remote devices may start runs of trusted bots and create standing grants if
  their principal holds `settings` (the remote host's default capabilities do
  not include it).

## Verification

From the worktree root:

```sh
npm install --ignore-scripts
npm run build -w @your-bot/contracts
npm run build -w @your-bot/core
npm run typecheck -w @your-bot/core
npm run test -w @your-bot/core
npx vitest run packages/core
npm run test:security   # includes packages/core/src/security*.test.ts
```

The suite uses real SQLite plus fake adapters/executors. It covers strict runtime
validation, owner separation, command deduplication, streaming/replay, denied
writes, exact grants and spoofing, package approval, executor-driven requests,
once/task scope, concurrent tool serialization, path/link substitution, provider
reload and credential scrubbing, cancellation, deletion races, close cleanup,
and persistence across real close/reopen. Crash-task recovery is tested by
seeding an interrupted SQLite task row, rather than killing a worker process.
No actual provider, Electron IPC, Python sandbox, or ACP process was tested here.

The v2 suites (`v2.test.ts`, `security-v2.test.ts`) use real SQLite and a real
temporary filesystem with fake `WorkspaceHost`, `McpBroker`, `DeviceManager` and
`SecretCipher` implementations (`v2.fixtures.ts`). They cover strict v2
validation, v1/v2 event filtering, default bots and migration, bot CRUD and
canonical workspaces, adapter state, host identity, owner-device approvals and
owner-only refusals, standing-grant folder matching (sibling, prefix trick,
symlink and workspace escapes), mid-task revocation, forbidden standing types,
audit for standing/interactive/policy, host-channel policy denial without
prompting, terminal ownership and release, profile gating
(`PROFILE_UNSUPPORTED`, strict bots never get host/workspace/MCP), MCP
authorization, and secrets absent from the database file bytes (including
plaintext migration).
