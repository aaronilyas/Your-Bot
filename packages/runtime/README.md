# @your-bot/runtime

Composition root for the desktop app and the headless host. `createRuntime` builds one
gateway and the services it is allowed to call. Core stays the authority; this package only wires it.

```ts
const runtime = await createRuntime({ dataDir });
await runtime.gateway.dispatch(command, runtime.principal);
await runtime.close(); // remote host first, then the gateway
```

The returned gateway's `close` is that same runtime close, so a host that only keeps the gateway
still shuts the remote listener down first. The gateway close already closes the workspace host
and the MCP broker; `createRuntime` does not close them again.

## Data directory

`dataDir` is created mode 0700. A symlink is refused. Layout:

| Path | Mode | Contents |
| --- | --- | --- |
| `host.json` | 0600 | Persisted random host id and display name |
| `gateway/history.sqlite` | 0600 | Gateway database (directory 0700) |
| `keys/secret.key` | 0600 | File-cipher key, only when no cipher is injected. Not next to the database |
| `skills/` | 0700 | Global skill catalog |
| `mcp/browser/` | 0700 | Working directory for the browser MCP preset |
| `python/` | 0700 | Managed Python executor environment |
| `remote/` | 0700 | Remote host state, only when `listen` is set |

The owner control socket and `control.token` are created by `@your-bot/host`, not here.

## What is wired

- `createGatewayV2` with the managed Python executor, `createWorkspaceHost()`, and a secret cipher
  (injected, or `createFileCipher` with the key under `keys/`).
- An MCP broker wrapper that runs `expandPreset` on every server config that carries `preset`.
  The desktop UI sends `{preset:'browser', command:'npx'}`, which the broker would otherwise leave
  unexpanded. The browser preset's cwd is `mcp/browser` unless the config already sets one.
- `createSkillCatalog({ globalDir })`.
- Strict Linux containment for ACP providers, the same rule the desktop host used before this
  package: linux, x64, one absolute `.mjs` or `.py` argument. `ProviderConfigV2.launch === 'host'`
  is launched uncontained by `createAdapters` (it strips containment for that provider).
- The local owner principal, including `mcp.call`.
- Optional `createRemoteHost` when `listen` is set. The gateway receives a lazy `DeviceManager`
  that forwards to the remote host after it is listening. The remote protocol host id is not the
  gateway host id; both are on the returned `Runtime`.

`notifier`, `clock`, `skillCatalog` and `routineCapabilities` are passed through a cast marked
`DROP AT P4 MERGE` until `feature/p4-continuity-routines` adds them to `GatewayOptions`.

Remote pairing is off unless `listen` is set. `close()` is idempotent.
