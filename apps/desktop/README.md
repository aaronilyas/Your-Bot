# Your Bot desktop

Standalone Electron 44.7 / React / Vite 8 / strict TypeScript application. The renderer and IPC speak wire contract **v2** (`packages/contracts/src/v2.ts`); v1 commands remain valid and the original chat experience is unchanged. All source and configuration for this workspace lives under `apps/desktop`.

The renderer receives only `dispatch`, `subscribe` and one native folder picker, `chooseDirectory()` (see below). It has no core, provider, executor, Python, Node, filesystem, or identity API. The production executable wires the real core, adapters and executor through `src/main/backend.ts`. Browser demo mode is explicit and in memory.

## Run and build

From the repository root, using Node >=22.13:

```sh
npm ci
npm run build
npm run test -w @your-bot/desktop
npm run build -w @your-bot/desktop
npm run dev -w @your-bot/desktop
```

`dev` builds Electron main/preload and starts loopback Vite with renderer HMR. Restart it after changing main/preload. `start` runs a previously built Electron application. `dev:browser` starts Vite alone: open `http://127.0.0.1:5173/?demo=1` for the mock demonstration, or omit the query to inspect disconnected behavior. Typing “Read my workspace” in the demonstration exercises an exact-path permission dialog, simulated tool output, streaming and cancellation. No demo operation reads files, installs packages, launches processes, or contacts providers.

```sh
npm run package:linux -w @your-bot/desktop # Linux AppImage, deb, rpm, pacman, tar.gz (x64 + arm64)
npm run package:mac -w @your-bot/desktop   # macOS dmg + zip (x64 + arm64), run on macOS
npm run package:win -w @your-bot/desktop   # Windows NSIS installer + zip (x64 + arm64)
npm run package:dir -w @your-bot/desktop  # unpacked Linux application
npm run test:electron -w @your-bot/desktop # actual Electron/Xvfb smoke check; build first
```

Artifacts are in `apps/desktop/release/`. The builder configuration pins Electron 44.7.0, enables ASAR, and includes the compiled renderer, real backend main bundle and sandbox preload. Packaging uses the workspace root's locked dependencies. See the root README for system runtime prerequisites and `npm run test:desktop` for the complete native container validation.

The packaged icon is committed at `resources/icon.png`; `npm run build:icon -w @your-bot/desktop` regenerates it from the native vector source `resources/icon.svg`.

Linux runtime requires a working Chromium sandbox (supported user namespaces or a correctly installed setuid helper). The application never sets `--no-sandbox`. `test:electron` requires Xvfb and a host that allows that sandbox.

## Parent integration API

The host package export is Electron-main-only:

```ts
import { app } from 'electron';
import {
  createDesktopHost,
  type GatewayFactory,
  type GatewayFactoryContext,
  type DesktopHostOptions,
  type DesktopHost,
} from '@your-bot/desktop';

// Example for a different authenticated host. The production entry already
// uses createApplicationGateway from src/main/backend.ts.
const gatewayFactory: GatewayFactory = async ({ principal, userDataPath }) => {
  return makeYourGateway({ principal, userDataPath });
};

const host = await createDesktopHost({ gatewayFactory });
app.on('window-all-closed', () => app.quit());
// Parent shutdown, if needed:
// await host.close();
```

`createDesktopHost(options): Promise<DesktopHost>` awaits Electron readiness, creates the authenticated local `Principal`, calls the injected factory, creates a secured window, registers validated IPC, and forwards only events for that principal. `DesktopHost` exposes `window`, `principal`, and idempotent `close()`. Window closure automatically unsubscribes and closes the gateway. The host delays Electron's `before-quit` until asynchronous gateway cleanup completes. Call once per Electron process: the IPC channel names are process-wide.

`GatewayFactoryContext` contains `{ readonly principal: Principal; readonly userDataPath: string }`. The factory returns a contracts `DesktopGateway`, synchronously or asynchronously. The default host identity is stable `local-owner`; a trusted parent can supply `principalId`. Every dispatch and subscription receives this host principal. Its capabilities represent operations the owner can request; they do not replace the core's exact task grants and authorization.

Optional trusted host settings are `developmentURL` (unpackaged loopback HTTP origin only), `rendererFile`, and `preloadFile` (absolute build paths if the parent relocates outputs). Default assets are adjacent `dist/renderer/index.html` and `dist/preload/index.cjs`. `SECURE_WEB_PREFERENCES` is also exported for inspection. Do not expose these options to renderer commands.

The actual factory is wired in `src/main/entry.ts`. The host bundle includes backend dependencies and excludes Electron. Avoid importing `@your-bot/desktop` from the renderer.

Renderer/library exports:

```ts
import { App, DesktopStore, emptySnapshot } from '@your-bot/desktop/renderer';
import type { AppProps, DesktopState, TaskActivity, BackendTransport } from '@your-bot/desktop/renderer';
import '@your-bot/desktop/styles.css';
import { createMockTransport, type MockTransportOptions } from '@your-bot/desktop/mock';

// <App transport={yourTransport} demo={false} />
// const transport = createMockTransport({ chunkDelayMs: 35, permissionDemo: true });
```

`AppProps` is `{ transport: BackendTransport; demo?: boolean }`. `DesktopStore` owns synchronization, monotonic event handling, gap recovery, streamed text reconciliation, activity and connection state. `start()` returns subscription cleanup without closing a caller-owned transport; `reconnect()` resubscribes and syncs; `command(CommandPayload)` returns `CommandResult | undefined` (undefined on transport failure, timeout or stale connection generation); `selectSession(id)` opens the session; `getState` and `subscribe` support `useSyncExternalStore`. The transport owner calls `close()` when its lifetime ends. `createMockTransport` returns the same contracts interface, supports bounded command-ID deduplication, and cleans up scheduled work on close.

## Contract v2: bots, grants, routines, devices

### IPC (main/preload)

- `createDesktopHost` accepts `version: 1` and `version: 2` command frames. Both go through the same sender/frame/origin checks, the 1 MiB / depth-24 / prototype-key bounds and strict (`z.strictObject`) schemas; `parseAnyCommand` selects the schema by `version`, `parseCommand` stays the v1-only parser. Identity fields (`principal`, `principalId`, `ownerId`, `deviceId`, …) are rejected by the schemas. Valid frames go to `gateway.dispatch(command, principal)` with the principal created by main (it now also holds `mcp.call`). The gateway factory may return a v1 `DesktopGateway` or a `DesktopGatewayV2` (use `createGatewayV2` from `@your-bot/core` for v2).
- Main subscribes with `{ contractVersion: 2 }`. Events for other principals are dropped. Snapshot results/events/`bot.updated` are scrubbed again before reaching the renderer: provider `apiKey`s are removed and MCP `env`/`headers` values are blanked (keys kept) even if a gateway forgot to.
- `notification` events show a native Electron `Notification` while the window is not focused (control characters stripped, title ≤ 120, body ≤ 300 characters). Clicking restores and focuses the window. The event is still delivered to the renderer.
- `chooseDirectory(): Promise<string | undefined>` is the only addition to the preload API. It invokes `your-bot:choose-directory`; main checks the sender like every other call, ignores any argument, shows a folder-only `dialog.showOpenDialog` (one at a time) and returns just the chosen path (or `undefined`). Everything else (file reads, spawning, settings) stays impossible from the renderer; the path only becomes meaningful when sent back as an ordinary, validated bot command that core re-validates (`INVALID_WORKSPACE`, trusted rules, canonicalization).

### Screens

The sidebar groups conversations by bot (a `+` per bot starts `bot.session.create`; sessions without a known bot are listed under “Other”). Sections: **Bots**, **Routines**, **Permissions**, **Notifications** (unread badge), **Devices**, plus Settings.

- **Bots**: cards with Start session / Edit / Memory / Delete. The editor covers name, instructions, agent and model (from `snapshot.agents`), workspace via **Browse…** (native picker; plain text field when the transport has no picker), profile strict/trusted, MCP servers, skills, memory toggle and compaction policy. Choosing *trusted* shows a warning that the installed agent runs uncontained with your user's rights and network (file, terminal and permission requests still go through approvals), requires a workspace, and requires ticking “I understand”. The MCP editor supports stdio and HTTP servers and the **Add browser automation** preset (`preset: 'browser'`, placeholder `command: 'npx'`; the host expands it). `env`/`headers` values are secrets: stored keys show a blank, masked value (blank means unchanged and is sent as `""`), new keys take a value. Create sends `bot.create` without unset optional fields; edit sends a minimal `bot.update` patch where `null` clears `modelId`, `workspace` and `compaction`; nothing is sent when nothing changed.
- **Memory** (per bot): list, add, delete (`memory.list/add/delete`, live `memory.updated`).
- **Approvals**: the dialog shows bot, capability, canonical paths and access, command argv (one token per box) + cwd + environment *names*, MCP server/tool, agent tool title/kind, packages and the routine run. Buttons: Deny, Allow for this task, Allow once, and **Always allow…**, which builds a `StandingGrantScope` and sends `permission.decide` with `scope: 'standing'`: file access → editable folder (default: the file's parent; must stay a parent of every requested path and inside the bot workspace), `process.spawn` → editable argv-prefix tokens (default `argv[0]`; must be a prefix of the requested argv), `mcp.call` → server or server+tool, agent tools → tool kind; optional expiry. Standing is never offered for custom Python, `library.install`, `network`, `settings`, commands that set environment variables, or requests without a bot. The dialog can be dismissed and reopened from Permissions or a notification.
- **Permissions**: pending approvals (Review), active standing grants (Revoke, `grant.revoke`) and the audit log (`audit.list`, newest first, 50 per page with “Load older entries”, outcome and via badges, filter by bot).
- **Routines**: create/edit (prompt, interval/cron+timezone/once schedule, missed-run policy and `maxCatchUp`, session mode, enabled), pause/resume, Run now, delete, and a runs list; a `blocked` run has **Review approval** which opens the pending request it waits on.
- **Notifications**: unread badge, list, Acknowledge (and Acknowledge all), links to the approval or routines.
- **Devices**: **Pair a device** shows the single-use `PairingOffer` code in a selectable, copyable field with its expiry, fingerprint and URLs (never stored; closing the dialog discards it). Paired devices list with Revoke. For non-owner principals `devices` is empty so nothing can be revoked, and a `NOT_SUPPORTED` pairing error is explained.
- **Settings** gained a launch mode for ACP providers: contained (existing behaviour) or *installed agent on this computer* (`launch: 'host'`, free command/arguments, `envPassthrough` names) which only trusted bots can use.

### Store

`DesktopStore` sends `version: 2` commands, tolerates v1-shaped snapshots (missing v2 collections default to empty), accepts events of version 1 and 2, dedupes by `sequence`, buffers during `state.sync`, resyncs on gaps and calls `state.sync { afterSequence }` after `reconnect()`. It also tracks the audit page, bot memory and applies `bot.*`, `grant.*`, `routine.*`, `notification`, `device.updated` and `skills.updated` events and command results.

### Browser demo

`createMockTransport` is now a v2 simulation (marked as simulated in the UI and in every name): two bots (one trusted), a standing grant, audit entries, routines with run history, notifications, a device, skills and memory. Messages trigger each approval kind (“read a file”, “run the tests”, “open the web with the browser”, “edit a file”); “Always allow…” creates a simulated grant that then covers matching requests; **Run now** on *Morning repo check* blocks on an approval; pairing returns a clearly fake code. Nothing touches files, processes, providers or devices.

## Security and gateway expectations

- Preload is bundled CommonJS, compatible with `sandbox: true`. `window.yourBot` exposes exactly `dispatch(command)`, `subscribe(listener)` and `chooseDirectory()`, never raw IPC or the Electron event argument.
- Main checks the exact WebContents, main frame and expected URL for each IPC call (dispatch and chooseDirectory alike). It validates every command against strict v1 or v2 schemas (selected by the frame's `version`, mirroring core's v2 validation), rejects extra identity/scope fields and prototype keys, bounds payload size/depth and concurrent dispatches, and binds identity itself.
- Production CSP denies all network connections, inline scripts/styles, frames, plugins and form submission. Main additionally restricts asset requests to the renderer directory, blocks navigation and redirects, rejects popup/webview creation, and denies browser permissions. Development relaxations are limited to an explicitly configured loopback Vite origin; packaged builds reject development URLs.
- All `ProviderConfig.apiKey` values are removed from outgoing command snapshots and snapshot events, without mutating gateway storage. Settings accepts newly entered keys in a password field, never reads stored keys back, preserves an existing key when omitted, and offers explicit removal. Core keeps credentials in its protected local SQLite store; storage is not encrypted at rest.
- The gateway owns command deduplication, sessions, message persistence, endpoint validation, credential storage, actual model discovery, task cancellation, tool containment and permission authorization. It must send principal-scoped monotonic events and coherent snapshots. UI permission decisions carry only `requestId/outcome/scope` and cannot change the requested paths, packages or operation.
- The permission modal shows full paths, access modes, packages, capability, reason and session. Approval scopes are once or task only; denial is explicit. Pending approvals disappear on task completion, cancellation or failure. Dialogs trap focus and make the background inert.
- Model/tool/message output is rendered as React text, with safe fenced-code formatting and no HTML interpretation. Streaming and activity buffers are bounded. Composer handles IME, Enter versus Shift+Enter, session-specific drafts, failed commands and disconnected/loading states. Automatic retries only synchronize state; they never resend a message or permission decision.

No frozen contract change is required. Session titles are created by the gateway from the first message; rename is not available in v1. Settings configures supported single-script ACP providers; the production host injects the enforceable Linux launcher. The UI does not implement inference, storage, pairing, network hosting, Python, provider adapters, or an executor.

## Validation

Workspace Vitest tests (`.test.ts`, `npx vitest run apps/desktop`; v2 additions: `security-v2`, `host-v2`, `store-v2`, `standing`, `ui-v2`, `mock-v2`) cover strict command validation, forged sender/identity rejection, origin checks, production CSP, credential redaction, owner event filtering, navigation and asset restrictions, browser permissions, narrow preload APIs, synchronization races/gaps, streamed reply reconciliation, cancellation, permissions, task errors, timeout/disconnect handling, session switching, drafts, deletion confirmation and endpoint settings. UI tests run React with jsdom and the public transport interface.

`test:electron` loads the actual production file URL and bundled preload in Electron, checks sandbox/context isolation/no Node integration, exercises dispatch, verifies identity binding/redaction/forged-command rejection, and checks the rendered DOM and production CSP. It fails if the OS blocks sandbox startup; a sandbox startup failure is not a passing runtime check.

Implementation validation on this worktree: contracts local build passed; desktop strict typecheck and production build passed; all 21 Vitest tests passed both through the workspace command and `npm test -- apps/desktop/tests`; Linux x64 AppImage and amd64 deb packaging passed; compiled mock export dispatch smoke passed. Native Electron/Xvfb smoke was attempted, but startup aborted because the helper is not setuid/root-owned. A user-namespace fallback also aborted with “No usable sandbox!” on this AppArmor-restricted host. T3 browser preview was blocked by the same host sandbox restriction. No sandbox was disabled to obtain a passing check.

Final integration supersedes that initial native-worktree limitation: the root `npm run test:desktop` workflow passed against the real packaged gateway/adapters/executor in a disposable Linux container with both sandboxes enabled, including actual permission dialog, Python calculation, running-worker cancellation, shutdown and SQLite restart. See [validation evidence](../../docs/validation.md).
