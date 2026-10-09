# Your Bot desktop

Standalone Electron 44.7 / React / Vite 8 / strict TypeScript application for the frozen v1 contracts at `b133e1d`. All source and configuration for this workspace lives under `apps/desktop`.

The renderer receives only `BackendTransport.dispatch/subscribe`. It has no core, provider, executor, Python, Node, filesystem, or identity API. The included Electron executable deliberately reports a disconnected backend until the parent integrates a gateway. Browser demo mode is explicit and in memory.

## Run and build

From the repository root, using Node >=22.13:

```sh
npm install
npm run build -w @your-bot/contracts
npm run test -w @your-bot/desktop
npm run build -w @your-bot/desktop
npm run dev -w @your-bot/desktop
```

`dev` builds Electron main/preload and starts loopback Vite with renderer HMR. Restart it after changing main/preload. `start` runs a previously built Electron application. `dev:browser` starts Vite alone: open `http://127.0.0.1:5173/?demo=1` for the mock demonstration, or omit the query to inspect disconnected behavior. Typing “Read my workspace” in the demonstration exercises an exact-path permission dialog, simulated tool output, streaming and cancellation. No demo operation reads files, installs packages, launches processes, or contacts providers.

```sh
npm run package -w @your-bot/desktop      # Linux AppImage + deb
npm run package:dir -w @your-bot/desktop  # unpacked Linux application
npm run test:electron -w @your-bot/desktop # actual Electron/Xvfb smoke check; build first
```

Artifacts are in `apps/desktop/release/`. The builder configuration pins Electron 44.7.0, enables ASAR, and includes the compiled renderer, main and sandbox preload. Packaging uses the workspace root's locally installed dependencies; the parent must update the root lockfile during integration. For final packaging, rebuild after wiring the actual gateway into the main entrypoint.

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

// Replace with the parent's actual factory; no implementation is assumed here.
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

Wire the factory in `src/main/entry.ts` and include the parent's dependencies in this package before rebuilding; the current disconnected factory is intentional. The host bundle includes its dependencies; it excludes Electron. Avoid importing `@your-bot/desktop` from the renderer.

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

## Security and gateway expectations

- Preload is bundled CommonJS, compatible with `sandbox: true`. `window.yourBot` exposes exactly `dispatch(command)` and `subscribe(listener)`, never raw IPC or the Electron event argument.
- Main checks the exact WebContents, main frame and expected URL for each IPC call. It validates every command against strict v1 schemas, rejects extra identity/scope fields and prototype keys, bounds payload size/depth and concurrent dispatches, and binds identity itself.
- Production CSP denies all network connections, inline scripts/styles, frames, plugins and form submission. Main additionally restricts asset requests to the renderer directory, blocks navigation and redirects, rejects popup/webview creation, and denies browser permissions. Development relaxations are limited to an explicitly configured loopback Vite origin; packaged builds reject development URLs.
- All `ProviderConfig.apiKey` values are removed from outgoing command snapshots and snapshot events, without mutating gateway storage. Provider settings UI edits endpoints and configuration; it never displays or requests API keys. The parent manages credentials in its protected local store and should preserve an existing key when `settings.update` omits `apiKey`. No credential-management extension to the frozen contract was added.
- The gateway owns command deduplication, sessions, message persistence, endpoint validation, credential storage, actual model discovery, task cancellation, tool containment and permission authorization. It must send principal-scoped monotonic events and coherent snapshots. UI permission decisions carry only `requestId/outcome/scope` and cannot change the requested paths, packages or operation.
- The permission modal shows full paths, access modes, packages, capability, reason and session. Approval scopes are once or task only; denial is explicit. Pending approvals disappear on task completion, cancellation or failure. Dialogs trap focus and make the background inert.
- Model/tool/message output is rendered as React text, with safe fenced-code formatting and no HTML interpretation. Streaming and activity buffers are bounded. Composer handles IME, Enter versus Shift+Enter, session-specific drafts, failed commands and disconnected/loading states. Automatic retries only synchronize state; they never resend a message or permission decision.

No frozen contract change is required. Session titles are created by the gateway; rename is not available in v1. Existing ACP launch command/args are preserved in settings, and process containment remains the parent's responsibility. The UI does not implement inference, storage, pairing, network hosting, Python, provider adapters, or an executor.

## Validation

Workspace Vitest tests (`.test.ts`) cover strict command validation, forged sender/identity rejection, origin checks, production CSP, credential redaction, owner event filtering, navigation and asset restrictions, browser permissions, narrow preload APIs, synchronization races/gaps, streamed reply reconciliation, cancellation, permissions, task errors, timeout/disconnect handling, session switching, drafts, deletion confirmation and endpoint settings. UI tests run React with jsdom and the public transport interface.

`test:electron` loads the actual production file URL and bundled preload in Electron, checks sandbox/context isolation/no Node integration, exercises dispatch, verifies identity binding/redaction/forged-command rejection, and checks the rendered DOM and production CSP. It fails if the OS blocks sandbox startup; a sandbox startup failure is not a passing runtime check.

Implementation validation on this worktree: contracts local build passed; desktop strict typecheck and production build passed; all 21 Vitest tests passed both through the workspace command and `npm test -- apps/desktop/tests`; Linux x64 AppImage and amd64 deb packaging passed; compiled mock export dispatch smoke passed. Native Electron/Xvfb smoke was attempted, but startup aborted because the helper is not setuid/root-owned. A user-namespace fallback also aborted with “No usable sandbox!” on this AppArmor-restricted host. T3 browser preview was blocked by the same host sandbox restriction. No sandbox was disabled to obtain a passing check.
