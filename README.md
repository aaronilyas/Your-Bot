# Your Bot

A standalone, local-first desktop AI assistant built with Electron, React, Vite and TypeScript. Conversations, settings and credentials stay in local SQLite storage. The application needs no cloud backend. Configure a local model server or a supported contained ACP harness to begin chatting.

The renderer uses one versioned command/event transport. Electron main binds the owner's identity and forwards validated commands to the same permission-enforcing gateway that a future authenticated mobile transport can use.

```text
React → sandboxed preload / Electron IPC → DesktopGateway → AgentAdapter
                                              ↑                 ↓
                                      approvals + SQLite ← tool requests
                                              ↓
                                       ToolExecutor
                                              ↓
                                  bubblewrap + seccomp Python
```

## Install and run

Development requires Node.js 22.13+ and npm. Secure execution currently requires Linux x86_64, a root-administered Python 3.10+ under `/usr`, its venv module, bubblewrap with sized tmpfs and FD binds (tested 0.11.1), and working user/PID/network namespaces. ACP containment additionally needs glibc, a C compiler and development headers. Windows/macOS execution fails closed; equivalent isolation is not implemented.

On a suitable Ubuntu system, install runtime dependencies using the system package manager:

```sh
sudo apt install python3 python3-venv bubblewrap gcc libc6-dev
npm ci
npm run build
npm start
```

`npm run dev` builds the backend and starts Electron with Vite renderer updates. `npm run package` creates Linux x64 AppImage, amd64 deb and unpacked artifacts in `apps/desktop/release/`. Packaged applications include Electron; Node is needed separately only for Node ACP harnesses. The deb does not install Python/sandbox prerequisites automatically. The project is MIT licensed.

Chromium's renderer sandbox must work on the host. If AppArmor prevents development Electron from starting, use an administrator-installed package or configure the host's approved Chromium sandbox policy. The application never supplies `--no-sandbox` and does not change system policy. The disposable container workflow below permits native validation without changing the host.

## Connect LM Studio or llama.cpp

Start the local server and load a model, then open **Settings → Add provider**. Choose **LM Studio**, **llama.cpp**, or **OpenAI compatible**. Defaults are `http://127.0.0.1:1234/v1` for LM Studio and `http://127.0.0.1:8080/v1` for llama.cpp. Enter the API base and optional model ID, save, refresh models, and select the agent/model before creating a conversation.

Model discovery uses `GET /models`; chat uses streamed `POST /chat/completions` relative to that API base. Models must support OpenAI-style function calling to use skills. Optional API keys are entered in a password field, stored locally, and never returned to the renderer. Blank preserves an existing key; the removal checkbox clears it. Explicitly configuring a remote endpoint sends prompts and tool results to that endpoint; loopback defaults keep inference local. Redirects and endpoint-embedded credentials are refused.

## Connect an ACP harness

In Settings, add an **ACP agent**, select the system Node or Python runtime, and enter one absolute `.mjs` or `.py` script path. The concrete Linux launcher accepts only `/usr/bin/node` or `/usr/bin/python3`, with exactly that script as its argument. Bundle application code into that file; user-local dependency directories and sibling scripts are not mounted. Node must be a supported root-owned dynamic system executable.

The adapter speaks ACP v1 JSON-RPC over stdin/stdout: initialization, session creation, prompting, streamed updates and cancellation. It starts a fresh contained session per turn and supplies the conversation transcript. Multiple configured providers create independent adapters. Harnesses cannot access home/projects, launch processes, open sockets, or obtain native terminal/filesystem permissions. Consequently harnesses requiring network/cloud access or their own filesystem tools are unavailable under this initial policy. There is no unrestricted fallback.

Harnesses can delegate tools through the documented `_your_bot/execute_tool` extension; the core asks the user and invokes the sandboxed executor. See [adapter integration and containment](packages/adapters/README.md). The self-contained fixture at [tests/fixtures/acp-agent.mjs](tests/fixtures/acp-agent.mjs) is a runnable protocol example: configure its absolute path as a Node ACP provider, send a message, approve the calculation, and receive 42. Third-party production harnesses remain unverified.

## Python skills and approvals

Included skills cover arithmetic/statistics, tabular data analysis, JSON/CSV parsing and exact-file read/write/delete. Local models receive the `execute_tool` schema and skill input descriptions. Every tool request passes through the core and an approval dialog; Python requests show the complete code and its hash. Approvals are bound to owner, task, operation and exact paths/packages, with once/task scopes only. A writable file binding additionally requires explicit read approval. Use `files[hostPath]` inside approved Python to access a declared file, and assign the result to `result`.

Python runs in an application-managed venv, a private worker process, bubblewrap namespaces, read-only runtime mounts and an irreversible seccomp filter. Network and subprocess access are denied even through Python libraries/native code. Time, address space, file size, scratch space and output are bounded. Missing/failed isolation returns a structured error before untrusted code executes.

Library installation is a separately approved `library.install` tool action, scoped only to the managed environment. It supports explicit PyPI universal pure-Python wheels, optionally pinned with `==`; dependencies require explicit listing. Downloads use a restricted HTTPS broker and verified registry hashes; offline pip runs inside the sandbox. Source builds, native wheels, arbitrary indexes and global installs are refused. Approved packages remain supply-chain inputs, and approved file writes are not transactional. See [executor APIs, skills and limits](packages/executor/README.md) and [security policy](docs/security.md).

## Validate

```sh
npm run build
npm run typecheck
npm test
npm run test:integration
npm run test:security
npm run package
npm run test:desktop
```

Sandbox tests execute real Python/bubblewrap and fail when the required boundary is unavailable; they do not silently skip or use unrestricted workers. The native desktop test needs Docker, downloads an Ubuntu test image, and runs the actual packaged renderer, preload and backend under Xvfb with a mock model server. It enables nested namespace creation in a disposable container, runs the application as a non-root user, and keeps Chromium and Python isolation enabled. It has no host mounts, credentials or runtime network access. Browser-only demo mode (`npm run dev:browser -w @your-bot/desktop`, then `http://127.0.0.1:5173/?demo=1`) remains available separately.

See [executed validation and limitations](docs/validation.md), [engineering report and branch reviews](docs/engineering-report.md), and [development workflow](docs/development.md).

## Architecture and future mobile access

`packages/contracts` owns frozen v1 serializable interfaces; `core` owns SQLite, sessions, authorization, command deduplication, sequenced events and cancellation; `adapters` owns ACP and local HTTP protocols; `executor` owns Python skills and OS isolation; `apps/desktop` owns the UI and authenticated IPC host. The production composition lives in `apps/desktop/src/main/backend.ts`.

A future mobile host should authenticate/pair the device, derive a `Principal` server-side, then forward the existing commands to `DesktopGateway.dispatch(command, principal)` and subscribe through `gateway.subscribe(listener, principal)`. Use `state.sync` with an event sequence cursor for replay and authoritative resynchronization. Add TLS/relay and device identity management at that transport boundary. No remote server or unauthenticated network command port is included. See [architecture](docs/architecture.md).
