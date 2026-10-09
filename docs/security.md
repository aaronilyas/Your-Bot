# Security policy and supported boundary

The renderer, model and harness do not grant authority. Electron main binds the local principal; a future remote host must authenticate and derive its own principal. Core validates commands, ownership and capabilities, then creates live permission requests. Decisions identify the original request only and cannot broaden its paths, packages or identity. Grants expire with the task; once grants cannot be reused by concurrent execution. Custom Python grants include the full immutable code and its SHA-256. Read/write/delete grants target individual canonical files, with no directory grants. Writable mounts require separate read permission.

## Python

The initial supported platform is Linux x86_64. Bubblewrap isolates mount, user, PID, network, IPC and UTS namespaces, clears the environment and drops capabilities. System runtime and the managed environment are read-only during execution; scratch is private and bounded. Home, projects and application SQLite storage are absent. Exact approved files use pinned descriptors; write bindings reject hardlinks and symlinks. File creation uses exclusive open through a pinned parent. The predefined delete broker removes one approved directory entry through a pinned parent after successful sandbox verification; arbitrary Python cannot traverse a writable parent directory.

The trusted `-I -S` Python bootstrap sets hard resource limits and an irreversible x86_64 seccomp allowlist before importing managed packages or executing user code. Process/thread creation, exec, sockets, namespace changes, ptrace and unknown syscalls are denied. No virtual environment, AST filtering or prompt rule substitutes for this boundary. Unsupported architectures/platforms, denied namespaces or missing enforcement fail closed. The implementation was exercised with Python 3.14 and bubblewrap 0.11.1; other system layouts can fail closed.

Defaults are 10 seconds wall time (maximum request 30), 256 MiB virtual address space, 32 MiB scratch, 16 MiB file size and 1 MiB output. These are address-space/process limits, not a cgroup RSS guarantee. Cancellation kills the worker process group; parent death triggers bubblewrap cleanup. Approved writes can be partial and are not rolled back on failure/cancellation. Trusted app-owned setup creates the venv outside the worker; no untrusted code runs during that setup.

Installation has separate package approval, a restricted PyPI HTTPS download broker, bounded downloads and hash validation. Only universal wheels are accepted. Pip runs offline under the same kernel filter with the application venv writable; no user data is mounted and no global pip is used. A missing bundled installer requires a separate pinned pip approval. Dependencies, compiled wheels and source builds are not silently installed. Registry hashes do not establish publisher trust. An approved package can alter the managed environment, return false results or misuse data that the user explicitly grants during a later invocation.

## ACP

ACP capability negotiation alone is not containment. Default ACP execution is unavailable without an enforceable launcher. The desktop supplies the Linux bubblewrap/compiled seccomp launcher only for a supported single-script system Node/Python provider. Script bytes and runtime descriptors are pinned, runtime trees are read-only, and the private filesystem omits home, user projects, credentials and host environment. Network, process spawn and native ACP terminal/filesystem grants are denied. The trusted bootstrap installs the kernel filter before untrusted harness code and verifies startup on a private pipe.

Node threading is permitted only with thread-specific clone flags; fork/exec/network remain denied. Default harness limits are 120 seconds wall time, 30 seconds CPU, 8 GiB virtual address space, 256 MiB V8 old space, 64 MiB scratch and 16 MiB file size. The virtual address limit is not an RSS/cgroup limit. The launcher trusts root-administered glibc/runtime/system module trees and requires `cc`/headers. User-local dependency trees and network-dependent harnesses are unsupported. Harness `_your_bot/execute_tool` requests reenter core authorization; no harness may grant execution directly. Other OS containment is not implemented.

## Desktop and local storage

Electron enforces context isolation, renderer sandbox, no Node integration, narrowly scoped preload APIs, strict IPC schemas, sender/main-frame/origin checks, navigation/popup restrictions and a production CSP denying renderer networking. Text/model output is rendered as text, with no HTML execution. Provider HTTP requests run only in the backend, refuse redirects and reject endpoint-embedded credentials. Endpoint configuration is an owner operation; deliberately configured remote endpoints receive prompts/tool results.

SQLite and the managed environment are in dedicated owner-only directories (0700) with database files 0600. API keys stay in local SQLite, are never returned in snapshots, and known key strings are scrubbed from output/replay. Credentials are **not encrypted at rest**; retired keys remain in a private redaction registry to protect historical events. This is not a generic secret or covert-channel filter. Other processes running as the same OS user, a compromised trusted host, root, runtime/kernel vulnerabilities, and malicious code in the development dependency chain are outside this isolation guarantee. Windows requires equivalent private ACLs before claiming storage protections.

No production remote listener, pairing service or unauthenticated command port is implemented. Future transports must authenticate, encrypt and derive identity server-side before using the gateway. Event/command history has no retention policy yet.

## Reporting and validation

Report vulnerabilities privately to the repository maintainer with reproduction steps and affected versions; do not include real credentials in public reports. [Validation](validation.md) lists executed security tests and unverified external runtimes. Security tests fail on missing isolation rather than skip or run untrusted code without a boundary.
