# Progress: Grok Bot parity (v2)

Resume from this file alone. Plan and package specs: [docs/v2/PLAN.md](v2/PLAN.md). Contract:
`packages/contracts/src/v2.ts`. Integration branch: `integration/grok-bot-parity` (one PR to
`main` at the end; no force pushes).

## Done
- v2 contract written (additive; v1 untouched), package skeletons (workspace, mcp, remote,
  skills, secrets, runtime) wired into root build order and vitest aliases.
- Baseline on `main`: build and typecheck green; 149/160 tests pass on this Arch host. The 11
  failures are strict ACP bubblewrap tests that assume the Debian multiarch library layout
  (environmental, see PLAN "Environment notes").

- P7 skills catalog + secret ciphers merged (a383c5e; 31 tests). Follow-up: AesGcmFileCipher does
  not verify permissions of a pre-existing key directory (low; same-user threat out of scope).

- P5 MCP broker merged (32 tests + opt-in real Playwright browser test passing locally).
  Core must call `expandPreset` and set `cwd` for the browser server (Playwright writes
  `<cwd>/.playwright-mcp`). Windows `.cmd` path only unit-tested.

- P0 Ubuntu 26.04 container runner merged: `npm run test:linux` (git archive HEAD → image; tests
  under --network none). Container run: build/typecheck/security 47/47/integration 5/5 green;
  full vitest 160/160 after fixing a flaky desktop UI waitFor. Image installs Node at /usr/bin/node
  and upstream pip 25.3 (Ubuntu's patched pip wheel reads /etc/ssl/certs, absent in the offline
  sandbox — a product limitation to note in docs, not fixed).

- P6 remote merged (26 tests): TLS 1.3 WSS `yourbot-remote/1`, cert pinning, Ed25519 device
  auth, single-use pairing codes, revocation, MultiHostClient, `your-bot-remote` CLI. Contract
  `BackendTransportV2` added. P1 integration must return `INVALID_CURSOR` for a future
  `afterSequence`. Limits: host-wide pairing throttle can be griefed; no cert rotation.

- P3 WorkspaceHost merged (65 tests Linux, 64 Windows 11). Linux closes swap races via
  /proc/self/fd; macOS/Windows detect-not-prevent; Windows orphans after leader exit survive
  taskkill /T; hardlinks inside the root can be read. All documented in packages/workspace.

- P1 core v2 merged (51 core tests; whole repo 330 pass, only the 10 environmental strict
  failures). `createGateway` stays v1-only; `createGatewayV2` serves v1+v2 (desktop must switch
  in P8). Lead applied contract requests: command `env`, `BotPatch` with null clearing (core
  implemented), withheld resolutions, error-code list. Open items handed to P4: INVALID_CURSOR,
  missing-file read returns UNSAFE_PATH instead of NOT_FOUND, null-clear test. Owner should know:
  a standing `tool.execute` grant by `agentToolKind` (e.g. 'execute') lets a trusted agent's own
  shell tool run any command without folder scoping; command-prefix grants match literally.

## In flight
Wave 1: P1 core v2, P2 trusted ACP. Keep ≤5 concurrent delegates on this
4-core/15 GB host (OOM SIGKILLs hit P5, P6 and a lead npm ci; commit WIP and resume).

## Next
Wave 2: P4 continuity+routines, P8 runtime+headless host, P9 desktop UI. Wave 3: P10 demo and
cross-OS validation, docs, PR.

## Open decisions / owner actions
- `macmini` is locked (SSH refused until unlocked locally). macOS trusted-profile validation
  needs the owner to unlock it.
- `ubuntu` SSH alias is Arch (Omarchy), not Ubuntu; strict/security suites run in an Ubuntu
  26.04 container instead (decision taken by lead; matches the previously validated env).
