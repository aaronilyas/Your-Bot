# Executed validation

## v2 (Grok Bot parity), November 15, 2026

Hosts: workstation `omarchy` (Arch-based Omarchy, x86_64, Node 26.12, bubblewrap 0.13.1, Grok Build 1.0.77); `ubuntu` SSH host (also Arch-based, x86_64, Node 26); `windows` (Windows 11 x64, portable Node 22.23.5 in %TEMP%); Ubuntu 26.04 container (Node 22.23.5) for strict/security suites. `macmini` (macOS) was locked and unreachable: **macOS is not validated**.

| Check | Outcome |
| --- | --- |
| `npm run build`, `npm run typecheck` | Pass (all 12 workspaces incl. runtime and `apps/host`) |
| `npm run test:linux` (Ubuntu 26.04, `--network none`) at 370e1a7 | All steps pass: vitest **466 passed** / 3 opt-in skips; `test:security` **201 passed**; `test:integration` **5 passed** (incl. real contained ACP) |
| `npx vitest run` on the Arch workstation | All pass except the 10 strict bubblewrap/contained-ACP tests, which fail closed with `CONTAINMENT_UNAVAILABLE` because the strict launcher supports only the Debian/Ubuntu multiarch layout (unchanged v1 behaviour) |
| Windows: workspace, adapters, mcp, remote, runtime, core, secrets, skills, `tests/v2-runtime.test.ts` at 85a7d7a | **339 passed**, 15 skipped (12 Linux-only bubblewrap, 3 opt-in) |
| `npm run package` + `npm run test:desktop` | Pass: packaged entrypoint window, v2 renderer/preload/IPC, approval dialog, real Python 42, cancellation, shutdown cleanup, restart restore |
| `YOUR_BOT_REAL_AGENT=grok` adapter and runtime tests | Pass: real Grok Build edits a file and runs a command through core-mediated `fs/*`/`terminal/*` |
| `YOUR_BOT_BROWSER_TEST=1` | Pass: Playwright MCP through the authenticated proxy reads a local page title |
| `npm run demo` | **Pass** (below) |

### Scripted demo (`npm run demo`)

One unattended run against the real Grok Build CLI and a second machine:

1. `your-bot-host init` + `run --listen` (TLS WSS, pinned fingerprint).
2. Via the token-authenticated control channel: host-launched Grok provider; trusted bot with a temp workspace.
3. Interactive: Grok writes `demo.txt` and runs `cat demo.txt`; `file.read`, `file.write`, `process.spawn` approved interactively and audited.
4. Standing grants (workspace read/write; exact `pwd` command forms) and a routine a few seconds ahead: the routine completed with **zero permission requests**; audit `file.read/standing, file.write/standing, process.spawn/standing`.
5. `ubuntu` clones the branch into `/tmp`, `your-bot-remote pair <code>`, finds the pending approval for a command outside the grants and approves it; audit `decidedBy device:<id>`. After `your-bot-host revoke`, the device's approvals call is rejected.
6. Teardown on both machines.

Fixes found by end-to-end runs (all with tests): ESM main bundle missing `require` for bundled `ws` (packaged app could not start); 10-minute default agent turn budget (`your-bot-host run --agent-timeout`); Grok's login-shell command lines with presentation-only env could never match standing grants (inert-env allowlist shared via contracts; POSIX single quotes; never on Windows); Windows could not open a file-backed gateway (POSIX mode check) and lacked `O_NOFOLLOW` (explicit symlink refusal).

### Unverified / limits

macOS (locked host); real Claude Code / Codex / Gemini CLI agents (only Grok Build was exercised; Claude usage was exhausted during the run); real LM Studio/llama.cpp (as in v1). Ubuntu's patched pip wheel cannot run in the offline strict sandbox (`/etc/ssl/certs` absent), so `test:linux` installs upstream pip 25.3. See [security](security.md) for trusted-profile and standing-grant caveats.

## v1 baseline, October 9, 2026

Validation was run on October 9, 2026. Host: Linux x86_64, Node 22.22.1, Python 3.14, bubblewrap 0.11.1. Native desktop: Electron 44.7.0 in a disposable Ubuntu 26.04/Xvfb container, non-root application user, Chromium sandbox enabled, real Python and bubblewrap/seccomp workers. The container has no host mounts or runtime network access; its mock model listens only inside the container.

### Commands and outcomes

| Check | Executed outcome |
| --- | --- |
| `npm ci` | Clean locked installation and Electron binary setup passed |
| `npm run build` | All five packages and production desktop bundles passed |
| `npm run typecheck` | Strict package and integration-test TypeScript checks passed |
| `npm test` | 13 test files, **160 tests passed**, zero skips |
| `npm run test:integration` | **5 passed** using real SQLite, contained ACP fixture, mock HTTP server and real Python |
| `npm run test:security` | **47 passed**: 35 executor plus 12 real ACP isolation tests, zero skips |
| `npm run package` | Linux x64 unpacked application, AppImage and amd64 deb generated successfully |
| `npm run test:desktop` | Native packaged renderer/preload/IPC/backend, approval UI, real calculation, running-worker cancellation, active-worker quit cleanup and persisted restart passed |
| `npm audit --omit=dev` | Zero production advisories |
| Full dependency audit | Seven moderate findings in optional development packaging dependency paths; no nonbreaking fix reported |
| `git diff --check` | Passed |

The native test asserts context isolation, renderer sandbox, absence of renderer Node integration, a bridge with only dispatch/subscribe, rejection of forged principal fields, credential exclusion from state, streamed events, a Python tool value of 42, and managed subprocess termination. It uses the real production backend factory and packaged assets. The container launcher enables nested namespaces and unmasked container system paths, and installs the root-owned setuid Chromium helper **inside the disposable image only**; it never passes `--no-sandbox` or modifies host policy.

Initial direct-host Electron startup attempts failed because AppArmor blocked Chromium's user namespace fallback and its development helper was not setuid/root-owned. T3 browser preview also reported that explicit host sandbox blocker. An initial Ubuntu 24.04 container attempt failed closed when its bubblewrap could not initialize the private proc/network mounts. The final supported test image and nested-namespace configuration passed. These failures are not recorded as successful application execution.

### Required scenarios

| # | Scenario | Evidence / status |
| --- | --- | --- |
| 1 | Desktop starts | Normal packaged entrypoint displays its window; native driver also shows the production renderer with a connected real backend; narrow preload and web preferences asserted |
| 2 | Create and reopen conversations | Native UI creation, core lifecycle tests and actual SQLite close/reopen |
| 3 | UI messages pass through gateway | Native textarea/send button → preload/IPC → real core → mock model; persisted messages verified |
| 4 | ACP initialize/respond | Real contained stdio fixture, ACP v1 initialization/session/prompt/update, gateway tool extension and approved Python; protocol/malicious-harness tests |
| 5 | Local model streaming | Fragmented mock SSE and tool-call tests, headless integration and native desktop streaming assertions |
| 6 | Real LM Studio/llama.cpp connection | **Unverified:** neither default loopback endpoint was available; no real model/GPU compatibility claim |
| 7 | Approved Python calculation | Real sandbox result 42 verified in headless gateway and native approval dialog flow |
| 8 | Unauthorized file modification blocked | Real worker host/read-only write attempts denied; sentinel unchanged; subprocess/socket/alternate ABI denial tests |
| 9 | Exact approved file operation works | Real exact-file write with separate read approval; new file and multiple-file scoped Python integration |
| 10 | UI approval appears | Native approval dialog capability/code checks and actual Allow once clicks; React modal tests |
| 11 | Cancellation stops execution | Real running Python worker cancellation, following task succeeds; native task.cancel; contained ACP cancellation tests |
| 12 | Restart restores history | Native second Electron process restores the SQLite conversation; headless close/reopen test |
| 13 | Close cleans subprocesses | Native quit with a live Python loop asserts tracked children terminated; executor/ACP close cleanup tests |
| 14 | Gateway without Electron | Five integration tests use principal-bound in-process command/event transport |

### Security coverage and external limitations

Executor tests exercise unauthorized user-file/runtime writes, hidden home secrets, exact grants, code mutation/hash mismatches, syscall and x32 denial, symlink replacement after pinning, writable hardlink refusal, scratch cleanup, cancellation, output/time/memory/file limits, ignored package initialization hooks and offline wheel installation/import. The fixture wheel is generated locally. On systems without bundled pip, the separately approved installer bootstrap test accesses only the two allowed PyPI HTTPS endpoints. No global Python packages were installed.

ACP tests include 12 real Linux containment cases covering allowed stdio streaming/tool extensions, refused native permissions, process/network denial, hidden home secrets, unchanged host sentinels, read-only runtime, bounds and cancellation/cleanup. Other protocol tests use mock harnesses and endpoints. A third-party production harness was not available; the constrained launcher does not claim compatibility with network-dependent or user-local dependency-based harnesses.

Windows/macOS secure execution and packaging were not validated or implemented. Approved file writes can be partial; virtual address-space limits are not RSS/cgroup limits. Credential storage is local and private but unencrypted. No production remote server is present. See [security details](security.md).
