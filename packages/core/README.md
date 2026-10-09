# Core integration

`@your-bot/core` implements the frozen v1 `DesktopGateway`, without Electron,
HTTP listeners, provider code, or sandbox implementation. It uses the built-in
`node:sqlite` API and requires Node 22.13+ (or an Electron main runtime providing
that API). Its public exports are `createGateway(options):
Promise<DesktopGateway>` and the TypeScript `GatewayOptions` interface.

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
host on every dispatch. Ownership is enforced independently on session/task
operations, event delivery, replay, command deduplication, and permission
decisions. Provider settings are readable/updatable only by the local owner
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
`tool.execute` has capability-level granularity within the task because v1 has
no invocation scope field. File and package grants remain exact.

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
nonregular, or hard-linked DB files. SQLite uses full synchronous commits and
delete journaling; credentials remain local in this DB. These filesystem modes
are a POSIX guarantee. A Windows host must provide equivalent private ACLs.
There is no encryption-at-rest, authenticated transport, or OS sandbox in core.

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

Event and command history currently have no retention/compaction policy. Core
does not negotiate sandbox capabilities or verify an ACP launch containment
implementation: adapters/executor must enforce the architecture security rules.
No contract changes were required.

## Verification

From the worktree root:

```sh
npm install --ignore-scripts
npm run build -w @your-bot/contracts
npm run build -w @your-bot/core
npm run typecheck -w @your-bot/core
npm run test -w @your-bot/core
npx vitest run packages/core
```

The suite uses real SQLite plus fake adapters/executors. It covers strict runtime
validation, owner separation, command deduplication, streaming/replay, denied
writes, exact grants and spoofing, package approval, executor-driven requests,
once/task scope, concurrent tool serialization, path/link substitution, provider
reload and credential scrubbing, cancellation, deletion races, close cleanup,
and persistence across real close/reopen. Crash-task recovery is tested by
seeding an interrupted SQLite task row, rather than killing a worker process.
No actual provider, Electron IPC, Python sandbox, or ACP process was tested here.
