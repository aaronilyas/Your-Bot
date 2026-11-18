# Your Bot

A self-hosted, local-first agent host: persistent bots that do real work on machines you control. It runs as an Electron desktop app or as a headless host (`your-bot-host`), keeps conversations, settings and audit history in local SQLite, and needs no cloud backend. Bots run on a local model server, a contained ACP harness, or — opt-in per bot — an installed agent CLI such as Grok Build or Claude Code working in the bot's own workspace folder.

Every client (renderer, paired device, headless control channel) uses one versioned command/event contract. The host derives identity server-side and forwards commands to the same permission-enforcing gateway. The gateway is the only authority: every file, command, network and MCP action an agent requests is authorized there (standing grant or live approval) and then performed by a core-owned service.

```text
Desktop UI ─ preload/IPC ─┐
Paired device ─ TLS WSS ──┼─▶ Gateway (core) ─▶ AgentAdapter ─▶ contained ACP / local model / trusted agent CLI
Owner CLI ─ control sock ─┘        │  ▲                                   │ fs, terminal, permission, MCP
                                   │  └──────── authorization ◀───────────┘
                                   ▼
          SQLite (bots, grants, audit, routines, memory) · WorkspaceHost · MCP broker · Python sandbox
```

## Install and run

Development requires Node.js 22.13+ and npm. Secure execution currently requires Linux x86_64, a root-administered Python 3.10+ under `/usr`, its venv module, bubblewrap with sized tmpfs and FD binds (tested 0.11.1), and working user/PID/network namespaces. ACP containment additionally needs glibc, a C compiler and development headers. On Windows/macOS the strict profile fails closed (equivalent isolation is not implemented); trusted bots, the headless host and remote access work on Linux, macOS and Windows.

On a suitable Ubuntu system, install runtime dependencies using the system package manager:

```sh
sudo apt install python3 python3-venv bubblewrap gcc libc6-dev
npm ci
npm run build
npm start
```

`npm run dev` builds the backend and starts Electron with Vite renderer updates. Packaged applications include Electron; Node is needed separately only for Node ACP harnesses. The project is MIT licensed.

### Installers

Pushing a `v*` tag runs [.github/workflows/release.yml](.github/workflows/release.yml), which builds every installer on its native OS and attaches them to a draft GitHub release with `SHA256SUMS.txt`. It can also be started by hand (Actions → Build installers → Run workflow); the files are then attached to the run as artifacts.

| Platform | Files | Architectures |
| --- | --- | --- |
| Any Linux distro | `Your-Bot-<v>-linux-<arch>.AppImage` (needs FUSE 2), `.tar.gz` | x64, arm64 |
| Debian, Ubuntu, Mint, Pop!_OS | `.deb` | amd64, arm64 |
| Fedora, RHEL/Rocky/Alma 9+, openSUSE | `.rpm` | x86_64, aarch64 |
| Arch, Manjaro, EndeavourOS | `.pacman` (`sudo pacman -U <file>`) | x64, aarch64 |
| macOS 12+ | `.dmg`, `.zip` | Intel (x64), Apple Silicon (arm64) |
| Windows 10/11 | `Your-Bot-Setup-<v>.exe` (selects the architecture itself), per-arch setup `.exe`, portable `.zip` | x64, arm64 |

End users can download from **[ysybot.com](https://ysybot.com)**. That page is `site/`, deployed to GitHub Pages by [.github/workflows/pages.yml](.github/workflows/pages.yml). It redeploys whenever a release is published, and it lists that release's installers.

On Linux, one command picks the right package for the distro and also installs the strict-profile prerequisites (Python 3 + venv, bubblewrap, gcc):

```sh
curl -fsSL https://github.com/aaronilyas/Your-Bot/releases/latest/download/install.sh | sh
```

`YOUR_BOT_FORMAT=appimage` installs the AppImage into `~/.local/bin` without root; `YOUR_BOT_VERSION=v0.1.0` pins a release; `YOUR_BOT_NO_DEPS=1` skips the prerequisites. The deb and rpm list those prerequisites as *Recommends*. The pacman package does not list them, so the script installs them.

To build locally, run `npm run package:linux` (all Linux formats, x64 + arm64), `npm run package:mac` on macOS, or `npm run package:win` on Windows. Windows installers can also be cross-built from Linux in the `electronuserland/builder:wine` container. Building `.rpm` needs `rpmbuild`. Results go to `apps/desktop/release/`.

Builds are unsigned unless signing secrets are configured. With no certificate, macOS builds are ad-hoc signed. The first launch then needs right-click → Open, or `xattr -dr com.apple.quarantine "/Applications/Your Bot.app"`, and Windows SmartScreen shows "More info → Run anyway". On Windows 11 PCs with Smart App Control turned on, unsigned installers and apps are blocked outright with no override, so those users need a signed build. To sign, add the repository secrets `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (Developer ID signing + notarization) and `WIN_CERT_PFX_BASE64`, `WIN_CERT_PASSWORD`.

Chromium's renderer sandbox must work on the host. If AppArmor prevents development Electron from starting, use an administrator-installed package or configure the host's approved Chromium sandbox policy. The application never supplies `--no-sandbox` and does not change system policy. The disposable container workflow below permits native validation without changing the host.

## Connect LM Studio or llama.cpp

Start the local server and load a model, then open **Settings → Add provider**. Choose **LM Studio**, **llama.cpp**, or **OpenAI compatible**. Defaults are `http://127.0.0.1:1234/v1` for LM Studio and `http://127.0.0.1:8080/v1` for llama.cpp. Enter the API base and optional model ID, save, refresh models, and select the agent/model before creating a conversation.

Model discovery uses `GET /models`; chat uses streamed `POST /chat/completions` relative to that API base. Models must support OpenAI-style function calling to use skills. Optional API keys are entered in a password field, encrypted at rest, and never returned to the renderer. Blank preserves an existing key; the removal checkbox clears it. Explicitly configuring a remote endpoint sends prompts and tool results to that endpoint; loopback defaults keep inference local. Redirects and endpoint-embedded credentials are refused.

## Connect an ACP harness

In Settings, add an **ACP agent**, select the system Node or Python runtime, and enter one absolute `.mjs` or `.py` script path. The concrete Linux launcher accepts only `/usr/bin/node` or `/usr/bin/python3`, with exactly that script as its argument. Bundle application code into that file; user-local dependency directories and sibling scripts are not mounted. Node must be a supported root-owned dynamic system executable.

The adapter speaks ACP v1 JSON-RPC over stdin/stdout: initialization, session creation, prompting, streamed updates and cancellation. It starts a fresh contained session per turn and supplies the conversation transcript. Multiple configured providers create independent adapters. Harnesses cannot access home/projects, launch processes, open sockets, or obtain native terminal/filesystem permissions. Consequently harnesses requiring network/cloud access or their own filesystem tools are unavailable under this initial policy. There is no unrestricted fallback.

Harnesses can delegate tools through the documented `_your_bot/execute_tool` extension; the core asks the user and invokes the sandboxed executor. See [adapter integration and containment](packages/adapters/README.md). The self-contained fixture at [tests/fixtures/acp-agent.mjs](tests/fixtures/acp-agent.mjs) is a runnable protocol example: configure its absolute path as a Node ACP provider, send a message, approve the calculation, and receive 42. Third-party production harnesses remain unverified.

## Bots and execution profiles

A bot is a persistent entity: name, instructions, agent and model, workspace folder, execution profile, MCP servers, enabled skills, memory and compaction policy. Sessions belong to a bot. Two profiles exist:

- **strict** (default): exactly the contained behaviour above — no network, process spawn or filesystem for the agent; tools go through the Python sandbox. Fail-closed.
- **trusted** (opt-in, local owner only): the installed agent CLI runs **uncontained, with your user rights and network**, in the bot's workspace. Configure the provider with launch mode *host* (e.g. command `grok`, args `agent stdio`; or `npx -y @agentclientprotocol/claude-agent-acp`). The adapter advertises ACP `fs` and `terminal` capabilities; every `fs/read_text_file`, `fs/write_text_file`, `terminal/*` request and every agent `session/request_permission` is authorized by the gateway and performed by the core's workspace host, confined to the workspace. What the agent process does internally without asking is not mediated — choose trusted only for agents you trust. Works on Linux, macOS and Windows.

Paired devices can start runs and answer approvals but cannot mark a bot trusted, change its workspace, agent or MCP servers, edit provider settings or manage devices.

## Standing permissions and audit

Approvals can be once, task, or **standing**: revocable grants scoped to bot + capability + folder (file read/write/delete), argv prefix (commands), MCP server/tool, or agent tool kind. Unattended work matching a grant proceeds without prompting; everything else still asks. Custom Python, library installs, network and settings can never be granted standing. Folder matching is canonical and segment-based; a shell command line matches a command grant only if it contains no shell syntax. Every decision — standing, interactive or policy — is written to the audit log (Permissions → Audit, or `audit.list`). Note that a command-prefix grant such as `git` covers every git subcommand, and an agent-tool-kind grant such as `execute` lets that agent's own shell tool run any command.

## Memory, continuity and routines

Trusted agents that support ACP `session/load` resume their own session; others receive the transcript plus a compaction summary, kept in an opaque per-session adapter state store. Bots can keep memory (owner notes plus `remember`/`recall` MCP tools for the agent); instructions, memory and enabled skills are composed into the agent's instructions. Sessions over a bot's compaction policy are summarized and older messages archived, never deleted.

Routines schedule a bot prompt by interval, 5-field cron with time zone, or once, with a missed-run policy (skip, run once, run all up to a cap) applied after downtime or sleep. A run blocked on an approval notifies the owner (desktop notification, paired devices) and **waits indefinitely**; it never proceeds or fails silently. Runs interrupted by a restart are marked `interrupted` and notified.

## MCP and browser automation

Each bot can list MCP servers (stdio or HTTP). The core starts them and gives the agent a single authenticated loopback proxy (random bearer token, loopback only, DNS-rebinding and Origin checks); each tool call is authorized like any other capability. **Add browser automation** adds the pinned Playwright MCP server (headless, isolated profile). MCP is available to trusted bots whose agent supports HTTP MCP.

## User skills

Skills are folders containing a `SKILL.md` with `name`/`description` frontmatter, loaded from the host's skills folder and from `<workspace>/.your-bot/skills`. Enabled skills are added to the bot's instructions. Symlinked or oversized skills are rejected and listed with an error.

## Remote access and the headless host

`your-bot-host init --data <dir>` then `your-bot-host run --data <dir> --listen 0.0.0.0:7443` runs the gateway without Electron. The remote listener is TLS 1.3 WebSocket only, with a self-signed certificate that clients pin by fingerprint. `your-bot-host pair` prints a single-use pairing code (10 minutes); on another machine `your-bot-remote pair <code>` registers an Ed25519 device key. Then `your-bot-remote hosts | approvals | approve <id> | watch` work across several hosts, resuming with `state.sync`. `your-bot-host devices` / `revoke <id>` manage devices; revocation closes live connections. The owner controls a running host through `your-bot-host ctl/bot/grant/routine/approvals/approve/watch` over a local socket (named pipe on Windows) that requires the data directory's control token. See [apps/host](apps/host/README.md) and [packages/remote](packages/remote/README.md).

API keys and MCP secrets are encrypted at rest: Electron `safeStorage` on desktop, an AES-256-GCM key file (separate from the database directory) on headless hosts.

## Python skills and approvals

Included skills cover arithmetic/statistics, tabular data analysis, JSON/CSV parsing and exact-file read/write/delete. Local models receive the `execute_tool` schema and skill input descriptions. Every tool request passes through the core and an approval dialog; Python requests show the complete code and its hash. Approvals are bound to owner, task, operation and exact paths/packages, with once/task scopes (standing grants apply only to bot file/command/MCP/agent-tool requests, never to custom Python). A writable file binding additionally requires explicit read approval. Use `files[hostPath]` inside approved Python to access a declared file, and assign the result to `result`.

Python runs in an application-managed venv, a private worker process, bubblewrap namespaces, read-only runtime mounts and an irreversible seccomp filter. Network and subprocess access are denied even through Python libraries/native code. Time, address space, file size, scratch space and output are bounded. Missing/failed isolation returns a structured error before untrusted code executes.

Library installation is a separately approved `library.install` tool action, scoped only to the managed environment. It supports explicit PyPI universal pure-Python wheels, optionally pinned with `==`; dependencies require explicit listing. Downloads use a restricted HTTPS broker and verified registry hashes; offline pip runs inside the sandbox. Source builds, native wheels, arbitrary indexes and global installs are refused. Approved packages remain supply-chain inputs, and approved file writes are not transactional. See [executor APIs, skills and limits](packages/executor/README.md) and [security policy](docs/security.md).

## Validate

```sh
npm run build
npm run typecheck
npm test
npm run test:integration
npm run test:security
npm run test:linux      # full suite inside a disposable Ubuntu 26.04 container
npm run package
npm run test:desktop
npm run demo            # real Grok Build trusted bot, unattended routine, second-machine approval
```

The strict ACP launcher supports the Debian/Ubuntu multiarch library layout; on other distributions (e.g. Arch) its tests fail closed with `CONTAINMENT_UNAVAILABLE`, which is why `test:linux` exists. Opt-in tests: `YOUR_BOT_REAL_AGENT=grok|claude` (real agent CLIs) and `YOUR_BOT_BROWSER_TEST=1` (real browser through MCP).

Sandbox tests execute real Python/bubblewrap and fail when the required boundary is unavailable; they do not silently skip or use unrestricted workers. The native desktop test needs Docker, downloads an Ubuntu test image, and runs the actual packaged renderer, preload and backend under Xvfb with a mock model server. It enables nested namespace creation in a disposable container, runs the application as a non-root user, and keeps Chromium and Python isolation enabled. It has no host mounts, credentials or runtime network access. Browser-only demo mode (`npm run dev:browser -w @your-bot/desktop`, then `http://127.0.0.1:5173/?demo=1`) remains available separately.

See [executed validation and limitations](docs/validation.md), [engineering report and branch reviews](docs/engineering-report.md), and [development workflow](docs/development.md).

## Architecture

`packages/contracts` owns the wire contracts: v1 (frozen) and v2 (additive: bots, grants, routines, memory, devices, skills). `core` owns SQLite, sessions, bots, the single authorization pipeline, standing grants and audit, routines, memory, compaction and notifications. `adapters` owns ACP (contained and trusted) and local HTTP models; `workspace` performs confined file/terminal operations; `mcp` owns the MCP broker and proxy; `executor` owns Python skills and OS isolation; `remote` owns the TLS WebSocket host, pairing and multi-host client; `skills` and `secrets` load user skills and encrypt secrets; `runtime` composes all of it for both `apps/desktop` and `apps/host`. See [architecture](docs/architecture.md), [security](docs/security.md) and [progress](docs/PROGRESS.md).
