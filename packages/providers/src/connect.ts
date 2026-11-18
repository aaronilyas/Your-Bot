import path from 'node:path';
import type { AppSettingsV2, ProviderConfigV2 } from '@your-bot/contracts';
import { agentSpec, providerIdFor, type AgentCliSpec } from './catalog.js';
import { agentSearchPath, which } from './environment.js';
import type { AgentCliStatus } from './detect.js';
import { latestNpmVersion } from './detect.js';

const base = (command: string | undefined) => (command ? path.basename(command.replace(/\\/g, '/')) : '').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();

/**
 * The provider already linked to this agent: the catalog id, else a host-launched provider whose command
 * is this CLI (e.g. one added by hand as `grok` + `agent stdio`) or whose npx args name its ACP adapter.
 * Bots refer to providers by id, so an existing match is updated in place, never replaced.
 */
export function linkedProvider(providers: readonly ProviderConfigV2[], spec: AgentCliSpec): ProviderConfigV2 | undefined {
  const byId = providers.find(provider => provider.id === providerIdFor(spec.id));
  if (byId) return byId;
  return providers.find(provider => {
    if (provider.kind !== 'acp' || provider.launch !== 'host') return false;
    if (spec.binaries.some(name => base(provider.command) === name.toLowerCase())) return true;
    const acp = spec.acp;
    return acp.via === 'npx' && (provider.args ?? []).some(arg => arg === acp.package || arg.startsWith(`${acp.package}@`));
  });
}

export interface ConnectOptions {
  searchPath?: string;
  fetch?: typeof fetch;
}

/** Host-launch ACP provider settings for a detected agent CLI. Throws with a user-facing message when it cannot be linked. */
export async function providerFor(status: AgentCliStatus, options: ConnectOptions = {}): Promise<ProviderConfigV2> {
  const spec = agentSpec(status.id);
  if (!spec) throw new Error(`Unknown agent ${status.id}`);
  if (!status.installed || !status.path) throw new Error(`${spec.name} is not installed. Install it with: ${spec.install}`);
  const provider: ProviderConfigV2 = {
    id: providerIdFor(spec.id), name: spec.name, kind: 'acp', launch: 'host', enabled: true,
    command: status.path, args: [],
    ...(spec.env.length ? { envPassthrough: [...spec.env] } : {}),
  };
  if (spec.acp.via === 'self') provider.args = [...spec.acp.args];
  else {
    const searchPath = options.searchPath ?? await agentSearchPath();
    const npx = which(process.platform === 'win32' ? 'npx.cmd' : 'npx', searchPath);
    if (!npx) throw new Error(`${spec.name} connects through the ${spec.acp.package} adapter, which needs Node.js (npx). Install Node.js 22 or later.`);
    // Pin the adapter to the newest release so runs are reproducible and work offline; "Update" re-pins it.
    const version = await latestNpmVersion(spec.acp.package, options.fetch);
    provider.command = npx;
    provider.args = ['-y', version ? `${spec.acp.package}@${version}` : spec.acp.package, ...(spec.acp.args ?? [])];
  }
  return provider;
}

/**
 * Settings with the agent linked. An existing link keeps its id, name, enabled flag and model; launch
 * details are refreshed. API keys are never part of a host-launched provider.
 */
export function withLinkedProvider(settings: AppSettingsV2, provider: ProviderConfigV2): { settings: AppSettingsV2; providerId: string; created: boolean } {
  const spec = agentSpec(provider.id.replace(/^agent-/, ''));
  const existing = spec ? linkedProvider(settings.providers, spec) : settings.providers.find(entry => entry.id === provider.id);
  const providers = settings.providers.map(({ apiKey: _key, ...entry }) => entry as ProviderConfigV2);
  if (!existing) return { settings: { providers: [...providers, provider] }, providerId: provider.id, created: true };
  const merged: ProviderConfigV2 = {
    ...existing, kind: 'acp', launch: 'host', command: provider.command, args: provider.args,
    envPassthrough: [...new Set([...(existing.envPassthrough ?? []), ...(provider.envPassthrough ?? [])])],
  };
  delete merged.apiKey;
  if (!merged.envPassthrough?.length) delete merged.envPassthrough;
  return { settings: { providers: providers.map(entry => entry.id === existing.id ? merged : entry) }, providerId: existing.id, created: false };
}

/** Marks each status with the id of the provider it is linked as, if any. */
export function annotateLinks(statuses: AgentCliStatus[], providers: readonly ProviderConfigV2[]): (AgentCliStatus & { linked: boolean })[] {
  return statuses.map(status => {
    const spec = agentSpec(status.id);
    const linked = spec ? linkedProvider(providers, spec) : undefined;
    return { ...status, providerId: linked?.id ?? status.providerId, linked: Boolean(linked) };
  });
}
