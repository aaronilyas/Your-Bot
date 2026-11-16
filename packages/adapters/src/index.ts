import type { AgentAdapter, ProviderConfig, ProviderConfigV2 } from '@your-bot/contracts';
import { AcpAdapter, type AcpAdapterOptions } from './acp.js';
import { HostLauncher } from './host-launcher.js';
import { OpenAICompatibleAdapter, type LocalAdapterOptions } from './local.js';
import { AdapterError } from './errors.js';

export { AcpAdapter } from './acp.js';
export type { AcpAdapterOptions } from './acp.js';
export { HostLauncher } from './host-launcher.js';
export type { HostLaunchRequest, HostedAgent } from './host-launcher.js';
export { OpenAICompatibleAdapter } from './local.js';
export type { LocalAdapterOptions } from './local.js';
export type { ContainedHarness, ContainmentLauncher, HarnessLaunchRequest, NativePermissionPlan } from './containment.js';
export { BubblewrapContainmentLauncher } from './bubblewrap.js';
export type { BubblewrapContainmentOptions } from './bubblewrap.js';
export { AdapterError, normalizeAdapterError } from './errors.js';
export { parseSse } from './sse.js';
export { parseToolInvocation, TOOL_DEFINITION } from './tools.js';

export interface AdapterFactoryOptions {
  local?: LocalAdapterOptions;
  acp?: AcpAdapterOptions;
  /** Per-provider host policy, useful when harnesses need different readonly runtimes. */
  acpByProvider?: Readonly<Record<string, AcpAdapterOptions>>;
}

function acpOptions(config: ProviderConfig, options: AdapterFactoryOptions): AcpAdapterOptions {
  const merged: AcpAdapterOptions = { ...options.acp, ...options.acpByProvider?.[config.id] };
  if ((config as ProviderConfigV2).launch !== 'host') return merged;
  const { containment: _containment, launcher: _launcher, host, envPassthrough, ...rest } = merged;
  const names = (config as ProviderConfigV2).envPassthrough ?? envPassthrough;
  return { ...rest, host: host ?? new HostLauncher(), ...(names ? { envPassthrough: names } : {}) };
}

/** One independent adapter per provider ID; includes disabled providers for settings visibility. */
export function createAdapters(configs: readonly ProviderConfig[], options: AdapterFactoryOptions = {}): AgentAdapter[] {
  const ids = new Set<string>();
  return configs.map(config => {
    if (!config.id || ids.has(config.id) || !['acp', 'lmstudio', 'llamacpp', 'openai-compatible'].includes(config.kind)) throw new AdapterError('INVALID_CONFIG', 'Provider IDs must be unique and provider kinds supported.');
    ids.add(config.id);
    return config.kind === 'acp'
      ? new AcpAdapter(config, acpOptions(config, options))
      : new OpenAICompatibleAdapter(config, options.local);
  });
}
