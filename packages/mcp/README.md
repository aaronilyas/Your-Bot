# @your-bot/mcp

Implements the v2 `McpBroker` contract (`@your-bot/contracts`) with the official
`@modelcontextprotocol/sdk` (pinned to `1.32.2`).

Core is the only authority. For each agent task it calls `broker.open(...)` once and hands the returned
endpoint to an ACP agent, which connects to a **loopback, authenticated, tools-only** MCP proxy. The
agent never talks to upstream MCP servers, and every tool call is authorized by core before anything is
forwarded.

## API

```ts
import { createMcpBroker, expandPreset } from '@your-bot/mcp';

const broker = createMcpBroker({ /* optional */ });
const session = await broker.open({ taskId, botId, servers, builtins, authorize, signal });
session.endpoint;   // { name: 'your-bot', url: 'http://127.0.0.1:<port>/mcp', headers: [{ name: 'Authorization', value: 'Bearer <token>' }] }
await session.tools();   // McpToolInfo[]: { serverId, name (un-namespaced), description?, inputSchema? }
session.failures();      // { serverId, tool?, reason }[]  (extension of McpProxySession)
await session.close();
await broker.close();    // closes every open session
```

`createMcpBroker(options?)`: `connectTimeoutMs` (30 s), `callTimeoutMs` (120 s), `killGraceMs` (2 s
between SIGTERM and SIGKILL), `baseEnv` (what allowlisted env is taken from; default `process.env`).

`expandPreset(config)`: `preset: 'browser'` becomes a stdio config running
`npx -y @playwright/mcp@<PLAYWRIGHT_MCP_VERSION> --headless --isolated` (no window; in-memory profile
that is never written to disk). The incoming `command`/`args` are discarded (a preset cannot be used to
smuggle flags); `env`/`cwd` of a stdio config are kept. Idempotent. Hosts should call it when composing
server lists; `open()` also expands a preset that was left unexpanded (http transport or empty command).
A config that already carries a stdio `command` is used as given.

The Playwright MCP default blocks `file://` navigation and restricts file access. The preset keeps it
that way; the opt-in browser test adds `--allow-unrestricted-file-access` itself for its local page.

### Session lifecycle

* `open()` connects every enabled server in parallel. A server that fails (spawn error, handshake error,
  timeout, invalid id) is **absent** from `tools()` and recorded in `failures()`; `open()` itself only
  rejects on abort, invalid builtins, or if the proxy cannot listen. Failure reasons are scrubbed of the
  configured `env`/`headers` values and limited to 1 KiB.
* `close()` (or aborting the `signal` passed to `open()`, or `broker.close()`) closes the proxy
  listener and its connections, closes upstream clients and kills stdio children **as a tree**: POSIX
  process group (`SIGTERM`, then `SIGKILL` after the grace period, also sweeping orphaned group members),
  Windows `taskkill /pid <pid> /T /F`. `close()` is idempotent.
* The tool list is fixed at `open()`; upstream `tools/list_changed` is ignored.

## Tool naming

* Upstream: `<serverId>__<tool>`; builtins: `your_bot__<name>`.
* Server ids: `^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$`, no `__`, `your_bot` reserved, unique.
* Tool names (and builtin names): `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` and the namespaced name ≤ 64 chars
  (the strictest common agent-side limit). Upstream tools that do not fit are skipped and listed in
  `failures()` with their `tool`; invalid/duplicate builtin names make `open()` reject.
* `McpToolInfo.name` and `McpCall.tool` use the **un-namespaced** tool name; `serverId` is `'your_bot'`
  for builtins.

## Security properties

* Binds only `127.0.0.1`, OS-assigned port, never a non-loopback interface.
* 256-bit random bearer token per session (`Authorization: Bearer ...`), compared in constant time
  (SHA-256 digests + `timingSafeEqual`). Missing/wrong token → `401`. A session's token does not open
  another session.
* `Host` must be exactly `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding) → else `403`.
  Any request with an `Origin` header is rejected (`403`), even with a valid token.
* Order of checks: Host, Origin, token, then path (`/mcp`), method (`POST` only; `405` otherwise).
* Tools only: no resources, prompts, sampling or server-initiated messages; stateless streamable HTTP
  (one JSON response per POST, no session ids, no SSE).
* **Every** `tools/call`, builtins included, calls `authorize({ serverId, tool, arguments }, signal)`
  first. `false`, or a thrown/rejected `authorize`, returns an MCP tool result with `isError: true` and
  text `Permission denied`; the upstream (or builtin handler) is never contacted. An unknown tool name
  returns a tool error without calling `authorize` (there is nothing to authorize).
* Stdio upstreams are spawned **without a shell**. Their environment is a small allowlist of host
  variables (PATH, HOME, locale, proxy/CA settings, `npm_config_*`, Windows system variables) plus the
  configured `env`; host secrets are not inherited.
* Windows: `PATH`/`PATHEXT` resolution; `.exe/.com` run directly; `.cmd/.bat` (e.g. `npx.cmd`) go through
  `cmd.exe /d /s /c` with every argument double-quoted and arguments containing `"`, `%`, CR, LF or NUL
  refused. (Unit-tested with a simulated platform; not exercised on a real Windows host by this package's
  tests.)
* Aborting the `open()` signal, an HTTP client disconnect, or the request being cancelled aborts the
  `signal` handed to `authorize`, builtin handlers and the upstream call.

## Limits

| Limit | Value |
| --- | --- |
| Tool call arguments (serialized) | 1 MiB → tool error, upstream not contacted |
| Tool result (serialized) | 1 MiB → tool error replaces the result |
| HTTP request body | 1 MiB + 64 KiB → `413` |
| Tools per upstream | 512 (more → the upstream fails) |
| Tool description | 4096 chars (truncated in the proxied listing) |
| Upstream connect + list | `connectTimeoutMs` |
| Upstream call | `callTimeoutMs` |

## Tests

`npx vitest run packages/mcp` (part of root `test:security`): fake stdio fixture
(`test/fixtures/stdio-upstream.mjs`) and in-process fake HTTP upstream; namespacing, allow/deny (deny never
reaches upstream, asserted via an on-disk call counter), 401/403 paths, loopback-only binding, token
uniqueness, limits, abort/close kill the child **and grandchild**, env allowlist, Windows spawn planning.

Opt-in real browser test: `YOUR_BOT_BROWSER_TEST=1 npx vitest run packages/mcp/src/browser.test.ts`.
Needs network access to npm (npx fetches the pinned `@playwright/mcp`) and a Chromium that Playwright can
launch; set `YOUR_BOT_BROWSER_EXECUTABLE=/usr/bin/chromium` to use a system browser. Without the env var
the test is reported as skipped by name.

## Known limitations

* Playwright MCP writes snapshots/output under `<cwd>/.playwright-mcp`; set `cwd` on the browser server
  config to a scratch/workspace directory (otherwise it lands in the broker's process cwd).
* A stdio descendant that deliberately leaves the process group (`setsid`) is not reached on POSIX.
* Only tools are proxied; upstream resources/prompts/sampling/elicitation are not.
* Upstream tool list is a snapshot; a crashed stdio upstream is not restarted (calls return
  `Upstream unavailable`).
* The proxy offers no TLS (loopback only, bearer-authenticated).
