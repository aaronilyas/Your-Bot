import { join } from 'node:path';
import type { AppSettingsV2, CapabilityV2, DesktopGatewayV2, DeviceManager, Notifier, PrincipalV2, SecretCipher, SkillCatalog } from '@your-bot/contracts';
import { createGatewayV2, type GatewayOptions } from '@your-bot/core';
import { BubblewrapContainmentLauncher, createAdapters, type AdapterFactoryOptions } from '@your-bot/adapters';
import { createToolExecutor } from '@your-bot/executor';
import { createWorkspaceHost } from '@your-bot/workspace';
import { createRemoteHost, type RemoteHost } from '@your-bot/remote';
import { createSkillCatalog } from '@your-bot/skills';
import { createFileCipher } from '@your-bot/secrets';
import { prepareDataLayout } from './files.js';
import { createHostMcpBroker } from './mcp-host.js';

/** Local owner capabilities. `mcp.call` is included; remote devices do not receive `settings`. */
export const LOCAL_OWNER_CAPABILITIES: readonly CapabilityV2[] = [
  'conversation', 'settings', 'tool.execute', 'file.read', 'file.write', 'file.delete',
  'library.install', 'network', 'process.spawn', 'mcp.call',
];

/** P4 routine scheduler clock. Wall time when omitted. */
export interface RuntimeClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}


export interface RuntimeListen { host: string; port: number; }

export interface RuntimeOptions {
  /** Application data directory. Created as mode 0700. */
  dataDir: string;
  /** Local owner principal id. Default `local-owner`. Bound to the database on first open. */
  principalId?: string;
  /** Display name stored in host.json. Default: the saved name, else the OS hostname. */
  hostName?: string;
  /** Encrypts provider and MCP secrets. Default: AES-GCM file cipher, key in `<data>/keys` (not the DB directory). */
  secretCipher?: SecretCipher;
  /** P4: owner notifications (approval required, routine outcomes). */
  notifier?: Notifier;
  /** P4: routine scheduler clock. */
  clock?: RuntimeClock;
  /** P4: capabilities of the principal routines run as. Core's default applies when omitted. */
  routineCapabilities?: CapabilityV2[];
  /** When set, listen for paired devices. Omit to leave the remote host disabled. */
  listen?: RuntimeListen;
  /** Host-launched and contained ACP turn timeout. */
  acpTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

export interface RuntimeRemote {
  /** Lowercase hex SHA-256 of the TLS certificate. */
  fingerprint: string;
  /** Identity the remote protocol announces. Independent of `Runtime.host.id` (the gateway host id). */
  hostId: string;
  address: { host: string; port: number; urls: string[] };
}

export interface Runtime {
  readonly dataDir: string;
  readonly gateway: DesktopGatewayV2;
  readonly principal: PrincipalV2;
  /** Persisted random id and display name (`<data>/host.json`). */
  readonly host: { id: string; name: string };
  readonly remote?: RuntimeRemote;
  /** Idempotent. Closes the remote host first, then the gateway (which closes the workspace host and MCP broker). */
  close(): Promise<void>;
}

/**
 * Strict Linux containment, same rule as `apps/desktop/src/main/backend.ts`.
 * `createAdapters` adds an uncontained HostLauncher when `ProviderConfigV2.launch === 'host'`
 * and strips containment for that provider, so a host-launched agent is never bubblewrapped.
 */
function adapterOptions(settings: AppSettingsV2, acpTimeoutMs: number | undefined): AdapterFactoryOptions {
  const acpByProvider: NonNullable<AdapterFactoryOptions['acpByProvider']> = Object.fromEntries(settings.providers
    .filter(provider => process.platform === 'linux' && process.arch === 'x64' && provider.kind === 'acp' && provider.args?.length === 1 && /^\/.*\.(mjs|py)$/.test(provider.args[0] ?? ''))
    .map(provider => [provider.id, { containment: new BubblewrapContainmentLauncher({ scriptPath: provider.args![0]! }) }]));
  return { acpByProvider, ...(acpTimeoutMs !== undefined ? { acp: { timeoutMs: acpTimeoutMs } } : {}) };
}

function listenOptions(listen: RuntimeListen | undefined): RuntimeListen | undefined {
  if (!listen) return undefined;
  if (typeof listen.host !== 'string' || !listen.host || listen.host.length > 255) throw new Error('listen.host is invalid');
  if (!Number.isInteger(listen.port) || listen.port < 0 || listen.port > 65535) throw new Error('listen.port is invalid');
  return listen;
}

/**
 * One composition for the desktop app and the headless host: gateway, managed Python executor,
 * workspace host, preset-expanding MCP broker, skill catalog, secret cipher and (optionally) the remote host.
 * The returned gateway's `close` is the runtime close, so a host that only holds the gateway still
 * shuts the remote listener down first.
 */
export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  if (!options?.dataDir || typeof options.dataDir !== 'string') throw new Error('dataDir is required');
  if (options.acpTimeoutMs !== undefined && (!Number.isSafeInteger(options.acpTimeoutMs) || options.acpTimeoutMs <= 0)) throw new Error('acpTimeoutMs is invalid');
  const listen = listenOptions(options.listen);
  const layout = await prepareDataLayout(options.dataDir, options.hostName);
  const secretCipher = options.secretCipher ?? createFileCipher({ keyPath: join(layout.dataDir, 'keys', 'secret.key') });
  const capabilities: CapabilityV2[] = [...LOCAL_OWNER_CAPABILITIES];
  Object.freeze(capabilities);
  const principal = Object.freeze<PrincipalV2>({
    id: options.principalId ?? 'local-owner', kind: 'local', capabilities,
  });
  const skillCatalog = createSkillCatalog({ globalDir: layout.skillsDir });
  const workspaceHost = createWorkspaceHost();
  const mcpBroker = createHostMcpBroker(layout.browserCwd);
  const executor = createToolExecutor({ environmentRoot: layout.pythonDir });
  // The remote host needs the gateway, and the gateway needs a DeviceManager. The proxy
  // forwards to the listener once `createRemoteHost` has assigned it.
  const holder: { remote?: RemoteHost } = {};
  const devices: DeviceManager | undefined = listen ? {
    startPairing: input => holder.remote ? holder.remote.deviceManager.startPairing(input) : Promise.reject(new Error('Remote host is not listening')),
    list: () => holder.remote ? holder.remote.deviceManager.list() : Promise.resolve([]),
    revoke: id => holder.remote ? holder.remote.deviceManager.revoke(id) : Promise.reject(new Error('Remote host is not listening')),
  } : undefined;
  const gatewayOptions: GatewayOptions = {
    databasePath: join(layout.gatewayDir, 'history.sqlite'),
    localPrincipalId: principal.id,
    executor,
    workspaceHost,
    mcpBroker,
    secretCipher,
    host: layout.host,
    skillCatalog,
    onSettingsChanged: settings => createAdapters(settings.providers, adapterOptions(settings, options.acpTimeoutMs)),
    cleanupTimeoutMs: options.cleanupTimeoutMs ?? 5000,
    ...(devices ? { devices } : {}),
    ...(options.notifier ? { notifier: options.notifier } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.routineCapabilities ? { routineCapabilities: [...options.routineCapabilities] } : {}),
  };
  let gateway: DesktopGatewayV2 | undefined;
  try {
    gateway = await createGatewayV2(gatewayOptions);
    if (listen) {
      holder.remote = await createRemoteHost({
        gateway, ownerId: principal.id, dataDir: join(layout.dataDir, 'remote'), listen, hostName: layout.host.name,
      });
    }
  } catch (error) {
    if (holder.remote) await holder.remote.close().catch(() => undefined);
    // createGatewayV2 already closed a gateway whose initialize() failed. Close only one we received.
    if (gateway) await gateway.close().catch(() => undefined);
    throw error;
  }
  const opened = gateway;
  const remote = holder.remote;
  const gatewayClose = opened.close.bind(opened);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    // Remote first. The gateway closes the workspace host and the MCP broker; do not close them again.
    try { if (remote) await remote.close(); }
    finally { await gatewayClose(); }
  })();
  opened.close = close;
  return {
    dataDir: layout.dataDir, gateway: opened, principal, host: layout.host, close,
    ...(remote ? { remote: { fingerprint: remote.fingerprint, hostId: remote.hostId, address: remote.address } } : {}),
  };
}
