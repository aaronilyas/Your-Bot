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

## Remote transport (v2)

`packages/remote` implements the transport host described by the v1 design: a TLS 1.3 WebSocket listener (no plaintext port) whose self-signed certificate clients pin, single-use pairing codes, Ed25519 device keys and per-connection challenge signatures. After authentication it derives `PrincipalV2 {id:'device:<id>', kind:'remote', ownerId:<local owner>, deviceId, capabilities}` server-side, dispatches only v2 command frames and subscribes with `{contractVersion: 2}`. Disconnect unsubscribes without cancelling tasks; clients resume through `state.sync` with a sequence cursor (`INVALID_CURSOR` for a cursor ahead of the host). Revocation closes live sockets. `MultiHostClient` keeps several hosts and resumes each independently.

## v2 composition and authority

Contract v2 (`packages/contracts/src/v2.ts`) is additive: v1 commands keep their meaning, every event carries the version that defines it, and v1 subscribers receive only v1-shaped events. `createGatewayV2` serves both versions; `createGateway` stays v1-only. Data is owned by `ownerOf(principal) = ownerId ?? id`, so paired devices act on the owner's data, while owner-only operations (settings, trusted profile, a trusted bot's workspace/agent/MCP servers, devices) require the local principal.

`packages/runtime` composes the gateway for both the desktop and `apps/host`: Python executor, `WorkspaceHost`, MCP broker, skill catalog, secret cipher, host identity, notifier, adapters (strict containment launchers and host-launched trusted ACP) and, optionally, the remote host as `DeviceManager`. Adapters receive an `AgentRunContextV2`; trusted runs additionally get `workspace`, a core-implemented `WorkspaceHostChannel` and an MCP proxy endpoint. One authorization pipeline serves tools, host channel, MCP and agent permissions: capability → policy → standing grant → task grant → live approval, with every bot decision audited. Routines run as the local owner with a bounded capability set under an injectable clock; blocked runs wait for approval indefinitely.

The headless host's owner control channel is a unix socket (0600, inside the 0700 data directory; a named pipe on Windows) whose first frame must carry the data directory's control token; later frames are v2 commands dispatched as the local owner.
