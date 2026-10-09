# Your Bot architecture

Contract version 1 is frozen in `packages/contracts/src/index.ts`. Electron main owns the authenticated local Principal and application state. The renderer receives only `BackendTransport.dispatch/subscribe`; it cannot select an identity or invoke providers or execution directly. Gateway events carry owner identity, monotonic sequence and timestamp. Commands carry unique IDs; retries are deduplicated per principal. Cancellation is task scoped and aborts adapters, pending approvals and execution.

The core owns SQLite sessions, messages, settings and event replay. It injects adapters and executor. Adapter tool calls always pass back through core authorization before execution. Approval decisions refer to a live request and cannot broaden its original paths, packages, task or identity. Credentials are local, excluded from renderer snapshots, and database storage must have owner-only access. Remote identity cannot claim the local principal.

Python runs only inside Linux bubblewrap with isolated namespaces, readonly runtime, private scratch, and only explicitly approved paths bound into the worker. Process creation requires an OS seccomp boundary; absent enforcement fails closed. Dependency installation is a separate approval and scoped venv operation. ACP harnesses must also be contained; capability negotiation alone cannot constrain a malicious process.

Packages: contracts (wire types), core (gateway/storage/authorization), adapters (ACP and OpenAI-compatible local models), executor (Python skills/sandbox). Desktop uses React/Vite and Electron with sandbox/context isolation enabled. Integration tests run the gateway without Electron.

Future mobile: authenticate and pair in a transport host, derive a Principal server-side, then call the existing `DesktopGateway.dispatch` and `subscribe`. Synchronize through `state.sync` and sequence cursors. Add TLS/relay and authorization to that transport; no remote listener is included here.
