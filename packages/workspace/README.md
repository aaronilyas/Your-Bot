# @your-bot/workspace

Implementation of the `WorkspaceHost` contract (`packages/contracts/src/v2.ts`) for Linux, macOS
and Windows. It performs file and terminal operations for **trusted** bots *after* core has
authorized them. It is not an authorization layer and not a sandbox (see "What is not protected").

```ts
import { createWorkspaceHost } from '@your-bot/workspace';

const host = createWorkspaceHost();                       // options: { baseEnv?: NodeJS.ProcessEnv }
const path = await host.resolve(root, 'src/index.ts');    // canonical absolute path
await host.writeTextFile(root, path, 'export {};\n', { signal });
const text = await host.readTextFile(root, path, { line: 1, limit: 20, signal });
const id = await host.createTerminal(root, { command: 'npm', args: ['test'], cwd: root }, { taskId, signal });
const { exitCode, signal: sig } = await host.waitForTerminalExit(id, signal);
const { output, truncated } = await host.terminalOutput(id);
await host.releaseTask(taskId);                           // kill + free everything of a task
await host.close();                                       // kill + free everything
```

No runtime dependencies besides `@your-bot/contracts` (types only).

## Errors

Every rejection is an `Error` with a string `code` (class `WorkspaceError`):

| code | when |
| --- | --- |
| `OUTSIDE_WORKSPACE` | `..`/absolute escape, link/junction leaving the root, path changed to point outside while in use |
| `NOT_FOUND` | missing file/parent/cwd/command |
| `TERMINAL_NOT_FOUND` | unknown or already released terminal id (all terminal calls, including a second `releaseTerminal`) |
| `LIMIT_EXCEEDED` | file > 10 MiB; > 16 running terminals per task (or > 64 unreleased handles) |
| `INVALID_REQUEST` | bad arguments, non-canonical root/path, directory where a file is needed, Windows ADS/device names, dangling link, unrepresentable `.cmd` argument, host closed |
| `ABORTED` | the supplied `AbortSignal` fired |
| `IO_ERROR` | any other OS error (errno in the message) |

`ABORTED` and `IO_ERROR` are additions to the codes listed in the contract doc comment.

## Files

* `resolve(root, path)`: `root` must be absolute and already canonical (`realpath(root) == root`,
  case-insensitive on win32/darwin), else `INVALID_REQUEST`. Relative paths resolve against the
  root. The path is normalized lexically first (so `..` and absolute escapes are rejected without
  touching the disk), then canonicalized with `realpath` (final component exists) or
  `realpath(parent) + basename` (final component does not exist; the parent must). The result
  must be inside the root: links/junctions anywhere on the path are followed and checked. A link
  that stays inside the root resolves to its target. Dangling links are refused. On Windows,
  `:` in a name (alternate data streams) and reserved device names (`NUL`, `COM1`, ...) are
  `INVALID_REQUEST`.
* `readTextFile` / `writeTextFile` take the canonical path returned by `resolve`. They
  **re-resolve it immediately** and refuse anything that differs (`OUTSIDE_WORKSPACE` /
  `INVALID_REQUEST`), then verify the file that was actually opened (see below).
* Read: regular files only (a FIFO planted in the workspace is refused without blocking; opened
  `O_NOFOLLOW|O_NONBLOCK` on POSIX), at most 10 MiB, UTF-8 (BOM kept, invalid bytes become U+FFFD).
  `line` (1-based) and `limit` (lines) slice the content and keep line terminators. The 10 MiB
  limit applies to the whole file even when slicing.
* Write: content goes to a random temp file in the target's directory (`O_CREAT|O_EXCL`, existing
  mode preserved on POSIX), is fsynced, confinement is checked once more, and the temp file is
  `rename`d over the target (atomic replace; Windows retries transient `EPERM/EBUSY`). The target
  is never opened for writing, so a hardlink is replaced rather than modified in place, and a
  symlink swapped in at the last moment is replaced rather than followed. Temp files are removed on
  failure.

### TOCTOU: what is and is not guaranteed

Node has no `openat`/`O_BENEATH`, so "check the path, then open the path" is inherently racy
against another process that renames directories inside the workspace. After opening, the host
therefore verifies the *open file itself*:

* **Linux**: the kernel's own path for the descriptor (`/proc/self/fd/N`) must equal the expected
  path inside the root. This is not racy: an attacker flipping a directory between a real
  directory and a link cannot make an outside file pass, and nothing is read or written before the
  check. A temp file that landed in the wrong directory is located the same way and removed
  (tested with a concurrent flipper process).
* **macOS / Windows**: no equivalent is reachable from Node. The host checks twice that the path
  still canonicalizes to itself inside the root, is not a link, and refers to the same inode as the
  open descriptor. This closes every sequential swap (tested deterministically) and makes a
  *concurrent* swap very hard, but a same-user attacker that can rename directories in the
  workspace at exactly the right moments is not provably excluded. Writes remain safe in the
  sense that content is only written after verification and the replace is a `rename` of our own
  temp file; the residual risk is a stray empty temp file outside the root and, for reads, a
  disclosure of an outside file that the same user could read anyway.

## Terminals

* Spawned **without a shell**, `detached` on POSIX (own process group/session), `windowsHide` on
  Windows, stdin closed, stdout and stderr merged in arrival order.
* `cwd` must be absolute, canonical, an existing directory and inside the root; it is re-resolved
  immediately before spawning.
* Command resolution is done by the host with the PATH of the child's environment (request `PATH`
  wins over the host's). A command containing a separator is resolved against `cwd`; a bare name
  is looked up only in PATH entries - **never implicitly in the cwd**. Windows: PATHEXT order, only
  `.exe`/`.com` (direct) and `.cmd`/`.bat`.
* `.cmd`/`.bat` run as `cmd.exe /d /s /v:off /c "<line>"` (`/v:off` is an addition to the contract
  text; cmd.exe is taken from `%SystemRoot%\System32`, never from the request env). Arguments are
  quoted by `quoteBatchArgument` (`src/winquote.ts`): conservative safe set unquoted, otherwise
  double-quoted, `"` -> `""`, backslashes before `"`/end doubled, `%` -> `%%cd:~,%`; CR/LF/NUL are
  rejected. Tested against real `cmd.exe` and a batch file forwarding `%*` with hostile arguments
  (`& | < > ^ ( ) " % ! =` ...): no injection, every argument arrives intact. Not guaranteed:
  batch files that strip quotes with `%~1` and then re-expose the text to cmd (BatBadBut class);
  a `%` in the batch file path is refused.
* Environment: only `PATH, HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG_*, TMP, TEMP, TMPDIR,
  LANG, LC_*, SystemRoot, ComSpec, PATHEXT` from `baseEnv` (default `process.env`), plus the
  request's variables (which win; names are case-insensitive on Windows).
* Output: ring buffer of `outputByteLimit` bytes (default 1 MiB, clamped to 32 MiB). Old data is
  dropped from the start, the visible text starts on a UTF-8 character boundary and `truncated`
  is `true`. While the process runs an incomplete trailing multibyte sequence is held back.
* Exit status: `{ exitCode, signal }`. POSIX reports real signal names; on Windows a terminal
  killed by the host reports `{ exitCode: null, signal: 'SIGKILL' }`.
* Kill: POSIX `SIGKILL` to the whole process group; Windows `taskkill /pid <pid> /T /F`.
  `killTerminal` waits (max 5 s) for the exit to be observed and keeps the terminal readable.
  `releaseTerminal` kills if needed and frees it; `releaseTask(taskId)` does that for every
  terminal of the task; the `signal` passed to `createTerminal` kills the terminal when aborted;
  `close()` releases everything and refuses new terminals. A `process.on('exit')` hook makes a
  best-effort synchronous kill of anything still alive when the host process exits normally.
* Limits: 16 *running* terminals per task (`LIMIT_EXCEEDED`) and 64 unreleased handles per task.
  Exit detection does not wait for pipes held open by background grandchildren (250 ms drain).

## What is not protected

* **Terminals are not sandboxed.** A command runs with the full rights of the host user and can
  read/write anywhere, open network connections and change the workspace's links. Confinement of
  terminals is limited to the starting `cwd` and process lifetime. The trusted profile relies on
  core authorization, not on this package, for what commands may do.
* Other processes of the same user (including a terminal the agent started) can race the checks
  described above on macOS/Windows.
* **Hardlinks**: a hardlink inside the root to a file outside is indistinguishable from a regular
  file; it can be *read*. Writes replace the link instead of modifying the shared inode.
* Files reachable through bind mounts/`subst` drives or other mount points inside the root are
  treated as part of the workspace.
* Case-insensitive comparison on darwin/win32 assumes a case-insensitive volume. A case-sensitive
  APFS volume or a Windows directory with the per-directory case-sensitivity flag could contain
  siblings that differ only by case.
* Windows cannot reach background processes that outlive their parent (the tree is found through
  the parent pid), so after the leader exits, orphans survive `release`. POSIX kills the whole
  group even after the leader exited. SIGINT/SIGTERM of the host process are not intercepted;
  call `close()` from the owner's shutdown path.
* Unix domain sockets, FIFOs and devices are refused for reads; writes only create regular files.
* The macOS code paths follow the same logic as Linux/POSIX but were not run on macOS (host
  unavailable).

## Tests

`npx vitest run packages/workspace` (also part of `npm run test:security`). Real processes and
temp directories only: escapes, links/junctions, swap-after-resolve (deterministic and with a
concurrent flipper process), limits, slicing, atomic replace, multibyte truncation, exit codes,
tree kill verified by grandchild pid, `releaseTask`, terminal limit, abort, and (Windows only)
real `cmd.exe` quoting.
