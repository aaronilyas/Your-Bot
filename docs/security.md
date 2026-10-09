# Security policy

Local-first does not imply unrestricted execution. All model and tool operations flow through the gateway. Deny user file access by default; permission grants are bound to principal, task, operation and exact canonical paths. No broad persistent grants are exposed. Library installs require explicit package approval and never use global pip.

The supported Python security boundary is Linux bubblewrap plus seccomp, not a venv, AST filter or prompt. Unsupported systems or denied namespaces fail closed. Tests must distinguish genuine sandbox success from environment skips. ACP launch must fail closed unless process containment is available; unsupported tools and terminal/filesystem RPCs must be refused.

Electron uses a narrowly scoped preload, context isolation, renderer sandbox and no renderer Node integration. Main validates IPC sender and commands, binds identity itself and does not expose credentials in snapshots. No unauthenticated network listener is implemented.
