import type { AppSettingsV2, ProviderConfigV2 } from '@your-bot/contracts';
import { AGENT_CLIS, agentSpec } from './catalog.js';
import { annotateLinks, providerFor, withLinkedProvider } from './connect.js';
import { scanAgentClis, type AgentCliStatus, type ScanOptions } from './detect.js';
import { agentSearchPath } from './environment.js';
import { LOCAL_SERVERS, localServerProvider, scanLocalServers, type LocalServerStatus } from './local-servers.js';

export type AgentRow = AgentCliStatus & { linked: boolean };
export interface ProviderScan { agents: AgentRow[]; servers: LocalServerStatus[] }

/** Everything Settings → Providers and `your-bot providers list` show. */
export async function scanProviders(providers: readonly ProviderConfigV2[], options: ScanOptions = {}): Promise<ProviderScan> {
  const [agents, servers] = await Promise.all([
    scanAgentClis(options),
    scanLocalServers(providers, options.fetch),
  ]);
  return { agents: annotateLinks(agents, providers), servers };
}

export interface LinkSummary {
  settings: AppSettingsV2;
  linked: { id: string; name: string; providerId: string; created: boolean }[];
  skipped: { id: string; reason: string }[];
}

/**
 * Link agent CLIs and running local model servers as providers. `targets` are catalog ids
 * (`claude`, `ollama`, ...) or `all`, which links every installed agent and running server.
 * Pure settings transform: the caller saves the result with `settings.update`.
 */
export async function linkProviders(settings: AppSettingsV2, targets: readonly string[] | 'all', options: ScanOptions = {}): Promise<LinkSummary> {
  const all = targets === 'all';
  const wanted = all ? [...AGENT_CLIS.map(spec => spec.id), ...LOCAL_SERVERS.map(server => server.id)] : [...new Set(targets)];
  const summary: LinkSummary = { settings, linked: [], skipped: [] };
  const agentIds = wanted.filter(id => agentSpec(id));
  const serverIds = wanted.filter(id => LOCAL_SERVERS.some(server => server.id === id));
  for (const id of wanted) if (!agentIds.includes(id) && !serverIds.includes(id)) summary.skipped.push({ id, reason: 'Not a known agent or model server.' });
  const searchPath = options.searchPath ?? await agentSearchPath(options.env ?? process.env);
  const statuses = agentIds.length ? await scanAgentClis({ ...options, ids: agentIds, searchPath, checkAuth: false, checkUpdates: false }) : [];
  for (const status of statuses) {
    if (!status.installed) { if (!all) summary.skipped.push({ id: status.id, reason: `${status.name} is not installed. Install it with: ${status.installHint}` }); continue; }
    try {
      const provider = await providerFor(status, { searchPath, ...(options.fetch ? { fetch: options.fetch } : {}) });
      const result = withLinkedProvider(summary.settings, provider);
      summary.settings = result.settings;
      summary.linked.push({ id: status.id, name: status.name, providerId: result.providerId, created: result.created });
    } catch (error) { summary.skipped.push({ id: status.id, reason: error instanceof Error ? error.message : 'Could not link it.' }); }
  }
  if (serverIds.length) {
    const servers = await scanLocalServers(summary.settings.providers, options.fetch);
    for (const server of servers.filter(entry => serverIds.includes(entry.id))) {
      if (server.linked) { summary.linked.push({ id: server.id, name: server.name, providerId: server.providerId, created: false }); continue; }
      if (!server.running) { if (!all) summary.skipped.push({ id: server.id, reason: `${server.name} is not running at ${server.endpoint}. Start it and load a model first.` }); continue; }
      const provider = localServerProvider(server.id);
      summary.settings = { providers: [...summary.settings.providers.map(({ apiKey: _key, ...entry }) => entry as ProviderConfigV2), provider] };
      summary.linked.push({ id: server.id, name: server.name, providerId: provider.id, created: true });
    }
  }
  return summary;
}
