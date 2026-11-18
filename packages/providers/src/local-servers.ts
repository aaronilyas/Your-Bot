import type { ProviderConfigV2 } from '@your-bot/contracts';

/** OpenAI-compatible model servers that commonly run on this machine. */
export const LOCAL_SERVERS = Object.freeze([
  { id: 'lmstudio', name: 'LM Studio', kind: 'lmstudio', endpoint: 'http://127.0.0.1:1234/v1' },
  { id: 'ollama', name: 'Ollama', kind: 'openai-compatible', endpoint: 'http://127.0.0.1:11434/v1' },
  { id: 'llamacpp', name: 'llama.cpp', kind: 'llamacpp', endpoint: 'http://127.0.0.1:8080/v1' },
] as const);

export interface LocalServerStatus {
  id: string;
  name: string;
  endpoint: string;
  running: boolean;
  models: string[];
  providerId: string;
  linked: boolean;
}

/** Loopback-only `GET /models` probes. A server that is not running is reported, not an error. */
export async function scanLocalServers(providers: readonly ProviderConfigV2[] = [], fetchImpl: typeof fetch = fetch): Promise<LocalServerStatus[]> {
  return Promise.all(LOCAL_SERVERS.map(async server => {
    let running = false; let models: string[] = [];
    try {
      const response = await fetchImpl(`${server.endpoint}/models`, { signal: AbortSignal.timeout(1_500), redirect: 'error' });
      if (response.ok) {
        running = true;
        const body = await response.json() as { data?: { id?: unknown }[] };
        models = (body.data ?? []).map(entry => entry.id).filter((value): value is string => typeof value === 'string').slice(0, 50);
      }
    } catch { /* not running */ }
    const linked = providers.find(provider => provider.id === `local-${server.id}` || (provider.kind !== 'acp' && provider.endpoint?.replace(/\/+$/, '') === server.endpoint));
    return { id: server.id, name: server.name, endpoint: server.endpoint, running, models, providerId: linked?.id ?? `local-${server.id}`, linked: Boolean(linked) };
  }));
}

export function localServerProvider(id: string): ProviderConfigV2 {
  const server = LOCAL_SERVERS.find(entry => entry.id === id);
  if (!server) throw new Error(`Unknown local server ${id}`);
  return { id: `local-${server.id}`, name: server.name, kind: server.kind, endpoint: server.endpoint, enabled: true };
}
