/** Only these fixed channels are ever exposed through the preload. */
export const IPC = {
  dispatch: 'your-bot:dispatch', event: 'your-bot:event', chooseDirectory: 'your-bot:choose-directory', loadAppearance: 'your-bot:appearance-load', saveAppearance: 'your-bot:appearance-save',
  providersScan: 'your-bot:providers-scan', providersLink: 'your-bot:providers-link', providersUpdate: 'your-bot:providers-update', providersLogin: 'your-bot:providers-login',
  updatesStatus: 'your-bot:updates-status', updatesCheck: 'your-bot:updates-check', updatesInstall: 'your-bot:updates-install', updatesOpenRelease: 'your-bot:updates-open-release', updatesSetAutoCheck: 'your-bot:updates-auto-check', updatesProgress: 'your-bot:updates-progress',
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

/* ------------------------------------------------------------ app updates */
/** How this copy of Your Bot was installed, which decides how a release is applied. */
export type InstallKind = 'appimage' | 'deb' | 'rpm' | 'pacman' | 'mac' | 'nsis' | 'manual' | 'development';
export interface InstallInfo { kind: InstallKind; label: string; canInstall: boolean; reason?: string }
/** A published release as the renderer sees it: no URLs, only what the panel shows. The tag is the only handle sent back. */
export interface ReleaseSummary {
  tag: string; version: string; name: string; publishedAt: string; prerelease: boolean; notes: string;
  /** This release has an installer for this computer's install type and CPU. */
  installable: boolean;
  relation: 'newer' | 'current' | 'older';
}
export interface UpdateStatus { currentVersion: string; install: InstallInfo; autoCheck: boolean }
export interface UpdateCheckResult extends UpdateStatus {
  checkedAt: string;
  /** Newest first. */
  releases: ReleaseSummary[];
  /** Tag of the newest stable release, when there is one. */
  latest?: string;
  updateAvailable: boolean;
  error?: string;
}
export interface UpdateProgress { tag: string; phase: 'downloading' | 'verifying' | 'installing' | 'restarting'; received?: number; total?: number }
export interface UpdateInstallResult {
  ok: boolean; message: string; output?: string; restarting?: boolean;
  /** When the install needs administrator rights the app could not ask for: the exact command to run in a terminal. */
  command?: string;
}
/** In-app updates from the project's GitHub releases. The renderer only ever sends a release tag or a boolean. */
export interface UpdatesApi {
  /** No network: current version, install type and preference. */
  status(): Promise<UpdateStatus>;
  /** Lists releases (cached for a few minutes unless `force`). */
  check(force?: boolean): Promise<UpdateCheckResult>;
  /** Download, verify and install the release with this tag (newer or older), then restart. */
  install(tag: string): Promise<UpdateInstallResult>;
  /** Opens the release's GitHub page in the default browser. */
  openRelease(tag?: string): Promise<boolean>;
  setAutoCheck(enabled: boolean): Promise<boolean>;
  onProgress(listener: (progress: UpdateProgress) => void): () => void;
}
