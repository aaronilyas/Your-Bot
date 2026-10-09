# Executed validation

Validation was run on October 9, 2026. Host: Linux x86_64, Node 22.22.1, Python 3.14, bubblewrap 0.11.1. Native desktop: Electron 44.7.0 in a disposable Ubuntu 26.04/Xvfb container, non-root application user, Chromium sandbox enabled, real Python and bubblewrap/seccomp workers. The container has no host mounts or runtime network access; its mock model listens only inside the container.

## Commands and outcomes

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

## Required scenarios

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

## Security coverage and external limitations

Executor tests exercise unauthorized user-file/runtime writes, hidden home secrets, exact grants, code mutation/hash mismatches, syscall and x32 denial, symlink replacement after pinning, writable hardlink refusal, scratch cleanup, cancellation, output/time/memory/file limits, ignored package initialization hooks and offline wheel installation/import. The fixture wheel is generated locally. On systems without bundled pip, the separately approved installer bootstrap test accesses only the two allowed PyPI HTTPS endpoints. No global Python packages were installed.

ACP tests include 12 real Linux containment cases covering allowed stdio streaming/tool extensions, refused native permissions, process/network denial, hidden home secrets, unchanged host sentinels, read-only runtime, bounds and cancellation/cleanup. Other protocol tests use mock harnesses and endpoints. A third-party production harness was not available; the constrained launcher does not claim compatibility with network-dependent or user-local dependency-based harnesses.

Windows/macOS secure execution and packaging were not validated or implemented. Approved file writes can be partial; virtual address-space limits are not RSS/cgroup limits. Credential storage is local and private but unencrypted. No production remote server is present. See [security details](security.md).
