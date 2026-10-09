# Your Bot adapters integration

`@your-bot/adapters` implements the frozen `AgentAdapter` contract from commit
`b133e1d`. Import this package only in the trusted backend. It creates no listener,
executes no shell, and contains no executor or UI implementation.

```ts
import { BubblewrapContainmentLauncher, createAdapters } from '@your-bot/adapters';

// Host-approved entrypoint; bundle sibling application code into this one file.
const scriptPath = '/opt/your-bot/harness.mjs';
const containment = new BubblewrapContainmentLauncher({ scriptPath });
// The matching ACP ProviderConfig must use:
// command: '/usr/bin/node', args: [scriptPath]

const adapters = createAdapters(settings.providers, {
  local: { timeoutMs: 120_000, maxToolRounds: 8 },
  acpByProvider: {
    'my-harness': { containment, timeoutMs: 120_000 },
  },
});
const byId = new Map(adapters.map(adapter => [adapter.id, adapter]));
// Core supplies a principal-bound AgentRunContext, including executeTool and
// requestPermission closures that perform core authorization.
await byId.get(session.agentId)!.run(context);
// On task cancellation, core also aborts context.signal and its executor/approvals.
await byId.get(session.agentId)!.cancel(context.taskId);
// On application shutdown or provider replacement:
await Promise.all(adapters.map(adapter => adapter.close()));
```

All public exports are in `src/index.ts`:

- `createAdapters(configs: readonly ProviderConfig[], options?: AdapterFactoryOptions): AgentAdapter[]`.
- `AcpAdapter`, `AcpAdapterOptions`; `OpenAICompatibleAdapter`, `LocalAdapterOptions`.
- `ContainmentLauncher`, `HarnessLaunchRequest`, `ContainedHarness`, `NativePermissionPlan` types.
- `BubblewrapContainmentLauncher`, `BubblewrapContainmentOptions`: concrete Linux
  implementation. `acp.containment` and `acpByProvider[id].containment` inject it.
  The original `launcher` option remains an alias; specifying both is rejected.
- `AdapterError` and `normalizeAdapterError(error, signal?)`. Errors implement the
  frozen `StructuredError` fields, with safe generic messages; no upstream HTTP
  error bodies, stderr, API keys, command arguments, or arbitrary exception text.
- `parseSse`, `parseToolInvocation`, `TOOL_DEFINITION` for transport/integration use.

Adapters snapshot configuration when constructed. Replace and close the old
adapters when settings change. Provider IDs must be unique. Each provider and task
has independent cancellation state; duplicate active task IDs within one adapter
are rejected. `cancel` and `close` await adapter cleanup, but do not cancel core
callbacks themselves. Emit handlers should be synchronous and must not call and
await `cancel` from inside an emit callback.

## Local HTTP providers

LM Studio defaults to `http://127.0.0.1:1234/v1`, llama.cpp to
`http://127.0.0.1:8080/v1`. `openai-compatible` requires `endpoint`. A bare server
origin gains `/v1`; otherwise the endpoint is an explicit API base such as
`https://host/prefix/v1`. Discovery GETs `models`; generation POSTs
`chat/completions`. Selection priority is session model, provider model, then the
first discovered model. Disabled providers make no requests. Discovery failure
returns an unavailable `AgentInfo` with a safe limitation.

Credentials are used only in the Authorization header. Endpoint userinfo, query
parameters and fragments are rejected, and redirects are refused so credentials
cannot be forwarded. There is no logging facility. The host must keep
`ProviderConfig.apiKey` out of renderer snapshots and logs; that remains a core
responsibility. Configured HTTP(S) endpoints are trusted host settings, not
arbitrary URLs supplied in chat messages. Default endpoints are loopback, but
explicit remote endpoints are supported; host network policy can inject `fetch`.

SSE decoding handles fragmented UTF-8 and CR/LF/CRLF, comments, multiline data,
usage chunks and `[DONE]`. JSON completions are accepted when the server does not
stream. A clean finish marker is required; truncated streams, invalid JSON,
upstream errors, refusals/token exhaustion and response limits fail explicitly.
Responses are bounded to 16 MiB per round, SSE events to 1 MiB; both are configurable
through `maxResponseBytes` (which caps the event bound too).

The model receives one function, `execute_tool`, whose arguments are a
`ToolInvocation` without `id`: `kind`, `input`, and optional `skillId`, `code`,
`packages`, `paths`, `timeoutMs`. Calls receive the streamed tool call ID.
Arguments are validated as a complete batch before any tool executes. Unknown
functions, malformed arguments, authorization fields, duplicate IDs and unknown
kinds are refused. Every accepted call invokes **only** `context.executeTool`;
status updates do not constitute authorization. Tool results, including denied
results, are sent back with the matching tool call ID. The adapter does not emit
`AgentUpdate.type = 'tool'`, avoiding a second execution by hosts that interpret
that update as a request. Calls execute sequentially, capped at 16 per round and
8 tool rounds by default; a final response round is allowed after the last tool
round. Streaming calls can be aborted during HTTP reads or host-tool waits.

Real LM Studio/llama.cpp instances and specific models were not available for this
implementation's tests. Models must support OpenAI-style function calling; there
is no heuristic parsing of tool requests from prose and no automatic tool-free
fallback on HTTP errors.

## ACP v1 and enforced containment

**Without an injected containment launcher, ACP is unavailable and run rejects
`CONTAINMENT_UNAVAILABLE` before spawning anything, on every OS.** The concrete
`BubblewrapContainmentLauncher` verifies enforcement at launch time. A launcher is
a trusted host capability, never a flag supplied by a harness or provider settings.

### Supported concrete Linux launcher

Requires Linux x86_64 LP64, glibc, root-administered `/usr`, `/usr/bin/bwrap`
(tested 0.11.1, must support sized tmpfs and fd binds), and `/usr/bin/cc` with
Linux/libc development headers. User, PID, network, IPC and mount namespaces must
work, and seccomp filter TSYNC must be available. Denied namespaces, missing
dependencies, unsupported executables/layouts, compilation errors or failed
bootstrap confirmation fail closed. There is no shell or unsandboxed fallback.
Compilation uses a fixed trusted C source and flags, clean environment, and a
private owner-only temporary directory; it runs once per launch, outside the
sandbox. Install these OS dependencies as part of trusted application setup.

The only accepted commands are `/usr/bin/node` with one declared `.mjs` script,
or `/usr/bin/python3` with one declared `.py` script. `args` must be exactly
`[options.scriptPath]`. Runtime options, additional script arguments, arbitrary
executables, wrapper scripts, environment overrides, static binaries, non-glibc
ELF interpreters, and setuid/setgid or user-writable runtime executables are
refused. The runtime must be a root-owned dynamic ELF64 x86_64 `/usr` binary.
The runtime executable is pinned through an open fd; the canonical opened script
is copied into private state (maximum 1 MiB), then into a readonly sandbox file.
No entrypoint's sibling files or parent directory are mounted.

The mount policy exposes only that runtime executable, the bootstrap library and
script, `/usr/lib/x86_64-linux-gnu` and/or `/usr/lib64`, and the selected runtime's
system modules. Python requires `/usr/lib/python3.<version>` and optionally binds
`/usr/lib/python3/dist-packages` and `/usr/lib/locale`. Node optionally binds
`/usr/lib/nodejs` and `/usr/share/nodejs`; `/harness/node_modules` points to the
latter so bundled scripts can import distro-installed modules. These library
trees must be root-administered and are part of the trusted runtime. This is not a
computed per-library dependency closure. Other layouts may fail closed. `/usr/local`,
`/etc`, host home/projects/tmp, settings, credentials and host environment are
absent. `/proc` describes only the private PID namespace; `/dev` is minimal.
The root scaffolding and runtime mounts are readonly. `/scratch` is one sized
private tmpfs, and `/tmp` is a symlink to the same filesystem. ACP cwd is `/scratch`.

A trusted `LD_PRELOAD` constructor sets hard limits and `no_new_privs`, installs
an irreversible seccomp allowlist with TSYNC, and only then confirms readiness on
a private pipe, closes the pipe and removes bootstrap environment variables.
This runs before Node/Python executes the untrusted script. Distro runtime,
dynamic loader and system library constructors are trusted. Native code inside a
script remains subject to seccomp. Allowed clone flags require
`CLONE_THREAD|CLONE_VM|CLONE_SIGHAND`, permit only libc threading flags, and reject
namespace, vfork, exit-signal and other process-creation flags. `clone3` returns
ENOSYS for safe libc fallback. `fork`, `vfork`, exec, socket creation (including
Unix socketpair), connect/bind, ptrace, namespace/mount operations, io_uring, bpf,
keyrings, pidfd access, process_vm and unknown syscalls return EPERM. Only narrowly
scoped stdio metadata queries and safe terminal/descriptor queries are permitted.
No filter removal, privilege elevation, limit raising or native permission grant
is exposed. New runtime syscall requirements cause failure rather than relaxing
the boundary automatically.

Options and defaults: `scratchBytes` 64 MiB (combined `/scratch` + `/tmp`),
`addressSpaceBytes` 8 GiB, `fileBytes` 16 MiB per file, `cpuSeconds` 30,
`wallTimeMs` 120,000 and `startupTimeoutMs` 10,000. The startup confirmation deadline
begins after compilation; the independent wall deadline includes all setup.
Hard limits also disable core dumps, cap descriptors at 64 and stack at 8 MiB.
Address space is a virtual-memory bound, **not an RSS/cgroup bound**; Node's V8
old space is additionally fixed at 256 MiB and Wasm trap-handler reservations are
disabled. Thread creation consumes those process-wide memory/CPU limits; there is
no separate thread-count cap. Node native addons are disabled. The launcher kills
the detached Bubblewrap supervisor group on abort/deadline, waits for teardown,
and removes private setup files. PID namespace teardown and `--die-with-parent`
cover runtime threads and host termination. A host crash can leave owner-only
setup files in the host temporary directory; runtime scratch is kernel-owned
tmpfs and disappears with containment.

This policy denies **all networking** with no allow-network option. It supports
stdio harnesses with in-process/system-library logic, rather than harnesses that
require HTTP model servers, cloud credentials, subprocess tools, installed native
Node addons, interactive authentication or arbitrary user modules. Actual tools
must use `_your_bot/execute_tool` to reach core. The launcher has no
`preparePermission`; native ACP grants stay denied. Other trusted launcher
implementations can still implement the interface described below.

`launcher.launch({command, args, signal})` must return a `ContainedHarness` with
piped `process` stdio, an absolute **sandbox-internal** private-scratch `cwd`, and
`terminate()` which kills **all descendants**, releases scratch and resolves only
after teardown. It must abort and release a partially started sandbox if launch
is cancelled. The adapter bounds termination waits (5 seconds by default), reports
`CONTAINMENT_FAILURE` when teardown cannot be confirmed, and retires a late launch
handle defensively. A faulty launcher that never returns a handle cannot be
repaired by the adapter; the launcher must own that lifecycle.

The launcher must enforce OS isolation (for Linux: bubblewrap namespaces plus
seccomp or an equivalent enforceable boundary), readonly minimal runtime,
private scratch, no user home or project mounts, no inherited secret environment,
no shell tools, constrained process creation/execution, bounded resources,
explicitly scoped networking and complete descendant teardown. `shell:false`,
`env:{}`, a PID kill, promises from the agent, and advertised ACP capabilities
are not substitutes. The adapter never supplies the user home, host cwd,
`process.env`, or provider API key to the launcher. Explicit credentials needed by
a harness must be provisioned through a separate trusted, narrowly scoped host
mechanism, with no inherited environment.

Each run launches a fresh containment, initializes `protocolVersion: 1`, creates
`session/new` with private scratch and no MCP servers, sends `session/prompt`, and
streams matching `session/update` text and status until the prompt response.
JSON-RPC is newline-delimited UTF-8, with bounded messages (1 MiB), total
stdout+stderr (16 MiB) and outstanding requests (32). Stderr is drained and
discarded. Exit, malformed protocol, unexpected session IDs, timeouts and
unsupported protocol versions become normalized errors. Thoughts, multimodal
content and unknown notification extensions are not surfaced.

A selected model must be advertised through current v1 select `configOptions`
with category `model` (or uncategorized ID `model`). Flat and grouped options are
supported. Selection uses `session/set_config_option` and validates the confirmed
value. Unadvertised selections fail rather than silently use another model.
`getInfo()` is a configuration check and does not spawn a discovery process;
model options observed during runs are cached for later `getInfo()` calls. Actual
process availability and protocol compatibility are checked at run time. Leave
modelId unset for a baseline harness without model configuration options.

Client filesystem and terminal capabilities are false. All `fs/*`, `terminal/*`,
and other unsupported requests return JSON-RPC method-not-found, even when a
harness ignores capability negotiation. ACP tool notifications describe harness
activity and are never re-executed by core. Native tools stay inside containment.
Permission kind/name/location metadata is not treated as an enforcement boundary.

Standard `session/request_permission` requests are denied with `reject_once`
unless the contained handle supplies `preparePermission(toolCall, signal)`. That
trusted callback must produce an exact enforceable `NativePermissionPlan`;
the adapter forwards its request to `context.requestPermission`, then invokes
`allowOnce(signal)` **after** an allow decision. It selects `allow_once` only when
OS enforcement succeeds. No `allow_always` or `reject_always` option is selected,
even for a core task-scoped grant. Missing plans/options, core denial and enforcement
errors fail closed. Plans must remain scoped to the exact operation and be revoked
on abort/termination; this optional mechanism is not a generic native-tool grant.
Filesystem/terminal RPCs remain refused even with a plan. Cancellation sends
`session/cancel`, returns `cancelled` to pending permission requests, suppresses
late text, and terminates containment.

A harness that supports gateway-executed tools can use the explicit extension
advertised in `clientCapabilities._meta['your-bot/execute-tool']`:

```json
{
  "jsonrpc": "2.0",
  "id": 100,
  "method": "_your_bot/execute_tool",
  "params": {
    "sessionId": "the-current-acp-session",
    "toolCallId": "unique-call-id",
    "arguments": {"kind": "skill", "skillId": "example", "input": {}}
  }
}
```

Its result is exactly the host's `ToolResult`; invocation validation, authorization
and execution follow the same core path as local model tools. Native permission
requests and extension calls share a per-run budget of 64. Calls are accepted only
for the current active prompt and cannot reuse extension tool IDs. This is a Your
Bot extension, not a standard ACP tool execution RPC. Standard ACP has no portable
mechanism to execute every native tool through the host executor.

## Frozen-contract limits and host obligations

Contract v1 has no tool-call correlation fields on stored `ChatMessage`, no opaque
ACP session persistence, no system role and no callback cancellation argument.
Consequently historical local tool messages are replayed as labelled user context;
ACP replays a text transcript into a fresh session. This preserves visible history
but not exact structured tool history or hidden harness state. ACP interactive
authentication, terminal login, persistence, arbitrary MCP servers and v2 are not
implemented.

The adapter's deadline stops transport and its wait for a callback. It cannot
forcibly abort a core-owned `executeTool` or `requestPermission` closure because
those frozen signatures do not accept its internal signal. **Core must cancel its
executor and revoke pending approvals on every rejected run, including TIMEOUT,
transport failure and containment failure**, and on task cancellation/shutdown.
No late callback result is emitted by this package. The supplied launcher receives
the internal signal, so its native OS permissions must expire automatically.
See `CONTRACT_REQUEST.md` for optional future contract improvements; no contract
change is required to integrate this package now.

## Verification

From the assigned worktree/root, after workspace installation:

```sh
npm run build -w @your-bot/contracts
npm run typecheck -w @your-bot/adapters
npm run build -w @your-bot/adapters
npm run test -w @your-bot/adapters
```

The package's tests also match the root Vitest include pattern. Protocol tests use local
HTTP servers and a mock JSON-RPC stdio harness, exercising discovery, fragmented
streaming, tool results, authorization forwarding/refusal, cancellation, timeout,
limits, model selection, independent providers and cleanup. The test-only launcher
uses an **unsandboxed deterministic fixture**, explicitly to test protocol behavior;
it is never exported or used as a production fallback. These tests do not claim
bubblewrap/seccomp enforcement success by themselves.

`test/bubblewrap.test.ts` adds **12 real, passing OS-isolation tests** on this Linux
x86_64 host using `/usr/bin/bwrap`, `/usr/bin/cc`, Node and Python 3.14. They prove
contained ACP initialization/streaming, native grant and filesystem-RPC refusal,
core tool-extension routing, malicious direct-syscall denial, unchanged host
sentinels in tmp/home, unreadable home secrets (including proc-root bypass probes),
no inherited secret environment, readonly root/runtime, safe threads, sized
scratch exhaustion, hard limits, abort/partial-startup cleanup, and wall teardown.
Missing OS dependencies or denied isolation **fail** these tests on Linux x86_64;
only other platforms are explicitly skipped. No real third-party production ACP
harness or cloud/local inference engine was available; the end-to-end contained
harnesses are deterministic fixtures. The full adapter suite has 74 passing tests.

Containment references: [Bubblewrap source/lifecycle](https://github.com/containers/bubblewrap/blob/main/bubblewrap.c),
[Linux seccomp filter behavior](https://man7.org/linux/man-pages/man2/seccomp.2.html),
and [no_new_privs](https://man7.org/linux/man-pages/man2/PR_SET_NO_NEW_PRIVS.2const.html).

Official ACP sources checked 2026-10-09:
[initialization](https://agentclientprotocol.com/protocol/v1/initialization),
[session setup](https://agentclientprotocol.com/protocol/v1/session-setup),
[prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn),
[tool calls and permissions](https://agentclientprotocol.com/protocol/v1/tool-calls),
[stdio transport](https://agentclientprotocol.com/protocol/v1/transports),
[configuration/model selectors](https://agentclientprotocol.com/protocol/v1/session-config-options),
[extensions](https://agentclientprotocol.com/protocol/v1/extensibility), and the
[official v1 schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json).
