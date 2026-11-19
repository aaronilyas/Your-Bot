import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { InstallInfo, InstallKind, ReleaseSummary, UpdateCheckResult, UpdateInstallResult, UpdateProgress, UpdateStatus } from '../shared/ipc';

/**
 * In-app updates and reverts from the project's GitHub releases.
 *
 * The renderer only sends a release tag. Everything else is decided here: which release asset matches this install
 * (AppImage, deb, rpm, pacman, macOS zip, Windows installer), where it is downloaded from (GitHub only, HTTPS only),
 * and how it is applied. Every download must match the SHA-256 listed in the same release's SHA256SUMS.txt before
 * anything is installed. Nothing about the user, their bots or their data is sent; the only requests are the public
 * release list and the chosen release's files.
 */

export const REPOSITORY = 'aaronilyas/Your-Bot';
const RELEASES_API = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=50`;
const RELEASE_PAGE = `https://github.com/${REPOSITORY}/releases`;
const DOWNLOAD_PREFIX = `https://github.com/${REPOSITORY}/releases/download/`;
/** Hosts a release download may be served from after GitHub's redirect. */
const DOWNLOAD_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com']);
const CHECKSUMS = 'SHA256SUMS.txt';
const MAX_ASSET_BYTES = 1024 * 1024 * 1024;
const CACHE_MS = 5 * 60 * 1000;
const PACKAGE = 'your-bot';
/** A failure whose message is written for the user. */
class UpdateError extends Error {}

export const TAG = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,64})?)$/;

export interface RunOutcome { code: number | null; stdout: string; stderr: string; error?: string }
export interface UpdaterDeps {
  currentVersion: string;
  packaged: boolean;
  platform: NodeJS.Platform;
  arch: string;
  execPath: string;
  env: NodeJS.ProcessEnv;
  /** Holds updates.json (the automatic-check preference). */
  dataDir: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Runs a program without a shell and waits for it. */
  run(file: string, args: string[], options?: { timeoutMs?: number }): Promise<RunOutcome>;
  /** Starts a program that outlives this process. */
  spawnDetached(file: string, args: string[]): Promise<void>;
  openExternal(url: string): Promise<void>;
  relaunch(options?: { execPath?: string; args?: string[] }): void;
  quit(): void;
  pid?: number;
  tmpdir?: string;
  /** Where to look for pkexec (polkit), which asks for the administrator password for system packages. */
  pkexecPaths?: string[];
  /** Delay between answering the renderer and quitting, so the reply is delivered. */
  quitDelayMs?: number;
}

interface ReleaseAsset { name: string; size: number; url: string }
interface Release extends ReleaseSummary { page: string; asset?: ReleaseAsset; checksums?: ReleaseAsset }

export interface Updater {
  status(): Promise<UpdateStatus>;
  check(force?: boolean): Promise<UpdateCheckResult>;
  install(tag: string, onProgress?: (progress: UpdateProgress) => void): Promise<UpdateInstallResult>;
  openRelease(tag?: string): Promise<boolean>;
  setAutoCheck(enabled: boolean): Promise<boolean>;
}

/* ------------------------------------------------------------ versions */

/** Semantic-version order: numeric core, then a prerelease sorts before its release. */
export function compareSemver(a: string, b: string): number {
  const split = (value: string) => { const [core, pre] = value.replace(/^v/, '').split('-', 2) as [string, string | undefined]; return { core: core.split('.').map(part => Number.parseInt(part, 10) || 0), pre }; };
  const left = split(a), right = split(b);
  for (let index = 0; index < 3; index++) { const diff = (left.core[index] ?? 0) - (right.core[index] ?? 0); if (diff) return Math.sign(diff); }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  const l = left.pre.split('.'), r = right.pre.split('.');
  for (let index = 0; index < Math.max(l.length, r.length); index++) {
    if (l[index] === undefined) return -1; if (r[index] === undefined) return 1;
    const ln = /^\d+$/.test(l[index]!) ? Number(l[index]) : undefined, rn = /^\d+$/.test(r[index]!) ? Number(r[index]) : undefined;
    if (ln !== undefined && rn !== undefined) { if (ln !== rn) return Math.sign(ln - rn); continue; }
    if (ln !== undefined) return -1; if (rn !== undefined) return 1;
    if (l[index] !== r[index]) return l[index]! < r[index]! ? -1 : 1;
  }
  return 0;
}

/* ------------------------------------------------------------ install detection */

const LABELS: Record<InstallKind, string> = {
  appimage: 'AppImage', deb: 'Debian/Ubuntu package (.deb)', rpm: 'RPM package', pacman: 'Arch package (pacman)', mac: 'macOS app',
  nsis: 'Windows installer', manual: 'Portable copy', development: 'Development build',
};
const info = (kind: InstallKind, extra: Partial<InstallInfo> = {}): InstallInfo => ({ kind, label: LABELS[kind], canInstall: true, ...extra });
const writable = async (target: string): Promise<boolean> => { try { await access(target, constants.W_OK); return true; } catch { return false; } };
const exists = async (target: string): Promise<boolean> => { try { await access(target); return true; } catch { return false; } };

/** Where the running app came from. Only package kinds this module knows how to replace can install in-app. */
export async function detectInstall(deps: Pick<UpdaterDeps, 'packaged' | 'platform' | 'execPath' | 'env' | 'run'>): Promise<InstallInfo & { target?: string; allUsers?: boolean }> {
  if (!deps.packaged) return info('development', { canInstall: false, reason: 'Updates install into packaged builds. In a source checkout, pull and rebuild instead.' });
  if (deps.platform === 'linux') {
    const appImage = deps.env.APPIMAGE;
    if (appImage && path.isAbsolute(appImage)) {
      return await writable(path.dirname(appImage))
        ? { ...info('appimage'), target: appImage }
        : info('appimage', { canInstall: false, reason: `The folder holding the AppImage (${path.dirname(appImage)}) is not writable, so it cannot be replaced from inside the app.` });
    }
    if (deps.execPath.startsWith('/opt/')) {
      const probes: [InstallKind, string, string[], (result: RunOutcome) => boolean][] = [
        ['deb', 'dpkg-query', ['-W', '-f=${Status}', PACKAGE], result => result.code === 0 && /install ok installed/.test(result.stdout)],
        ['pacman', 'pacman', ['-Qq', PACKAGE], result => result.code === 0],
        ['rpm', 'rpm', ['-q', PACKAGE], result => result.code === 0],
      ];
      for (const [kind, file, args, owned] of probes) {
        const result = await deps.run(file, args, { timeoutMs: 10_000 }).catch((): RunOutcome => ({ code: null, stdout: '', stderr: '' }));
        if (owned(result)) return info(kind);
      }
    }
    return info('manual', { label: 'Portable archive (.tar.gz)', canInstall: false, reason: 'This copy was not installed by a package manager or as an AppImage. Download the new archive and unpack it in place of this one.' });
  }
  if (deps.platform === 'darwin') {
    const bundle = /^(.*?\.app)\/Contents\/MacOS\//.exec(deps.execPath)?.[1];
    if (!bundle) return info('manual', { canInstall: false, reason: 'Could not find the Your Bot app bundle.' });
    if (bundle.includes('/AppTranslocation/')) return info('mac', { canInstall: false, reason: 'macOS is running Your Bot from a temporary, read-only location. Move Your Bot to the Applications folder, open it from there, and try again.' });
    if (!await writable(path.dirname(bundle)) || !await writable(bundle)) return info('mac', { canInstall: false, reason: `Your account cannot write to ${path.dirname(bundle)}, so the app cannot be replaced.` });
    return { ...info('mac'), target: bundle };
  }
  if (deps.platform === 'win32') {
    if (await exists(path.join(path.dirname(deps.execPath), 'Uninstall Your Bot.exe'))) {
      // A per-machine install lives under Program Files; the silent installer must be told to keep it there.
      const folder = (value: string) => value.toLowerCase().replace(/[\\/]+/g, '\\').replace(/\\$/, '') + '\\';
      const programFiles = [deps.env.ProgramFiles, deps.env.ProgramW6432, deps.env['ProgramFiles(x86)']].filter((value): value is string => !!value).map(folder);
      return { ...info('nsis'), allUsers: programFiles.some(prefix => folder(deps.execPath).startsWith(prefix)) };
    }
    return info('manual', { label: 'Portable zip', canInstall: false, reason: 'This is the portable zip build. Download the new zip and unpack it in place of this one, or switch to the installer.' });
  }
  return info('manual', { canInstall: false, reason: 'In-app updates are not supported on this system.' });
}

/** Release asset file names, exactly as the release workflow names them (electron-builder.yml `artifactName`). */
export function assetNames(kind: InstallKind, arch: string, version: string): string[] {
  const pick = (map: Record<string, string>) => map[arch];
  const linux = (map: Record<string, string>, ext: string) => { const a = pick(map); return a ? [`Your-Bot-${version}-linux-${a}.${ext}`] : []; };
  switch (kind) {
    case 'appimage': return linux({ x64: 'x86_64', arm64: 'arm64' }, 'AppImage');
    case 'deb': return linux({ x64: 'amd64', arm64: 'arm64' }, 'deb');
    case 'rpm': return linux({ x64: 'x86_64', arm64: 'aarch64' }, 'rpm');
    case 'pacman': return linux({ x64: 'x64', arm64: 'aarch64' }, 'pacman');
    case 'mac': { const a = pick({ x64: 'x64', arm64: 'arm64' }); return a ? [`Your-Bot-${version}-mac-${a}.zip`] : []; }
    case 'nsis': { const a = pick({ x64: 'x64', arm64: 'arm64' }); return a ? [`Your-Bot-Setup-${version}-${a}.exe`, `Your-Bot-Setup-${version}.exe`] : []; }
    default: return [];
  }
}

/* ------------------------------------------------------------ release list */

const clean = (value: unknown, max: number): string => String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max);
const isDownload = (url: unknown): url is string => typeof url === 'string' && url.startsWith(DOWNLOAD_PREFIX) && !url.includes('..');

/** Turns the GitHub releases response into releases this computer can understand. Drafts and odd tags are dropped. */
export function parseReleases(body: unknown, kind: InstallKind, arch: string, currentVersion: string): Release[] {
  if (!Array.isArray(body)) throw new UpdateError('GitHub returned an unexpected release list.');
  const releases: Release[] = [];
  for (const raw of body.slice(0, 100)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const tag = typeof entry.tag_name === 'string' ? entry.tag_name : '';
    const version = TAG.exec(tag)?.[1];
    if (!version || entry.draft === true) continue;
    const assets = (Array.isArray(entry.assets) ? entry.assets : []).flatMap((asset): ReleaseAsset[] => {
      if (!asset || typeof asset !== 'object') return [];
      const { name, size, browser_download_url: url } = asset as Record<string, unknown>;
      return typeof name === 'string' && typeof size === 'number' && Number.isSafeInteger(size) && size > 0 && isDownload(url) ? [{ name, size, url }] : [];
    });
    const wanted = assetNames(kind, arch, version);
    const asset = wanted.map(name => assets.find(candidate => candidate.name === name)).find(Boolean);
    const checksums = assets.find(candidate => candidate.name === CHECKSUMS);
    const page = typeof entry.html_url === 'string' && entry.html_url.startsWith(`${RELEASE_PAGE}/`) ? entry.html_url : RELEASE_PAGE;
    const order = compareSemver(version, currentVersion);
    releases.push({
      tag, version, name: clean(entry.name || tag, 200), publishedAt: typeof entry.published_at === 'string' ? clean(entry.published_at, 64) : '',
      prerelease: entry.prerelease === true, notes: clean(entry.body, 6000), installable: !!asset && !!checksums,
      relation: order > 0 ? 'newer' : order < 0 ? 'older' : 'current', page, ...(asset ? { asset } : {}), ...(checksums ? { checksums } : {}),
    });
  }
  return releases.sort((a, b) => compareSemver(b.version, a.version));
}

/** `sha256sum` output: "<64 hex>  <name>" (a leading `*` marks binary mode). */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match) sums.set(match[2]!, match[1]!.toLowerCase());
  }
  return sums;
}

/* ------------------------------------------------------------ download */

function checkedResponseURL(response: Response, requested: string): void {
  let final: URL;
  try { final = new URL(response.url || requested); } catch { throw new Error('The download came from an unexpected address.'); }
  if (final.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(final.hostname) || final.username || final.password) throw new Error(`Refusing a download served from ${final.hostname}.`);
}

async function readBounded(response: Response, max: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []; let size = 0;
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); throw new Error('The response was larger than expected.'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Streams an asset to `destination` (created exclusively), hashing as it goes. Rejects on size or hash mismatch. */
export async function downloadVerified(fetcher: UpdaterDeps['fetch'], asset: ReleaseAsset, expectedSha256: string, destination: string, onBytes?: (received: number, total: number) => void): Promise<void> {
  if (asset.size > MAX_ASSET_BYTES) throw new Error('The installer is larger than allowed.');
  const controller = new AbortController();
  let idle = setTimeout(() => controller.abort(), 60_000);
  const poke = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(), 60_000); };
  const file = await open(destination, 'wx', 0o600);
  let ok = false;
  try {
    const response = await fetcher(asset.url, { redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': 'Your-Bot-Updater', Accept: 'application/octet-stream' } });
    if (!response.ok || !response.body) throw new Error(`The download failed (HTTP ${response.status}).`);
    checkedResponseURL(response, asset.url);
    const hash = createHash('sha256');
    const reader = response.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      poke();
      received += value.byteLength;
      if (received > asset.size) { await reader.cancel().catch(() => {}); throw new Error('The download is larger than the release says it is.'); }
      hash.update(value);
      await file.write(value);
      onBytes?.(received, asset.size);
    }
    if (received !== asset.size) throw new Error('The download ended early. Check your connection and try again.');
    if (hash.digest('hex') !== expectedSha256) throw new Error('The download does not match the release checksum, so it was not installed.');
    ok = true;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The download stalled. Check your connection and try again.');
    throw error;
  } finally {
    clearTimeout(idle);
    await file.close();
    if (!ok) await rm(destination, { force: true });
  }
}

/* ------------------------------------------------------------ applying a release */

const quote = (value: string): string => /^[A-Za-z0-9_./:=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
const PKEXEC = ['/usr/bin/pkexec', '/bin/pkexec'];

/** Root command that installs a downloaded Linux package, allowing older versions (reverts). */
export async function packageCommand(kind: 'deb' | 'rpm' | 'pacman', file: string): Promise<{ file: string; args: string[] }> {
  if (kind === 'deb') return await exists('/usr/bin/apt-get') ? { file: '/usr/bin/apt-get', args: ['install', '-y', '--allow-downgrades', file] } : { file: '/usr/bin/dpkg', args: ['-i', file] };
  if (kind === 'rpm') return { file: '/usr/bin/rpm', args: ['-U', '--oldpackage', '--replacepkgs', file] };
  return { file: '/usr/bin/pacman', args: ['-U', '--noconfirm', file] };
}

/**
 * Swaps the macOS bundle once this process has exited, keeping the old bundle until the new one is in place,
 * then opens the app. Arguments: pid, bundle path, new bundle path, work folder.
 */
export const MAC_SWAP_SCRIPT = [
  'pid=$1; target=$2; fresh=$3; work=$4; tries=0',
  'while kill -0 "$pid" 2>/dev/null && [ $tries -lt 300 ]; do sleep 0.2; tries=$((tries+1)); done',
  'if mv "$target" "$work/previous.app"; then',
  '  if mv "$fresh" "$target"; then xattr -dr com.apple.quarantine "$target" 2>/dev/null; rm -rf "$work"; else mv "$work/previous.app" "$target"; fi',
  'fi',
  'open "$target"',
].join('\n');

const tail = (outcome: RunOutcome): string => `${outcome.stdout}\n${outcome.stderr}${outcome.error ? `\n${outcome.error}` : ''}`.trim().slice(-8192);

export function createUpdater(deps: UpdaterDeps): Updater {
  const prefsFile = path.join(deps.dataDir, 'updates.json');
  let cache: { at: number; releases: Release[] } | undefined;
  let installing = false;
  let detected: ReturnType<typeof detectInstall> | undefined;
  const install = () => (detected ??= detectInstall(deps));
  const publicInstall = async (): Promise<InstallInfo> => { const { kind, label, canInstall, reason } = await install(); return { kind, label, canInstall, ...(reason ? { reason } : {}) }; };
  const quitSoon = () => setTimeout(() => deps.quit(), deps.quitDelayMs ?? 400);

  async function readAutoCheck(): Promise<boolean> {
    try { const value: unknown = JSON.parse(await readFile(prefsFile, 'utf8')); return !(value && typeof value === 'object' && (value as { autoCheck?: unknown }).autoCheck === false); }
    catch { return true; }
  }
  async function status(): Promise<UpdateStatus> {
    return { currentVersion: deps.currentVersion, install: await publicInstall(), autoCheck: await readAutoCheck() };
  }
  async function releases(force: boolean): Promise<Release[]> {
    if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.releases;
    const response = await deps.fetch(RELEASES_API, { redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'Your-Bot-Updater', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
    if (response.status === 403 || response.status === 429) throw new UpdateError('GitHub is limiting update checks from this network right now. Try again in an hour.');
    if (!response.ok) throw new UpdateError(`GitHub did not return the release list (HTTP ${response.status}).`);
    const { kind } = await install();
    const parsed = parseReleases(JSON.parse(Buffer.from(await readBounded(response, 8 * 1024 * 1024)).toString('utf8')), kind, deps.arch, deps.currentVersion);
    cache = { at: Date.now(), releases: parsed };
    return parsed;
  }
  const summary = ({ page: _page, asset: _asset, checksums: _checksums, ...release }: Release): ReleaseSummary => release;

  async function check(force = false): Promise<UpdateCheckResult> {
    const base = await status();
    const checkedAt = new Date().toISOString();
    try {
      const list = await releases(force);
      const latest = list.find(release => !release.prerelease);
      return { ...base, checkedAt, releases: list.map(summary), ...(latest ? { latest: latest.tag } : {}), updateAvailable: !!latest && latest.relation === 'newer' };
    } catch (error) {
      const message = error instanceof UpdateError ? error.message
        : error instanceof TypeError || (error instanceof Error && /net::|ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|timed? ?out|abort/i.test(`${error.name} ${error.message}`)) ? 'Could not reach GitHub. Check your internet connection and try again.'
        : 'Could not read the release list from GitHub.';
      return { ...base, checkedAt, releases: [], updateAvailable: false, error: message };
    }
  }

  async function apply(tag: string, onProgress: (progress: UpdateProgress) => void): Promise<UpdateInstallResult> {
    const where = await install();
    if (!where.canInstall) return { ok: false, message: where.reason ?? 'This copy of Your Bot cannot update itself.' };
    const release = (await releases(false)).find(candidate => candidate.tag === tag) ?? (await releases(true)).find(candidate => candidate.tag === tag);
    if (!release) return { ok: false, message: `Version ${tag} was not found among the published releases.` };
    if (release.relation === 'current') return { ok: false, message: `Version ${release.version} is already installed.` };
    if (!release.asset) return { ok: false, message: `Version ${release.version} has no ${where.label} for this computer. Use the release page to download it.` };
    if (!release.checksums) return { ok: false, message: `Version ${release.version} has no checksum file, so it cannot be verified and was not installed.` };

    const sumsResponse = await deps.fetch(release.checksums.url, { redirect: 'follow', signal: AbortSignal.timeout(30_000), headers: { 'User-Agent': 'Your-Bot-Updater' } });
    if (!sumsResponse.ok) return { ok: false, message: `Could not download the checksum file (HTTP ${sumsResponse.status}).` };
    checkedResponseURL(sumsResponse, release.checksums.url);
    const expected = parseChecksums(Buffer.from(await readBounded(sumsResponse, 256 * 1024)).toString('utf8')).get(release.asset.name);
    if (!expected) return { ok: false, message: `The checksum file does not list ${release.asset.name}, so it was not installed.` };

    // The AppImage is downloaded next to the one it replaces, so the final rename is atomic.
    const work = where.kind === 'appimage' ? path.dirname(where.target!) : await mkdtemp(path.join(deps.tmpdir ?? tmpdir(), 'your-bot-update-'));
    const file = where.kind === 'appimage' ? path.join(work, `.your-bot-update-${randomUUID()}.AppImage`) : path.join(work, release.asset.name);
    const discard = () => where.kind === 'appimage' ? rm(file, { force: true }) : rm(work, { recursive: true, force: true });
    let keep = false;
    try {
      onProgress({ tag, phase: 'downloading', received: 0, total: release.asset.size });
      let last = 0;
      await downloadVerified(deps.fetch, release.asset, expected, file, (received, total) => {
        if (received === total || received - last >= 256 * 1024) { last = received; onProgress({ tag, phase: 'downloading', received, total }); }
      });
      onProgress({ tag, phase: 'verifying' });
      onProgress({ tag, phase: 'installing' });
      const done = (message: string, relaunch?: { execPath?: string; args?: string[] }): UpdateInstallResult => {
        keep = true;
        onProgress({ tag, phase: 'restarting' });
        if (relaunch !== undefined) deps.relaunch(relaunch);
        quitSoon();
        return { ok: true, restarting: true, message };
      };
      const verb = release.relation === 'newer' ? 'Updated' : 'Switched';
      switch (where.kind) {
        case 'appimage': {
          await chmod(file, 0o755);
          await rename(file, where.target!);
          return done(`${verb} to ${release.version}. Restarting…`, { execPath: where.target!, args: [] });
        }
        case 'deb': case 'rpm': case 'pacman': {
          // Root-run package managers read the file; the private temp folder must be traversable.
          await chmod(work, 0o755); await chmod(file, 0o644);
          const command = await packageCommand(where.kind, file);
          const manual = `sudo ${[command.file, ...command.args].map(quote).join(' ')}`;
          const pkexec = (await Promise.all((deps.pkexecPaths ?? PKEXEC).map(async candidate => await exists(candidate) ? candidate : undefined))).find(Boolean);
          if (!pkexec) { keep = true; return { ok: false, command: manual, message: 'Installing a system package needs administrator rights. Run this command in a terminal, then restart Your Bot:' }; }
          const outcome = await deps.run(pkexec, [command.file, ...command.args], { timeoutMs: 15 * 60_000 });
          if (outcome.code === 0) { await discard().catch(() => {}); return done(`${verb} to ${release.version}. Restarting…`, {}); }
          if (outcome.code === 126) return { ok: false, message: 'Administrator authorization was cancelled. Nothing was changed.' };
          if (outcome.code === 127 && /authentication agent|not authorized|Error executing command as another user/i.test(tail(outcome))) {
            keep = true;
            return { ok: false, command: manual, output: tail(outcome), message: 'No password prompt is available on this desktop. Run this command in a terminal, then restart Your Bot:' };
          }
          return { ok: false, output: tail(outcome), message: `The package manager could not install ${release.version}.` };
        }
        case 'mac': {
          const extracted = path.join(work, 'extracted');
          await mkdir(extracted);
          const unzip = await deps.run('/usr/bin/ditto', ['-x', '-k', file, extracted], { timeoutMs: 5 * 60_000 });
          if (unzip.code !== 0) return { ok: false, output: tail(unzip), message: 'Could not unpack the downloaded app.' };
          const bundle = (await readdir(extracted)).find(name => name.endsWith('.app'));
          if (!bundle) return { ok: false, message: 'The download does not contain an app.' };
          await rm(file, { force: true });
          await deps.spawnDetached('/bin/sh', ['-c', MAC_SWAP_SCRIPT, 'your-bot-update', String(deps.pid ?? process.pid), where.target!, path.join(extracted, bundle), work]);
          return done(`${verb} to ${release.version}. Restarting…`);
        }
        case 'nsis': {
          // The installer waits for this app to exit, installs silently over it (older versions included) and starts it again.
          await deps.spawnDetached(file, ['--updated', '/S', '--force-run', where.allUsers ? '/allusers' : '/currentuser']);
          return done(`Installing ${release.version}. Your Bot will reopen when it is done.`);
        }
        default: return { ok: false, message: 'This copy of Your Bot cannot update itself.' };
      }
    } finally {
      if (!keep) await discard().catch(() => {});
    }
  }

  return {
    status,
    check,
    async install(tag, onProgress = () => {}) {
      if (!TAG.test(tag)) return { ok: false, message: 'Unknown version.' };
      if (installing) return { ok: false, message: 'Another version is already being installed.' };
      installing = true;
      try { return await apply(tag, onProgress); }
      catch (error) { return { ok: false, message: error instanceof Error && error.message ? error.message.slice(0, 500) : 'The update failed.' }; }
      finally { installing = false; }
    },
    async openRelease(tag) {
      const page = tag && cache?.releases.find(release => release.tag === tag)?.page;
      await deps.openExternal(page || RELEASE_PAGE);
      return true;
    },
    async setAutoCheck(enabled) {
      const temporary = `${prefsFile}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify({ autoCheck: enabled }), { mode: 0o600 }); await rename(temporary, prefsFile); return true; }
      catch { await rm(temporary, { force: true }).catch(() => {}); return false; }
    },
  };
}
