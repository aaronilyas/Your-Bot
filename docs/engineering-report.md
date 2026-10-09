# Engineering report

Four implementation areas ran concurrently in independent worktrees from frozen-contract foundation `b133e1d`. Each committed only its owned directory. The lead reviewed the source and tests, merged contributions into `integration/desktop-agent`, and owns cross-package fixes, validation and delivery to main. The original MIT license and unrelated work were preserved; child worktrees and their uncommitted local lockfile changes remain available.

## Contributions

| Branch | Reviewed commit | Delivered features | Package tests |
| --- | --- | --- | --- |
| `feature/desktop-ui` | `c5e368948d68f15848a06ab922956d6ac53dce2b` | Electron/React/Vite chat, sessions, streaming, activity, approvals, provider settings, narrow IPC, mock transport, packaging | 21 |
| `feature/core-gateway` | `0a428770047efc6eace77917c7b59513fcf4f20c` | SQLite lifecycle/history, dispatcher, owner isolation, scoped approvals, deduplication/replay, streaming/cancellation, credential scrubbing | 25 |
| `feature/model-adapters` | `b1c2e65c1ac4a44e33e6dc40fbac81e4b803dada`, correction `2de516b72a7406f63c36a05fd3ad58f10db0d4f0` | ACP v1 stdio client, local OpenAI-compatible streaming/discovery/tools, enforced Linux harness launcher, protocol and malicious-harness tests | 74 |
| `feature/python-executor` | `db1fc09a2e66332082c3c88ccd11baefc84f614f` | System Python detection, managed venv, bubblewrap/seccomp workers, skills, precise file broker/grants, approved offline wheel installation, limits/cancellation | 35 |

The orchestrator's five cross-package tests plus these package tests total **160**, with no skipped tests in the executed full run. Contracts stayed at version 1 without incompatible changes.

## Review and integration

The lead reviewed every branch for contract consistency, privilege boundaries, command validation, credentials, containment, path races, cancellation, process cleanup, dependencies and unsupported-platform claims. The initial ACP contribution correctly refused unsafe launch, but lacked a concrete enforceable launcher; a second delegated round implemented it and 12 real OS containment tests before integration. The final branch was independently built, typechecked and tested by the lead.

Cross-package fixes aligned Python code/hash approval reasons and individual file grants, handled an explicitly approved read of a not-yet-created write target, prevented reuse of a task grant for different Python code, stripped undefined optional fields before IPC dispatch, preserved structured adapter errors, bounded assistant output and model discovery, supplied complete skill schemas, and replaced the desktop's disconnected factory with actual gateway/adapters/executor composition. Settings now configure supported ACP scripts and preserve/remove local credentials safely. Conversation titles derive from the first user message.

Native review exercised the packaged application under Xvfb. The development host's AppArmor policy blocks Chromium startup, so a disposable Docker test preserves application sandboxing while permitting nested namespaces. Docker's default masked proc and Ubuntu 24.04 bubblewrap failed the nested probe; the final test image uses Ubuntu 26.04 with suitable bubblewrap and unmasked container system paths. No application sandbox rule or host policy was weakened. See [validation evidence](validation.md).

## Result and limits

The actual runtime is `Electron UI → BackendTransport / validated IPC → DesktopGateway → ACP/local adapter → core approvals → ToolExecutor → isolated Python`, with SQLite local persistence. It runs headlessly through the same gateway and is ready for an authenticated future transport. No remote server is implemented. See [architecture](architecture.md), [security](security.md), and the [installation/provider guide](../README.md).

Build, strict typecheck, all 160 tests, explicit integration/security suites, Linux AppImage/deb packaging and native integrated desktop checks passed. Real LM Studio/llama.cpp servers were unavailable, so physical model/GPU compatibility remains unverified. A real contained fixture speaks ACP and uses Python; third-party production harnesses remain unverified. Execution is supported only on Linux x86_64; ACP launch is limited to offline single-script system Node/Python harnesses. Other platforms fail closed. Credentials are local but unencrypted at rest, and approved writes are not transactional.

Production dependency audit reported zero advisories. The full development audit reported seven moderate dependency-path findings from the packaging tool's optional `sprintf-js` chain, with no nonbreaking fix reported. No force downgrade or suppression was applied. History retention, cgroup RSS limits, native/source Python packages, network mediation for ACP harnesses, and platform-equivalent sandboxes remain future work.

All reviewed feature heads are retained as branches. The final response records the main merge commit and remote verification result; `git log --first-parent main` identifies the integration and delivery commits. Delivery uses a normal non-force push after checking the configured origin and newer remote commits.
