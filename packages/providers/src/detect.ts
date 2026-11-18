import { AGENT_CLIS, npmPackageFor, providerIdFor, type AgentCliSpec } from './catalog.js';
import { agentSearchPath, which } from './environment.js';
import { describeInstall, detectInstallMethod, refineInstall, loginPlan, updatePlan, type InstallMethod } from './install.js';
import { compareVersions, parseVersion, probeEnvironment, run } from './process.js';

export type AuthState = 'signed-in' | 'signed-out' | 'unknown';

/** What Your Bot found about one agent CLI on this machine. Plain JSON: safe to send to the renderer or print. */
export interface AgentCliStatus {
  id: string;
  name: string;
  installed: boolean;
  /** PATH entry that was found (a shim or wrapper is kept so updates do not break the link). */
  path?: string;
  version?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  install?: { kind: InstallMethod['kind']; label: string };
  /** Shell-style command that updates it, or why it cannot be updated automatically. */
  update?: { command: string } | { manual: string };
  auth: AuthState;
  /** Shell-style command that signs in, when the CLI has one. */
  login?: string;
  /** Provider id this agent is connected as, if any. */
  providerId: string;
  /** Needs Node's npx for its ACP adapter, and npx was not found. */
  missingNpx?: boolean;
  installHint: string;
  docs: string;
  error?: string;
}

export interface ScanOptions {
  /** Only these catalog ids. Default: every agent. */
  ids?: readonly string[];
  /** Look up the latest published version (network). Default true. */
  checkUpdates?: boolean;
  /** Run each CLI's auth status command. Default true. */
  checkAuth?: boolean;
  /** Override PATH resolution (tests). */
  searchPath?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  probeTimeoutMs?: number;
}

const LATEST_TTL_MS = 60 * 60 * 1000;
const latestCache = new Map<string, { at: number; version?: string }>();

/** Latest version published on npm, cached for an hour. Undefined when offline or unknown. */
export async function latestNpmVersion(pkg: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const cached = latestCache.get(pkg);
  if (cached && Date.now() - cached.at < LATEST_TTL_MS) return cached.version;
  let version: string | undefined;
  try {
    const response = await fetchImpl(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}/latest`, {
      signal: AbortSignal.timeout(4_000), redirect: 'error', headers: { accept: 'application/json' },
    });
    if (response.ok) {
      const body = await response.json() as { version?: unknown };
      if (typeof body.version === 'string' && /^\d+\.\d+\.\d+/.test(body.version)) version = body.version;
    }
  } catch { /* offline: no update information */ }
  latestCache.set(pkg, { at: Date.now(), version });
  return version;
}

async function probeAuth(spec: AgentCliSpec, binary: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<AuthState> {
  if (!spec.auth) return 'unknown';
  const result = await run(binary, spec.auth.args, { env, timeoutMs });
  if (result.timedOut || result.error) return 'unknown';
  const verdict = spec.auth.parse(result);
  return verdict === undefined ? 'unknown' : verdict ? 'signed-in' : 'signed-out';
}

async function scanOne(spec: AgentCliSpec, searchPath: string, options: ScanOptions): Promise<AgentCliStatus> {
  const base: AgentCliStatus = {
    id: spec.id, name: spec.name, installed: false, auth: 'unknown', providerId: providerIdFor(spec.id),
    installHint: spec.install, docs: spec.docs,
  };
  const binary = spec.binaries.map(name => which(name, searchPath, process.platform, options.env ?? process.env)).find(Boolean);
  if (!binary) return base;
  const env = probeEnvironment(searchPath, options.env ?? process.env);
  const timeoutMs = options.probeTimeoutMs ?? 15_000;
  const method = await refineInstall(detectInstallMethod(spec, binary), searchPath);
  const status: AgentCliStatus = {
    ...base, installed: true, path: binary,
    install: { kind: method.kind, label: describeInstall(method) },
    ...(spec.login.length ? { login: loginPlan(spec, binary).display } : {}),
  };
  if (spec.acp.via === 'npx' && !which(process.platform === 'win32' ? 'npx.cmd' : 'npx', searchPath, process.platform, options.env ?? process.env)) status.missingNpx = true;
  const [versionRun, auth] = await Promise.all([
    run(binary, ['--version'], { env, timeoutMs }),
    options.checkAuth === false ? Promise.resolve<AuthState>('unknown') : probeAuth(spec, binary, env, timeoutMs),
  ]);
  const version = parseVersion(`${versionRun.stdout}\n${versionRun.stderr}`);
  if (version) status.version = version;
  else status.error = versionRun.timedOut ? 'Timed out reading its version.' : versionRun.error ?? 'Could not read its version.';
  status.auth = auth;
  const pkg = method.kind === 'npm' ? method.package : npmPackageFor(spec, version);
  const update = updatePlan(spec, method, binary, pkg);
  status.update = 'manual' in update ? { manual: update.manual } : { command: update.display };
  const latest = options.checkUpdates === false || !pkg ? undefined : await latestNpmVersion(pkg, options.fetch);
  // A registry "latest" older than the install means the CLI moved elsewhere; report nothing rather than a downgrade.
  if (latest && (!version || compareVersions(latest, version) >= 0)) {
    status.latestVersion = latest;
    if (version) status.updateAvailable = compareVersions(latest, version) > 0;
  }
  return status;
}

/** Find every catalog agent CLI on this machine. Never installs or changes anything. */
export async function scanAgentClis(options: ScanOptions = {}): Promise<AgentCliStatus[]> {
  const searchPath = options.searchPath ?? await agentSearchPath(options.env ?? process.env);
  const specs = options.ids ? AGENT_CLIS.filter(spec => options.ids!.includes(spec.id)) : AGENT_CLIS;
  return Promise.all(specs.map(spec => scanOne(spec, searchPath, options).catch(error => ({
    id: spec.id, name: spec.name, installed: false, auth: 'unknown' as const, providerId: providerIdFor(spec.id),
    installHint: spec.install, docs: spec.docs, error: error instanceof Error ? error.message : 'Scan failed',
  }))));
}
