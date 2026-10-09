# Development and validation

Use Node.js 22.13 or newer and npm. Install dependencies with `npm ci`. Build the shared contracts before individual packages. `npm run build` builds packages in dependency order; `npm run typecheck` and `npm test` validate the workspace.

The desktop integration workflow runs a native Electron test entry against the packaged application's actual main bundle and renderer under Xvfb. It exercises preload, IPC, gateway, permission dialogs, real Python, shutdown and restart. `npm run test:desktop` builds a disposable Docker test image from `package:dir` output for hosts whose AppArmor policy blocks development Electron. The test container contains no host file mounts or credentials. Its Chromium sandbox and Python bubblewrap/seccomp boundaries remain enabled. Browser-only Vite demonstrations use the mock transport and are not evidence of backend integration.

Executor integration tests use real Python and bubblewrap. Their results must explicitly distinguish unsupported sandbox hosts from successful sandbox execution. Install Python's venv component and bubblewrap on Linux. No test may fall back to running model-generated Python outside the sandbox.

Feature development occurs in four independent Git worktrees from foundational commit `b133e1d`: `feature/desktop-ui`, `feature/core-gateway`, `feature/model-adapters`, and `feature/python-executor`. The integration branch owns cross-package composition, tests and documentation. Only the lead integrates or pushes main.
