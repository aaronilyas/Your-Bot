# @your-bot/remote

Remote access to a Your Bot host. It provides:

- **Remote host** (`createRemoteHost`): a TLS-only WebSocket server in front of an injected
  `DesktopGatewayV2`. It also implements `DeviceManager` (pairing, listing, revoking devices).
- **Client**: `pairWithCode`, `connectDevice`, `RemoteTransport` (a v2 `BackendTransport`),
  `HostDirectory` (saved hosts) and `MultiHostClient` (several hosts at once).
- **CLI** `your-bot-remote`: `pair`, `hosts`, `approvals`, `approve`, `watch`.

```ts
const remote = await createRemoteHost({ gateway, ownerId: localPrincipal.id, dataDir, listen: { host: '0.0.0.0', port: 7443 }, hostName: 'Workstation' });
const offer = await remote.deviceManager.startPairing({ name: 'Phone' }); // show offer.code once
// …
await remote.close();
```

## Host data

`dataDir` (0700) contains `tls/key.pem` and `tls/cert.pem`, which make up a self-signed
ECDSA P-256 certificate (both 0600, created once and reused across restarts), and
`devices.sqlite` (0600), which holds the host id, the devices and the hashed pairing offers.
Symlinked directories and files are refused.

## Wire protocol `yourbot-remote/1`

The transport is a WebSocket at `wss://<host>:<port>/ws` over TLS 1.3. Every frame is a single
JSON text frame of at most 1 MiB. The host has no plaintext listener: plain `ws://` and `http://`
fail at the TLS layer, and an HTTPS request that is not an upgrade gets `426`. An upgrade that
carries an `Origin` header (from a browser) or uses another path is refused before the challenge
is sent.

Clients do not validate a CA chain. They **pin** the lowercase hex SHA-256 of the certificate DER
and check it right after the TLS handshake, before they send the WebSocket upgrade.

```
server → {t:'challenge', protocol:'yourbot-remote/1', hostId, fp, nonce}     // nonce: 32 random bytes, base64url
client → exactly one of:
  {t:'pair', secret, name, publicKey}     // publicKey: Ed25519 SPKI DER, base64url
     server → {t:'paired', deviceId, hostId, hostName, capabilities}; then close 1000
  {t:'auth', deviceId, signature}         // Ed25519 over `yourbot-auth-v1|<hostId>|<fp>|<nonce>`
     server → {t:'ready', deviceId, hostId, hostName, principalId, capabilities}
after ready:
  client → {t:'command', command: DesktopCommandV2}
  server → {t:'result', id, result: CommandResultV2}
  server → {t:'event', event: DesktopEventV2}
```

The client signs with the `hostId` and fingerprint it saved when pairing, never with values the
server announces. A challenge that announces a different fingerprint or host id is rejected.

**Pairing code.** The code has the form `ybp1.` + base64url(JSON `{v:1, urls:[wss://…], fp, secret}`).
`secret` is 128 random bits. The host stores only `sha256("yourbot-pairing-v1|" + secret)`.
An offer is single-use: it is consumed on the first attempt, even if that attempt fails, and it
expires after 10 minutes. Failed pairing attempts are throttled across the host: after 5 failures
in 60 s, every pairing is refused until the window passes. A capability set and a name given in
`startPairing` take precedence over what the device asks for.

**Principal.** After a successful `auth`, the host builds the principal from the stored device
record only:
`{id:'device:<deviceId>', kind:'remote', ownerId, deviceId, capabilities}`. The default
capabilities are every `CapabilityV2` except `settings`, `library.install` and `network`. Command
frames cannot select or change the identity, because the principal is never read from a frame.

**Commands.** Only contract **v2** commands are accepted (`version: 2`). Each one is validated
with a strict schema that rejects unknown keys and bounds sizes. Frames are also checked for
nesting depth (≤ 24) and for prototype keys. `settings.update` and `device.*` are refused with
`FORBIDDEN`, because they are local-owner only; core enforces this as well. A frame that fails
validation is answered with an error result and never reaches the gateway. If the gateway throws,
the client sees `BACKEND_ERROR`.

**Events.** On `ready`, the host subscribes the principal with `{contractVersion: 2}` and forwards
only events whose `principalId` is the owner or this device. On disconnect it unsubscribes. Tasks
are never cancelled on disconnect.

**Redaction.** As defense in depth, provider `apiKey`s, MCP `env`/`headers` values, the device
registry, pairing offers and `device.updated` events are stripped from everything sent to a
device.

**Resume.** `RemoteTransport` reconnects with exponential backoff and jitter (default 0.5 s to
30 s). Once authenticated, it sends `state.sync {afterSequence: lastSequence}`, and the gateway
replays the events missed since then. Events are deduplicated by `sequence`, so listeners see
each one exactly once, in order. If the host answers `INVALID_CURSOR`, the transport falls back to
a full sync. Close codes `4001` (auth failed), `4003` (revoked) and `4008` (protocol) are
permanent: the transport does not reconnect after them.

### Close codes

| code | meaning |
|------|---------|
| 4001 | authentication or pairing refused |
| 4002 | authentication timeout (10 s) |
| 4003 | device revoked |
| 4008 | protocol violation (binary or malformed frame, wrong frame order) |
| 4009 | too many connections for this device |
| 4010 | slow consumer (more than 8 MiB of outbound data buffered) |
| 4011 | host shutting down |
| 1009 | frame larger than 1 MiB |

## Limits (defaults; override with `limits`)

| limit | default |
|-------|---------|
| frame size | 1 MiB |
| authentication timeout (also TLS handshake and HTTP headers) | 10 s |
| live connections per device | 4 |
| unauthenticated sockets | 32 |
| TCP connections | 256 |
| command rate per connection | token bucket: burst 30, 10/s (`RATE_LIMITED`) |
| in-flight commands per connection | 32 (`BUSY`) |
| pairing failures | 5 per 60 s, across the host |
| pairing offer lifetime | 10 min |
| heartbeat | ping every 30 s; terminated if no pong arrives |

## Revocation

`deviceManager.revoke(id)` marks the device revoked, closes its live sockets with 4003 and stops
its event stream at once. From then on, every `auth` from that device is refused with 4003.
`list()` reports `pairedAt`, `lastSeenAt` and `revokedAt`. `lastSeenAt` is updated on
authentication and on disconnect.

## Client storage

`HostDirectory(dir, {cipher?})` stores `hosts.json` (0600, directory 0700). It holds each host's
id, name, URLs, pinned fingerprint, device id, capabilities and resume cursor. The device's
Ed25519 private key is encrypted with the injected `SecretCipher` when one is given. Without a
cipher, the key is stored as plaintext PKCS#8, protected only by the file mode, and the CLI prints
a warning when that happens.

## CLI

```
your-bot-remote [--config <dir>] pair <code> [--name <device name>]
your-bot-remote hosts [--json]
your-bot-remote approvals [--host <id>] [--json]
your-bot-remote approve <requestId> [--deny] [--scope once|task] [--host <id>]
your-bot-remote watch [--host <id>]
```

The config directory is `--config`, `$YOUR_BOT_REMOTE_HOME`, or
`$XDG_CONFIG_HOME/your-bot-remote`. The CLI cannot create standing grants, because
`--scope standing` is not offered. Standing grants come from the desktop UI or a
`permission.decide` sent through the API.

## Threat model

Protected against:

- **Network attackers.** All traffic is TLS 1.3 with a pinned certificate, so a
  man-in-the-middle cannot pair, authenticate or read frames. The auth signature covers the
  host id, the fingerprint and a fresh nonce, so a signature cannot be replayed on another
  connection or relayed to another host.
- **Unauthenticated peers.** Before `ready`, a peer gets the challenge and nothing else: no
  events and no dispatch. It is cut off after 10 s and capped in number.
- **Stolen or guessed pairing codes.** Codes are single-use, expire, and are throttled, and the
  secret has 128 bits of entropy. A code captured after it was used is worthless.
- **Malicious paired devices.** The identity comes from the server. Commands must match the v2
  schema, and owner-only commands are refused. Capabilities are enforced by core. Rate, size and
  connection limits apply. Revocation is immediate.
- **Browsers.** Requests with an `Origin` header are refused, so web pages cannot use the
  socket.

Not protected against:

- **Leaked pairing codes.** Whoever redeems a code first becomes the device. Treat a code like a
  password until it is used or expires.
- **A compromised client machine.** Without a `SecretCipher`, the device key can be read by
  anyone who can read the owner's files.
- **Pairing DoS.** Because the pairing throttle is host-wide, an attacker who can reach the port
  can keep pairing refused by sending bad secrets. Authenticated devices are not affected.
- **Certificate rotation.** There is none. Deleting `tls/` changes the fingerprint, and every
  device must pair again.
- **Advertised URLs.** These are guessed from the listen address and the non-internal IPv4
  interfaces. Pass `advertiseUrls` for NAT, DNS names or IPv6.
