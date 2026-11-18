/** Only these fixed channels are ever exposed through the preload. */
export const IPC = {
  dispatch: 'your-bot:dispatch', event: 'your-bot:event', chooseDirectory: 'your-bot:choose-directory', loadAppearance: 'your-bot:appearance-load', saveAppearance: 'your-bot:appearance-save',
  providersScan: 'your-bot:providers-scan', providersLink: 'your-bot:providers-link', providersUpdate: 'your-bot:providers-update', providersLogin: 'your-bot:providers-login',
} as const;

/** Plain-JSON shapes of @your-bot/providers results as the renderer sees them. The renderer only ever sends catalog ids. */
export interface AgentRowInfo {
  id: string; name: string; installed: boolean; path?: string; version?: string; latestVersion?: string; updateAvailable?: boolean;
  install?: { kind: string; label: string };
  update?: { command: string } | { manual: string };
  auth: 'signed-in' | 'signed-out' | 'unknown';
  login?: string; providerId: string; linked: boolean; missingNpx?: boolean; installHint: string; docs: string; error?: string;
}
export interface LocalServerInfo { id: string; name: string; endpoint: string; running: boolean; models: string[]; providerId: string; linked: boolean }
export interface ProvidersScanResult { agents: AgentRowInfo[]; servers: LocalServerInfo[] }
export interface ProvidersLinkResult { linked: { id: string; name: string; providerId: string; created: boolean }[]; skipped: { id: string; reason: string }[]; error?: string }
export interface ProvidersUpdateResult { ok: boolean; message: string; output: string; command?: string; status?: AgentRowInfo }
export interface ProvidersLoginResult { ok: boolean; message?: string }
/** Detection and one-click connect for agent CLIs and local model servers. Arguments are catalog ids only. */
export interface ProvidersApi {
  scan(): Promise<ProvidersScanResult>;
  link(targets: string[] | 'all'): Promise<ProvidersLinkResult>;
  update(id: string): Promise<ProvidersUpdateResult>;
  login(id: string): Promise<ProvidersLoginResult>;
}
