# Your Bot architecture

Contract version 1 is frozen in `packages/contracts/src/index.ts`. Electron main owns the authenticated local Principal and application state. The renderer receives only `BackendTransport.dispatch/subscribe`; it cannot select an identity or invoke providers or execution directly. Gateway events carry owner identity, monotonic sequence and timestamp. Commands carry unique IDs; retries are deduplicated per principal. Cancellation is task scoped and aborts adapters, pending approvals and execution.

The core owns SQLite sessions, messages, settings and event replay. It injects adapters and executor. Adapter tool calls always pass back through core authorization before execution. Approval decisions refer to a live request and cannot broaden its original paths, packages, task or identity. Credentials are local, excluded from renderer snapshots, and database storage must have owner-only access. Remote identity cannot claim the local principal.

Python runs only inside Linux bubblewrap with isolated namespaces, readonly runtime, private scratch, and only explicitly approved paths bound into the worker. Process creation requires an OS seccomp boundary; absent enforcement fails closed. Dependency installation is a separate approval and scoped venv operation. ACP harnesses must also be contained; capability negotiation alone cannot constrain a malicious process.

Packages: contracts (wire types), core (gateway/storage/authorization), adapters (ACP and OpenAI-compatible local models), executor (Python skills/sandbox). Desktop uses React/Vite and Electron with sandbox/context isolation enabled. Integration tests run the gateway without Electron.

Future mobile: authenticate and pair in a transport host, derive a Principal server-side, then call the existing `DesktopGateway.dispatch` and `subscribe`. Synchronize through `state.sync` and sequence cursors. Add TLS/relay and authorization to that transport; no remote listener is included here.

## Production composition

`apps/desktop/src/main/entry.ts` calls `createDesktopHost` with `createApplicationGateway` from `backend.ts`. The host provides its authenticated principal and Electron user-data directory. The factory creates the managed Python executor and SQLite gateway; its settings callback creates real local HTTP adapters and per-provider Linux ACP containment launchers. Stored configuration is reloaded at startup. Provider replacement is allowed only while tasks are idle, and closes retired adapters. The bundled main process includes all backend packages; Python remains an externally installed system runtime.

The renderer's sandboxed CommonJS preload exposes only `window.yourBot.dispatch/subscribe`. IPC checks sender, main frame, origin, payload schema and bounds before forwarding a command. The main process supplies identity; no wire command can choose a principal. The renderer never imports backend packages or fetches model endpoints. Browser demos use the same transport contract with explicitly simulated state.

## Tasks, permissions and persistence

Contract v1 defines JSON-compatible session, task and command IDs, principals, authorization contexts, structured errors, commands, events, adapter callbacks and executor callbacks. `message.send` and `tool.run` return accepted task IDs; sequenced events report progress, deltas, tool output, requests and exactly one terminal state. A session permits one active task. Abort propagates through provider reads, harnesses, pending approvals and Python workers. Late updates are suppressed. Host shutdown awaits dependency cleanup and closes SQLite.

Core writes sessions/messages/settings, event sequences and per-principal command receipts to SQLite. Retried identical command IDs return their recorded results; changed content conflicts. Interrupted receipts fail explicitly instead of repeating effects. On startup, interrupted tasks become cancelled and permissions are discarded. `state.sync` returns authoritative state; an `afterSequence` cursor replays only that principal's events before a fresh snapshot. Clients subscribe first, deduplicate sequences, and replace their state from that snapshot. History currently has no compaction policy.

Both local function calls and the ACP `_your_bot/execute_tool` extension enter `AgentRunContext.executeTool`, which is a core-owned closure. Core approves every invocation, exact file scope and package list. Executor additionally validates grants and immutable Python code, requests any missing read approval for writable mounts, and provides the OS boundary. Native ACP filesystem/terminal operations are refused; the contained harness has no network or process-spawn capability. API keys are persisted privately and used in backend HTTP headers, while snapshots and known credential strings are scrubbed.

## Future transport hook

A future authenticated WebSocket/relay host should receive the existing gateway instance through dependency injection. Its equivalent of Electron's validated dispatch handler derives `Principal` from pairing/authentication, calls `dispatch(command, principal)`, and forwards events from `subscribe(listener, principal)`. Unsubscribe on disconnect without necessarily cancelling the principal's tasks; reconnect through `state.sync`. Only an authorized owner can approve its live requests or cancel its tasks. Device revocation/capability assignment, encrypted communication, pairing, relay policy and connection limits belong in that host. They do not require renderer-to-model or remote-to-executor shortcuts. See `tests/helpers.ts` for a headless in-process transport using these exact operations.
