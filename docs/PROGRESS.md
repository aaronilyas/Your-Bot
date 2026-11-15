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

## In flight
Wave 1: P0 linux container runner, P1 core v2, P2 trusted ACP, P3 workspace host, P5 MCP
(relaunched after an OOM SIGKILL; keep ≤5 concurrent delegates on this 4-core/15 GB host),
P6 remote.

## Next
Wave 2: P4 continuity+routines, P8 runtime+headless host, P9 desktop UI. Wave 3: P10 demo and
cross-OS validation, docs, PR.

## Open decisions / owner actions
- `macmini` is locked (SSH refused until unlocked locally). macOS trusted-profile validation
  needs the owner to unlock it.
- `ubuntu` SSH alias is Arch (Omarchy), not Ubuntu; strict/security suites run in an Ubuntu
  26.04 container instead (decision taken by lead; matches the previously validated env).
