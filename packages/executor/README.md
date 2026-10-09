# Python tool executor integration

`@your-bot/executor` implements the frozen v1 `ToolExecutor` from `@your-bot/contracts`. Import `createToolExecutor`, `PythonToolExecutor`, `probeSandbox`, `pythonApprovalReason`, and `SKILL_IDS`; types include `ExecutorOptions` and `SandboxProbe`.

```ts
import { createToolExecutor, probeSandbox } from '@your-bot/executor';

const options = { environmentRoot: '/absolute/canonical/app-data/python' };
const availability = await probeSandbox(options);
// Surface availability.error if !availability.supported. Never fall back to host Python.
const executor = createToolExecutor(options);
// Inject executor as the core's ToolExecutor. Use one executor per environmentRoot.
// await executor.execute(invocation, coreIssuedContext);
// await executor.cancel(taskId);
// await executor.close();
```

The root is a dedicated application directory, owned by the application UID, with mode 0700; its canonical path must equal the supplied path. It is created if absent. Its venv persists across close/restart. Temporary wheel directories are removed after success, failure or cancellation. Worker scratch is a private size-limited tmpfs discarded on exit. Do not put credentials or unrelated files in this directory. Use separate roots for separate trust domains.

Requires Linux x86_64, Python **3.10+** in `/usr`, `venv`, ctypes, and bubblewrap with working user/PID/network namespaces, `--size`, `--bind-fd` and `--ro-bind-fd`. Defaults are `/usr/bin/python3` and `/usr/bin/bwrap`; `pythonPath` and `bubblewrapPath` override these trusted executable locations. Other architectures/platforms and missing or denied containment fail closed. `probeSandbox` performs actual execution and required syscall denial checks, rather than just checking executable existence. It creates/checks the application venv. Host execution is limited to trusted, isolated Python version detection and `venv --without-pip` creation; user code and pip never execute on the host.

## Core authorization requirements

Core must authenticate `context.authorization.principal`, bind session/task IDs itself, and supply only live, allowed `PermissionRequest` grants. Every grant is checked against principal/session/task and file capability/access. The principal needs `tool.execute` for every operation and the relevant file/install capability. The executor trusts this non-wire context from core; it is not a renderer-facing service.

When `requestPermission` returns allow, **core must add the exact approved request to the same `authorization.grants` context before resolving the callback**. A decision alone supplies no verifiable scope. The new grant ID must equal the decision's `requestId`. Grants containing a larger file list, a directory prefix, different access, different packages, or another identity/session/task do not authorize a narrower invocation. File requests are one exact path/access per grant. Core owns once/task lifetime and must remove consumed/revoked grants; the executor does not cache permission decisions.

Custom `kind: 'python'` also needs a `tool.execute` grant whose `reason` exactly equals `pythonApprovalReason(invocation.code)`. The executor requests this automatically. This uses the frozen contract's reason field to include the exact code alongside its SHA-256 fingerprint. Display the full reason/code in core's approval UI. Modifying the code requires another approval. The invocation is copied before asynchronous approvals to prevent caller mutation from changing the approved code/scopes.

All paths must be exact absolute canonical strings; `..`, trailing/redundant separators and symlinks at any component are rejected. Only regular files are supported. Write/delete bindings to trusted runtime directories or the managed environment are refused. Writable hardlinks are refused. File creation uses an exclusive open in the pinned canonical parent, mode 0600. Parent directories are never writable user-file mounts.

A `write` binding exposes read/write at the OS mount boundary, so it requires **both** exact `file.write` and `file.read` grants/capabilities. This applies to new files too, for a consistent rule. Declare write access in `invocation.paths`; the executor requests the accompanying read approval. Read-only grants never permit writes. Bindings use pinned FDs and native bubblewrap FD mounts, so later ancestor/leaf symlink replacement cannot redirect the worker to another file.

`file.delete` is a trusted host broker after successful sandbox verification, with an exact delete grant. It unlinks one directory entry relative to a pinned parent and never follows the leaf symlink; a changed inode detected before removal fails. The authorization is to remove that exact directory entry, not to follow a renamed inode. Custom Python cannot unlink/rename a file mount or access its parent; delete access cannot be passed to custom code. Cancellation is checked immediately before the broker operation; a completed filesystem syscall cannot be rolled back.

## Invocation API

Python receives `input` (the invocation's JSON value) and `files` (a dictionary from declared canonical host paths to sandbox aliases such as `/files/0`). Assign a JSON-serializable value to `result`. Stdout/stderr go to `context.emit`; stdout is delivered by line, with trailing output on exit. Example:

```ts
const invocation = {
  id: 'python-1', kind: 'python' as const,
  input: { path: '/home/user/report.json' },
  paths: [{ path: '/home/user/report.json', access: 'read' as const }],
  code: 'import json\nwith open(files[input["path"]]) as f:\n    result = json.load(f)',
};
```

Predefined `kind: 'skill'` invocations do not require custom-code approval. They still require all file grants. Input must be a JSON object:

| `skillId` | Input | Result |
| --- | --- | --- |
| `calculation` | `{operation, values: number[]}`; operation is `sum`, `product`, `mean`, `median`, `min`, `max`, `stdev`, `variance` | finite numeric calculation; sample variance/stdev need two values |
| `data.analysis` | `{rows: object[], column}` or `{path, column}` for an approved CSV | count, sum, min, max, mean, median, sample stdev |
| `structured.json` | `{text}`, `{value}`, or `{path}`; optional `select: (string \| number)[]` | parsed/selected JSON |
| `structured.csv` | `{text}` or `{path}` | array of header-keyed objects, string cell values |
| `file.read` | `{path}` plus declared read scope | UTF-8 text |
| `file.write` | `{path, text}` plus declared write scope | `{bytes}` written as UTF-8; overwrites/truncates that exact file |
| `file.delete` | `{path}` plus a delete-only scope | `{deleted: path}` |

Errors are returned as `ToolResult` with `ok: false` and a structured error. Common codes are `PERMISSION_DENIED`, `INVALID_GRANT`, `INVALID_PATH`, `INVALID_INVOCATION`, `PYTHON_UNAVAILABLE`, `SANDBOX_UNAVAILABLE`, `EXECUTION_FAILED`, `TIMEOUT`, `OUTPUT_LIMIT`, `INPUT_LIMIT`, `FILE_LIMIT`, `CANCELLED`, `EXECUTOR_CLOSED`, and `PACKAGE_*`. Execution errors can have partial approved file writes; writes are not transactional.

## OS boundary and limits

Bubblewrap isolates user, PID, IPC, UTS, network and supported cgroup namespaces; clears the environment; drops capabilities; mounts `/usr` and runtime library directories readonly; supplies only null/urandom devices and private readonly proc; omits user home; and makes root readonly. Only private scratch and approved exact write-file mounts are writable. Python always starts from the trusted readonly system interpreter, even if an installed wheel alters `venv/bin/python3`.

The trusted `-I -S` bootstrap installs `no_new_privs` and a seccomp BPF filter through ctypes **before** executing custom code, importing venv packages, or starting pip. The filter checks `AUDIT_ARCH_X86_64`, allows a small explicit syscall list, and returns EPERM for everything else. It denies fork/vfork/clone/clone3, execve/execveat, sockets/connect, namespace/mount operations, ptrace, BPF, io_uring, signals to other processes and limit modification. The x32 ABI is denied; another syscall architecture kills the process. Only terminal queries and CLOEXEC ioctls are allowed. The kernel filter remains enforced even if Python internals are modified. There is no AST or prompt sandbox. See [Linux seccomp documentation](https://man7.org/linux/man-pages/man2/seccomp.2.html).

No site initialization, `.pth`, user site or `sitecustomize` runs. Managed site-packages is appended after the filter. Native packages/code remain subject to the same kernel boundary; libraries needing threads or subprocesses will fail.

Defaults: 10-second wall time, maximum requested wall time 30 seconds, 256 MiB address space, 32 MiB scratch tmpfs, 16 MiB per-file size limit (larger existing writable files are refused), 64 open FDs, zero core dumps, CPU hard limit rounded up from wall time, 1 MiB invocation/config limit and 1 MiB combined stdout/stderr/protocol output. Trusted constructor options can adjust time/output/memory/scratch/file limits. Limit violations terminate/fail the worker. Abort/cancel/close send SIGKILL to its process group; bubblewrap also kills the worker on parent death. Requests are serialized per executor so installation cannot mutate the venv while a worker is using it. Close cancels pending approvals, queued tasks, active downloads, workers and probes, and awaits cleanup.

## Separately approved package installation

Use `{id, kind: 'library.install', input: null, packages: ['package==version']}`. Exact names with optional `==version` are accepted; pinned versions are recommended. URLs, VCS/editable installs, flags, extras, ranges and requirement files are rejected. The principal needs `library.install`; an exact package-list grant is mandatory. User-file bindings are forbidden during installation.

After approval, a host broker fetches metadata only from `https://pypi.org` and wheels only from `https://files.pythonhosted.org`, with redirects refused, registry name/version checks, wheel identity checks and SHA-256 verification against metadata. Downloads are limited to 32 MiB per wheel, 64 MiB per request and 4 MiB metadata. Only universal `py3-none-any`/`py2.py3-none-any` wheels are supported. Each wheel has at most 4096 members; traversal paths, members above the per-file limit, and total expanded content above 64 MiB are rejected inside the sandbox before pip writes files.

Pip runs inside the sandbox, **without any network**, with only the managed venv writable, `--no-index --no-deps --only-binary=:all: --no-compile --no-cache-dir`. Dependencies must be separately listed/approved; compiled wheels and source builds are unsupported. System-bundled pip is used if present. Otherwise the executor separately requests approval for `pip==25.3`, downloads its wheel as a temporary installer and executes it under the same seccomp boundary; it does not globally install pip. Installation failures may leave partial changes in the managed venv. Recreate the dedicated application environment to repair it; the executor never removes a user's environment automatically.

Supply-chain limitation: TLS/registry hashes confirm transport/registry consistency, not publisher trust or code safety. Approved packages can contain malicious Python/native payloads and can modify other files in the managed venv while pip installs them. Importing them later runs untrusted code under the sandbox and any file grants for that invocation. The installer wheel itself is also a supply-chain input. The sandbox bounds host access, but cannot guarantee trustworthy results or preserve confidentiality of files that the user explicitly grants to malicious code.

## Validation

From the repository root:

```sh
npm install
npm run build -w @your-bot/contracts
npm run typecheck -w @your-bot/executor
npm run build -w @your-bot/executor
npm run test -w @your-bot/executor
```

Tests use real bubblewrap; they do not silently skip unsupported environments. Coverage includes syscall/alternate ABI denial, host/read-only writes and secret reads, exact writable mounts, live symlink replacement after binding, code hash/identity/task/access approval, input mutation during approval, ignored `.pth` and replaced venv executables, scratch cleanup, cancellation/close, time/output/file/memory caps, predefined skills, and offline wheel installation/import. The fixture installer test needs HTTPS access to PyPI's two approved endpoints if this Python distribution has no bundled pip. The package fixture itself is generated locally, not published or installed globally.
