# v2 plan: self-hosted bots (Grok Bot parity)

Contract: `packages/contracts/src/v2.ts` (frozen for this effort; changes only via the lead).
Read its header first: versioning, authority and ownership rules are normative.

## Invariants (every package)

1. Core is the only authority. Every file, command, network and MCP action requested by an agent
   is authorized by the gateway, then performed by a core-injected service. Adapters never get a
   `WorkspaceHost`, `McpBroker` or `ToolExecutor`.
2. The existing containment is the `strict` profile: unchanged, default, fail-closed. `trusted` is
   opt-in per bot and set only by the local owner principal (`kind: 'local'`).
3. Contract v1 stays valid; v1 tests keep passing unmodified. Everything new is v2 and additive.
4. No unauthenticated listener anywhere (remote WSS and the MCP loopback proxy included).
   Remote identity is derived server-side.
5. Tests prove behaviour with real processes where a boundary is claimed. No skipped security
   tests; opt-in tests for external agents/browsers are gated by env vars and say so.

## Environment notes

- Workstation and the `ubuntu` SSH alias are Arch-based (Omarchy), Node 26. The strict ACP launcher
  supports the Debian/Ubuntu multiarch layout only, so 11 strict/security tests fail on Arch hosts
  (`CONTAINMENT_UNAVAILABLE`, ELF loader not mounted). This is not a regression. Strict and security
  suites run in an Ubuntu 26.04 container (`npm run test:linux`, package P0).
- Installed ACP agents: Grok Build (`grok agent stdio`, ACP v1, `loadSession`, HTTP MCP) on
  workstation and `ubuntu`; Claude Code via `npx @agentclientprotocol/claude-agent-acp` (requires
  `claude` login) on all hosts; Codex on `ubuntu` (unauthenticated locally). Windows hosts
  (`windows`, `aaron.local`): Windows 11 x64, `claude` + git, no Node (use a portable Node in a
  temp dir). `macmini` is locked and unreachable until the owner unlocks it.

## Packages

Branch per package off `integration/grok-bot-parity`; commit only inside owned paths. Root
`package.json`, `vitest.config.ts`, contracts and docs are lead-owned: request changes in your
final report instead of editing them. New package skeletons already exist and are wired into the
root build order and vitest aliases.

### P0 `feature/p0-linux-container` — Ubuntu test runner
Owns `tests/linux/`. Adds (via lead) script `test:linux`. A Docker Ubuntu 26.04 image (reuse the
approach in `tests/desktop.Dockerfile` / `tests/run-desktop-smoke.mjs`: nested namespaces,
unmasked proc, no host mounts except a read-only copy of the repo via `git archive HEAD` or build
context, no secrets, network only for `npm ci`) that runs `npm ci && npm run build &&
npm run typecheck && npx vitest run` and then `npm run test:security` and `test:integration`,
printing a summary and exiting non-zero on failure. Must pass all 160 baseline tests on `main`.

### P1 `feature/p1-core-v2` — core: v2 gateway, bots, profiles, standing grants (packages/core)
- Accept `version: 1 | 2` commands; validate every v2 command shape strictly (extend
  `validation.ts`). `subscribe(listener, principal, {contractVersion})`: v1 subscribers get only v1
  event types with v1-shaped payloads (see contract header).
- Ownership: `ownerOf(p) = p.ownerId ?? p.id` keys all data and event routing. Accept remote
  principals whose `ownerId` equals the local id; reject `kind:'local'` with a foreign id or any
  `ownerId`; remote principals can never use the local id as `id`.
- Owner-only (local principal) operations: `settings.update`, any bot create/update that sets
  `profile:'trusted'`, changes `workspace` or `mcpServers` of a trusted bot, all `device.*`.
  Other management requires capability `settings` and same owner.
- Bots: SQLite table; CRUD commands; `bot.session.create`; `SessionV2.botId`. v1
  `session.create` binds the session to an auto-created per-agent default bot (strict); startup
  migration assigns existing sessions the same way. `trusted` requires `workspace` that exists,
  is a directory, and is stored canonical (realpath).
- Run selection: build `AgentRunContextV2` for every run (superset; v1 adapters keep working).
  Profile must be in `adapter.profiles ?? ['strict']`, else the task fails
  `PROFILE_UNSUPPORTED`. Only trusted runs get `workspace`, `host`, `mcp`.
- Authorization pipeline (one function, used by tools, host channel, MCP, agent permissions):
  capability held by task principal → policy (outside workspace, forbidden standing types) →
  matching standing grant (allow, audit `via:'standing'`) → v1 once/task grants → live approval.
  Every decision for a bot task is written to an `audit` table and emitted as `grant.audited`.
- Standing grants: `grant.create`, `grant.revoke`, decision `scope:'standing'`; validation and
  matching exactly per `StandingGrantScope` docs. Folder matching is canonical and segment-based
  (no `/a/bc` matching `/a/b`); case-insensitive on win32/darwin. Revocation is immediate (affects
  the next request, including in running tasks). `audit.list` pages newest first.
- Host channel: core implements `WorkspaceHostChannel` over an injected `WorkspaceHost`
  (`GatewayOptions.workspaceHost`): `resolve` → authorize `file.read`/`file.write` with the
  canonical path (or `process.spawn` with `command` detail and canonical cwd) → perform.
  Terminal follow-up calls need no approval but must belong to the task. `releaseTask` on task end.
- Agent built-in tools: adapter `requestPermission({capability:'tool.execute', agentTool})` flows
  through the same pipeline (standing via `agentToolKind`).
- MCP: if `GatewayOptions.mcpBroker` exists, run is trusted, and the bot has enabled servers (or
  P4 builtins), open a proxy per task with `authorize` = pipeline(`mcp.call`, `mcp` detail); set
  `context.mcp`; close at task end.
- `GatewayOptions.devices?: DeviceManager` (routes `device.*`, else `NOT_SUPPORTED`),
  `secretCipher?: SecretCipher` (encrypt provider `apiKey` and MCP env/header values at rest;
  migrate plaintext on open; scrub registry unchanged), `host?: {id,name}`.
- `AdapterStateStore` per (owner, session, adapter) in SQLite, ≤ 64 KiB, deleted with session.
- Snapshot v2 fields owned by P4 (`routines`, `routineRuns`, `notifications`, `skills`) are empty.
- Tests (`packages/core/src/*.test.ts`; put boundary tests in files named `security*.test.ts`):
  v1 suite unmodified and green; v1 subscriber never sees v2 events; remote owner-device can see
  and decide owner approvals but cannot set trusted/settings/devices; standing grant allows within
  folder and not in sibling/prefix-trick/symlink-escape paths; revoke takes effect mid-task;
  forbidden standing types rejected; audit entries for standing/interactive/policy; host channel
  outside-workspace denied without prompting; strict bot never gets `host`/`workspace`/`mcp`;
  adapter lacking `trusted` fails `PROFILE_UNSUPPORTED`; secrets absent from the DB file bytes.

### P2 `feature/p2-trusted-acp` — adapters: trusted ACP + continuity (packages/adapters)
- `HostLauncher`: spawns an installed agent CLI uncontained with `cwd = context.workspace`, no
  shell, minimal env allowlist (PATH, HOME/USERPROFILE, APPDATA, LOCALAPPDATA, XDG_*, TMP/TEMP/
  TMPDIR, LANG/LC_*, SystemRoot, ComSpec, PATHEXT) plus `envPassthrough` names. Windows: resolve
  PATHEXT; `.cmd/.bat` shims via `cmd.exe /d /s /c` with correct quoting. Terminate kills the
  whole tree (posix process group; `taskkill /T /F` on Windows).
- `AcpAdapter` gets `profiles`: containment only → `['strict']` (unchanged path); host launcher →
  `['trusted']`. A host launcher is never used for a strict context (fail closed, tested).
  `createAdapters` builds host-launched ACP adapters for `ProviderConfigV2.launch === 'host'`.
- Trusted run: advertise `fs.readTextFile/writeTextFile` and `terminal` only when `context.host`
  exists; serve `fs/read_text_file`, `fs/write_text_file`, `terminal/create|output|wait_for_exit|
  kill|release` via `context.host` (validate sessionId; map rejections to JSON-RPC errors with
  `data.code`). `session/request_permission` → `context.requestPermission({capability:
  'tool.execute', reason, agentTool, botId})`; allow → `allow_once`, otherwise `reject_once`;
  never `allow_always`.
- Continuity: `context.state` holds `{acpSessionId, cwd, instructionsHash}`. If the agent
  advertises `loadSession` and state matches, `session/load` (ignore replayed updates) and prompt
  only the newest user message; on failure, fall back to `session/new` + transcript (include
  `session.summary`). Deliver `context.instructions` at the start of a new ACP session and again
  only when its hash changes.
- MCP: pass `context.mcp` as an `http` MCP server in `session/new`/`session/load` when the agent
  advertises `mcpCapabilities.http`; otherwise emit a status and omit.
- Timeouts exclude time spent awaiting `context.requestPermission` and `context.host.*`.
- Tests: a fake trusted ACP agent fixture exercising fs/terminal/permission/load/mcp against a
  mock context (cross-platform; must also pass on Windows); strict path unchanged; opt-in real
  agent test (`YOUR_BOT_REAL_AGENT=grok|claude`) editing a file and running a command in a temp
  workspace with approvals answered by the test.

### P3 `feature/p3-workspace-host` — WorkspaceHost (packages/workspace)
Implements `WorkspaceHost` for Linux, macOS, Windows. Confinement via canonical parent + basename
(case-insensitive compare on win32/darwin), refusing symlink/junction escape at resolve AND at use
(re-resolve and compare immediately before open; posix `O_NOFOLLOW` on final component; writes go
to a temp file in the target directory then rename). Read limit 10 MiB, `line`/`limit` slicing.
Terminals: spawn without shell (PATHEXT/`.cmd` handling as in P2), env = minimal allowlist +
request env, ring-buffer output bounded by `outputByteLimit` (default 1 MiB) cut on UTF-8
boundaries, exit status, kill tree, `releaseTask`, `close`, max 16 live terminals per task.
Tests: escape attempts (`..`, absolute outside, symlink, junction on Windows, swap-after-resolve
race), limits, output truncation, tree kill (grandchild dies), Windows run over SSH.

### P5 `feature/p5-mcp` — MCP broker + browser preset (packages/mcp)
Implements `McpBroker` with `@modelcontextprotocol/sdk`: upstream stdio/http clients; proxy =
streamable HTTP server on `127.0.0.1` random port; 256-bit bearer token per session compared in
constant time; reject bad `Host` (DNS rebinding) and any `Origin`; tools only, namespaced
`<serverId>__<tool>`, builtins `your_bot__<name>`; `authorize` before every forwarded call
(builtins included); stdio children killed (tree) on close/abort. Export `expandPreset(config)`:
`preset:'browser'` → pinned `@playwright/mcp` (headless, isolated profile). Tests: fake upstream
servers (stdio + http), no-token/wrong-token/Host-rebinding rejection, deny path never reaches
upstream, abort cleanup, opt-in real browser test (`YOUR_BOT_BROWSER_TEST=1`) that opens a local
`file://` page and reads its title through the proxy.

### P6 `feature/p6-remote` — remote host transport + client (packages/remote)
Server `createRemoteHost({gateway: DesktopGatewayV2, ownerId, dataDir, listen, hostName})`
implementing `DeviceManager`: TLS-only WebSocket (self-signed cert persisted 0600; clients pin
its SHA-256 fingerprint), own SQLite device store. Pairing: single-use 128-bit secret, 10-minute
expiry, throttled; code `ybp1.<base64url JSON {v,urls,fp,secret}>`; device registers an Ed25519
public key. Auth per connection: server nonce, device signs `yourbot-auth-v1|hostId|fp|nonce`.
Principal `{id:'device:<id>', kind:'remote', ownerId, deviceId, capabilities}`; default
capabilities = every v2 capability except `settings`, `library.install`, `network`. Frames carry
v2 commands/results/events only after auth; 1 MiB frame cap, auth timeout, per-device connection
cap, rate limit. Revocation closes live sockets immediately and blocks reconnect.
Client: `RemoteTransport` (BackendTransport for v2), host directory (JSON 0600; device keys
encrypted with an optional `SecretCipher`), `MultiHostClient` listing several hosts and resuming
each via `state.sync {afterSequence}` with sequence dedupe and backoff. CLI `your-bot-remote`:
`pair <code>`, `hosts`, `approvals`, `approve <requestId> [--deny] [--scope once|task]`, `watch`.
Tests against a fake `DesktopGatewayV2`: no plaintext listener, unauthenticated socket gets
nothing, wrong pin refused, code replay/expiry refused, revoke kills socket and blocks
reconnect, two hosts listed, resume replays missed events once.

### P7 `feature/p7-skills-secrets` — skills + secret ciphers (packages/skills, packages/secrets)
Skills: `SkillCatalog` over a global folder and `<workspace>/.your-bot/skills/*/SKILL.md`;
YAML-frontmatter subset (`name`, `description`) without dependencies; id = folder name
`^[a-z0-9][a-z0-9_-]{0,63}$`; reject symlinked folders/files; SKILL.md ≤ 64 KiB; ≤ 200 skills;
per-skill `error` instead of throwing. Secrets: `AesGcmFileCipher` (AES-256-GCM, 32-byte key file
0600 in its own 0700 dir; format `v1.<iv>.<tag>.<ct>` base64url; tamper → throw) and
`SafeStorageCipher` wrapping an injected Electron-`safeStorage`-like object. Tests for both.

### Wave 2 (after wave 1 merges)
- **P4 core continuity + routines** (packages/core): memory table/commands + builtin MCP tool
  `remember`; instructions composition (bot instructions + memory + enabled skill bodies via
  injected `SkillCatalog`); compaction (policy, `adapter.summarize` or deterministic fallback,
  archive table, `session.compact`); routines with injectable clock, 5-field cron, interval, once,
  missed-run policy on startup, run records/events, `blocked` status with `approval.required`
  notification that waits indefinitely, `interrupted` + notification on restart, `Notifier`.
- **P8 runtime + headless host** (packages/runtime, apps/host): one composition factory for
  desktop and headless (gateway, executor, workspace host, MCP broker, adapters, skills, ciphers,
  remote host); `your-bot-host` CLI (`init`, `run`, `pair`, `devices`, `revoke`); desktop uses
  Electron `safeStorage`.
- **P9 desktop UI v2** (apps/desktop): bots, trusted toggle, standing-grant options in approvals,
  grants + audit, routines, memory, notifications, devices/pairing, MCP incl. browser preset,
  skills.
- **P10 demo + cross-OS**: scripted demo (trusted Grok Build bot edits a file and runs a command;
  routine fires unattended under a standing grant; second machine pairs and answers an approval);
  trusted tests on Linux, Windows and macOS.
