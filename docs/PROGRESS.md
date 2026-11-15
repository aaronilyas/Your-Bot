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

- P2 trusted ACP merged (89 adapter tests; Windows 86/86 non-Linux; real Grok Build edited a
  file and ran a command through core-mediated fs/terminal). Lead cross-package fix: Grok sends
  terminal/create as one shell line with no args, so WorkspaceHost runs args-less lines with
  whitespace/shell syntax via `/bin/sh -c` / `cmd.exe /d /s /c`, and such lines match a standing
  commandPrefix grant only when they contain no shell syntax (tests in core + workspace).
  Limitation: Grok reports models via `session/new.models`, not configOptions, so trusted Grok
  bots must leave modelId unset until P8 adds that path.

- P9 desktop UI v2 merged (72 desktop tests): v2 IPC (strict schemas, main-owned principal now
  with mcp.call, one extra preload API `chooseDirectory`), bots/trusted warning, approvals with
  "Always allow…", permissions+audit, routines, notifications, devices/pairing, provider launch
  mode. Not yet seen in a real browser/Electron window (CSS unverified) — run test:desktop and a
  visual check at the end. Open: the UI sends the browser preset as {preset:'browser', command:'npx'};
  P5's broker only expands presets with an empty command, so the runtime (P8 merge) must wrap the
  broker to always `expandPreset` configs that carry `preset`. Core should bound notification text.

- P4 continuity+routines merged (fcd8ebc; core 85 tests). GatewayOptions: skillCatalog, notifier,
  clock, routineCapabilities, summarizeTimeoutMs. Blocked runs wait indefinitely; after a restart
  they become `interrupted` (not resumed). Timer >60 s late = missed. Whole repo after merge:
  443 pass, only the 10 Arch-environmental strict failures. Lead fixed tests/integration.test.ts
  to drive the v2 renderer store through createGatewayV2.

- `npm run test:linux` fully green at 305a068 (Ubuntu 26.04, --network none): build, typecheck,
  vitest 453 pass / 2 opt-in skips, security 198, integration 5 (incl. real contained ACP). Runner
  now uses `--init` (zombie reaping for process-tree tests) and installs iproute2/procps.

- P8 runtime + headless host merged (3574512): packages/runtime (one composition for desktop and
  headless; McpBroker wrapper always expands presets), desktop backend on createGatewayV2 with
  safeStorage, apps/host `your-bot-host` (init/run/ctl/pair/devices/revoke/bot/grant/routine/
  approvals/approve/watch) with a 0600 unix socket (Windows named pipe) + constant-time token
  first frame. tests/v2-runtime.test.ts: trusted workspace edit+command, unattended routine under
  standing grants (enabled after P4), remote pair+approve, control-token rejection, opt-in real
  Grok (passed). `npm run test:linux` at 3574512: all steps green, vitest 463 pass / 3 opt-in skips,
  security 198, integration 5.

## In flight
- P10 demo + cross-OS (see Next).

## Next
2. Full validation: `npm run build`, `npm run typecheck`, `npx vitest run` (expect only the 10
   Arch-environmental strict failures), `npm run test:linux` (must be fully green), `npm run
   package` + `npm run test:desktop` (desktop smoke; preload now has chooseDirectory), visual
   check of the v2 UI (CSS never seen rendered).
3. P10: scripted demo (`scripts/demo.mjs` or similar): headless host on this machine with a
   trusted Grok Build bot editing a file and running a command; a routine firing unattended under
   standing grants; the `ubuntu` host (has Node 26 + grok) pairing via `your-bot-remote pair` and
   answering an approval. Cross-OS trusted tests: Windows via portable Node in %TEMP% (clone via
   https; no GitHub SSH key there) with claude-agent-acp; macOS once `macmini` is unlocked.
4. Docs: README, architecture, security (trusted-profile threat model, standing-grant caveats,
   control channel, remote protocol), validation; then one PR integration → main.

## Open decisions / owner actions
- Claude account hit its 5-hour limit during wave 2 (resets 9:10pm ET); Antigravity quota exhausted
  (~6 days). Only Grok remains; both continuations (P4, P8) run there.
- `macmini` is locked (SSH refused until unlocked locally). macOS trusted-profile validation
  needs the owner to unlock it.
- `ubuntu` SSH alias is Arch (Omarchy), not Ubuntu; strict/security suites run in an Ubuntu
  26.04 container instead (decision taken by lead; matches the previously validated env).
