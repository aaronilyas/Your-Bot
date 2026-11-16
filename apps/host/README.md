# @your-bot/host

Headless Your Bot host and the owner control CLI. Binary: `your-bot-host`.

```
your-bot-host init --data <dir> [--name <name>]
your-bot-host run --data <dir> [--listen <host:port>] [--name <name>]
your-bot-host ctl --data <dir> '<json v2 command>'
your-bot-host pair --data <dir> [--name <device>]
your-bot-host devices --data <dir>
your-bot-host revoke --data <dir> <deviceId>
your-bot-host bot create --data <dir> --name <name> --agent <id> --profile strict|trusted [--workspace <dir>] [--instructions <text>] [--model <id>] [--memory]
your-bot-host grant create --data <dir> --bot <id> --capability <capability> [--folder <dir>] [--prefix <arg>]... [--mcp-server <id>] [--mcp-tool <name>] [--agent-tool-kind <kind>] [--expires <iso>]
your-bot-host routine create --data <dir> --bot <id> --name <name> --prompt <text> (--every <minutes> | --cron <expr> [--timezone <iana>] | --at <iso>) [--missed skip|runOnce|runAll] [--session new|reuse] [--max-catch-up <n>] [--disabled]
your-bot-host approvals --data <dir>
your-bot-host approve --data <dir> <requestId> [--deny] [--scope once|task|standing] [--folder <dir>] [--prefix <arg>]... [--mcp-server <id>] [--mcp-tool <name>] [--agent-tool-kind <kind>] [--expires <iso>]
your-bot-host watch --data <dir>
```

`--data` falls back to `YOUR_BOT_DATA`. Exit 0 on success, 1 on a command or connection error, 2 on usage.

`init` creates the 0700 data directory (see `@your-bot/runtime`) and `<data>/control.token` (0600, 32 random bytes, base64url). An existing token is kept. `run` refuses to start when that file is missing.

`run` stays in the foreground until SIGINT or SIGTERM. It prints the gateway host id, the display name, and the control endpoint. A remote listener starts only with `--listen host:port` (or `[ipv6]:port`). That also prints the TLS fingerprint, the `wss://` URLs, and `remoteHost` — the remote protocol's host id, which is not the gateway host id. Pairing codes from `pair` look like `code ybp1...`.

## Control channel

There is no unauthenticated listener.

- POSIX: a unix socket at `<data>/control.sock`, created with umask 0177 and chmod 0600, inside the 0700 data directory. A symlink at that path is refused. A leftover socket is unlinked on start and removed on shutdown. Windows: a named pipe `\\.\pipe\your-bot-<sha256(realpath(dataDir))>` because a pipe cannot live in the data directory. The token is still required; the default pipe ACL is not treated as authentication.
- The first NDJSON frame must be exactly `{"token":"<control.token>"}`. The comparison is constant-time. One attempt: a missing token, a wrong token, a malformed frame, or a 5 second timeout writes `{"ok":false,"error":{"code":"UNAUTHORIZED"}}` and destroys the socket. No command is dispatched before that check. The token is never taken from argv and never logged.
- Later frames are v2 commands. They run as the local owner principal held by the process. A principal inside the frame is not used. `{op:"watch"}` subscribes at contract version 2 and streams `{"event":...}` lines.
- Frames are capped at 1 MiB. Unauthenticated connections are capped.

`ctl` prints the raw JSON result. The other commands are thin builders of those same v2 frames.

Shutdown closes the control server first, then `runtime.close()` (remote host, then gateway). The gateway closes the workspace host and the MCP broker.
