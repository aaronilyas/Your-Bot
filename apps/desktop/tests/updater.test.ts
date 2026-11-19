import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assetNames, compareSemver, createUpdater, detectInstall, MAC_SWAP_SCRIPT, parseChecksums, parseReleases, type UpdaterDeps } from '../src/main/updater';
import type { UpdateProgress } from '../src/shared/ipc';

const REPO = 'https://github.com/aaronilyas/Your-Bot';
/** The asset names of the real v0.1.0 release. */
const V010_ASSETS = ['install.sh', 'SHA256SUMS.txt', 'Your-Bot-0.1.0-linux-aarch64.pacman', 'Your-Bot-0.1.0-linux-aarch64.rpm', 'Your-Bot-0.1.0-linux-amd64.deb', 'Your-Bot-0.1.0-linux-arm64.AppImage', 'Your-Bot-0.1.0-linux-arm64.deb', 'Your-Bot-0.1.0-linux-arm64.tar.gz', 'Your-Bot-0.1.0-linux-x64.pacman', 'Your-Bot-0.1.0-linux-x64.tar.gz', 'Your-Bot-0.1.0-linux-x86_64.AppImage', 'Your-Bot-0.1.0-linux-x86_64.rpm', 'Your-Bot-0.1.0-mac-arm64.dmg', 'Your-Bot-0.1.0-mac-arm64.zip', 'Your-Bot-0.1.0-mac-x64.dmg', 'Your-Bot-0.1.0-mac-x64.zip', 'Your-Bot-0.1.0-win-x64.zip', 'Your-Bot-Setup-0.1.0-arm64.exe', 'Your-Bot-Setup-0.1.0-x64.exe', 'Your-Bot-Setup-0.1.0.exe'];

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const respond = (body: BodyInit | null, url: string, status = 200) => { const response = new Response(body, { status }); Object.defineProperty(response, 'url', { value: url }); return response; };
const releaseJSON = (version: string, files: Record<string, string>, extra: object = {}) => ({
  tag_name: `v${version}`, name: `Your Bot ${version}`, draft: false, prerelease: false, published_at: '2026-11-01T00:00:00Z', html_url: `${REPO}/releases/tag/v${version}`, body: `Notes for ${version}`,
  assets: [...Object.entries(files).map(([name, data]) => ({ name, size: Buffer.byteLength(data), browser_download_url: `${REPO}/releases/download/v${version}/${name}` })),
    { name: 'SHA256SUMS.txt', size: 1, browser_download_url: `${REPO}/releases/download/v${version}/SHA256SUMS.txt` }],
  ...extra,
});

/** A fake GitHub: the API lists `releases`; downloads redirect to the asset CDN and serve `files[name]`. */
function github(releases: object[], files: Record<string, Record<string, string>>, options: { sums?: (version: string) => string; cdn?: string } = {}) {
  const fetch = vi.fn(async (url: string): Promise<Response> => {
    if (url.startsWith('https://api.github.com/repos/aaronilyas/Your-Bot/releases')) return respond(JSON.stringify(releases), url);
    const match = /\/releases\/download\/v([^/]+)\/(.+)$/.exec(url);
    if (!match) return respond('missing', url, 404);
    const [, version, name] = match as unknown as [string, string, string];
    const cdn = `https://${options.cdn ?? 'release-assets.githubusercontent.com'}/x/${name}`;
    if (name === 'SHA256SUMS.txt') return respond(options.sums?.(version) ?? Object.entries(files[version] ?? {}).map(([file, data]) => `${sha(data)}  ${file}`).join('\n'), cdn);
    const data = files[version]?.[name];
    return data === undefined ? respond('missing', cdn, 404) : respond(data, cdn);
  });
  return fetch;
}

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'your-bot-updater-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function deps(overrides: Partial<UpdaterDeps>): UpdaterDeps & { relaunch: ReturnType<typeof vi.fn>; quit: ReturnType<typeof vi.fn>; spawnDetached: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn>; openExternal: ReturnType<typeof vi.fn> } {
  return {
    currentVersion: '0.2.0', packaged: true, platform: 'linux', arch: 'x64', execPath: '/opt/Your Bot/your-bot', env: {}, dataDir: dir,
    fetch: github([], {}), run: vi.fn(async () => ({ code: 1, stdout: '', stderr: '' })), spawnDetached: vi.fn(async () => {}), openExternal: vi.fn(async () => {}),
    relaunch: vi.fn(), quit: vi.fn(), quitDelayMs: 0, tmpdir: dir, pkexecPaths: [],
    ...overrides,
  } as never;
}

describe('versions and release assets', () => {
  it('orders semantic versions, prereleases before their release', () => {
    expect(compareSemver('0.2.0', '0.1.9')).toBe(1); expect(compareSemver('v1.0.0', '1.0.0')).toBe(0); expect(compareSemver('0.10.0', '0.9.0')).toBe(1);
    expect(compareSemver('1.0.0-beta.1', '1.0.0')).toBe(-1); expect(compareSemver('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1); expect(compareSemver('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
  });
  it('names exactly the installers the release workflow publishes', () => {
    const cases: [Parameters<typeof assetNames>[0], string, string][] = [
      ['appimage', 'x64', 'Your-Bot-0.1.0-linux-x86_64.AppImage'], ['appimage', 'arm64', 'Your-Bot-0.1.0-linux-arm64.AppImage'],
      ['deb', 'x64', 'Your-Bot-0.1.0-linux-amd64.deb'], ['deb', 'arm64', 'Your-Bot-0.1.0-linux-arm64.deb'],
      ['rpm', 'x64', 'Your-Bot-0.1.0-linux-x86_64.rpm'], ['rpm', 'arm64', 'Your-Bot-0.1.0-linux-aarch64.rpm'],
      ['pacman', 'x64', 'Your-Bot-0.1.0-linux-x64.pacman'], ['pacman', 'arm64', 'Your-Bot-0.1.0-linux-aarch64.pacman'],
      ['mac', 'x64', 'Your-Bot-0.1.0-mac-x64.zip'], ['mac', 'arm64', 'Your-Bot-0.1.0-mac-arm64.zip'],
      ['nsis', 'x64', 'Your-Bot-Setup-0.1.0-x64.exe'], ['nsis', 'arm64', 'Your-Bot-Setup-0.1.0-arm64.exe'],
    ];
    for (const [kind, arch, name] of cases) { expect(assetNames(kind, arch, '0.1.0')[0]).toBe(name); expect(V010_ASSETS).toContain(name); }
    expect(assetNames('manual', 'x64', '0.1.0')).toEqual([]); expect(assetNames('deb', 'ia32', '0.1.0')).toEqual([]);
  });
  it('parses releases, dropping drafts, odd tags and downloads from anywhere but the project', () => {
    const list = parseReleases([
      releaseJSON('0.1.0', { 'Your-Bot-0.1.0-linux-x86_64.AppImage': 'a' }),
      releaseJSON('0.3.0', { 'Your-Bot-0.3.0-linux-x86_64.AppImage': 'b' }, { draft: true }),
      releaseJSON('0.2.1', {}, { prerelease: true, assets: [{ name: 'Your-Bot-0.2.1-linux-x86_64.AppImage', size: 3, browser_download_url: 'https://evil.example/Your-Bot-0.2.1-linux-x86_64.AppImage' }, { name: 'SHA256SUMS.txt', size: 1, browser_download_url: `${REPO}/releases/download/v0.2.1/SHA256SUMS.txt` }] }),
      { ...releaseJSON('9.9.9', {}), tag_name: 'nightly' }, null, 'junk',
      releaseJSON('0.2.0', { 'Your-Bot-0.2.0-linux-x86_64.AppImage': 'c' }, { html_url: 'https://evil.example/', body: 'line\r\nnext\u0007' }),
    ], 'appimage', 'x64', '0.2.0');
    expect(list.map(release => [release.tag, release.relation, release.installable, release.prerelease])).toEqual([['v0.2.1', 'newer', false, true], ['v0.2.0', 'current', true, false], ['v0.1.0', 'older', true, false]]);
    expect(list[1]).toMatchObject({ page: `${REPO}/releases`, notes: 'line\nnext' });
    expect(() => parseReleases({ message: 'Not Found' }, 'appimage', 'x64', '0.1.0')).toThrow();
  });
  it('reads sha256sum output', () => {
    const sums = parseChecksums(`${'a'.repeat(64)}  Your-Bot-0.1.0-linux-x86_64.AppImage\r\n${'B'.repeat(64)} *Your Bot.exe\nnot a line\n`);
    expect(sums.get('Your-Bot-0.1.0-linux-x86_64.AppImage')).toBe('a'.repeat(64)); expect(sums.get('Your Bot.exe')).toBe('b'.repeat(64)); expect(sums.size).toBe(2);
  });
});

describe('install detection', () => {
  const base = { packaged: true, platform: 'linux' as const, execPath: '/opt/Your Bot/your-bot', env: {}, run: vi.fn(async () => ({ code: 1, stdout: '', stderr: '' })) };
  it('never installs into a development build', async () => {
    expect(await detectInstall({ ...base, packaged: false })).toMatchObject({ kind: 'development', canInstall: false });
  });
  it('recognises a writable AppImage, and refuses one in a folder it cannot write', async () => {
    expect(await detectInstall({ ...base, env: { APPIMAGE: path.join(dir, 'Your-Bot.AppImage') } })).toMatchObject({ kind: 'appimage', canInstall: true, target: path.join(dir, 'Your-Bot.AppImage') });
    if (process.getuid?.() !== 0) expect(await detectInstall({ ...base, env: { APPIMAGE: '/proc/Your-Bot.AppImage' } })).toMatchObject({ kind: 'appimage', canInstall: false });
  });
  it('asks the package managers who owns /opt/Your Bot', async () => {
    const run = vi.fn(async (file: string) => file === 'dpkg-query' ? { code: 0, stdout: 'install ok installed', stderr: '' } : { code: 1, stdout: '', stderr: '' });
    expect(await detectInstall({ ...base, run })).toMatchObject({ kind: 'deb', canInstall: true });
    expect(run).toHaveBeenCalledWith('dpkg-query', ['-W', '-f=${Status}', 'your-bot'], expect.anything());
    const pacman = vi.fn(async (file: string) => ({ code: file === 'pacman' ? 0 : 1, stdout: '', stderr: '' }));
    expect(await detectInstall({ ...base, run: pacman })).toMatchObject({ kind: 'pacman' });
    const rpm = vi.fn(async (file: string) => file === 'rpm' ? { code: 0, stdout: 'your-bot-0.1.0', stderr: '' } : file === 'dpkg-query' ? { code: 0, stdout: 'deinstall ok config-files', stderr: '' } : { code: 1, stdout: '', stderr: '' });
    expect(await detectInstall({ ...base, run: rpm })).toMatchObject({ kind: 'rpm' });
    expect(await detectInstall(base)).toMatchObject({ kind: 'manual', canInstall: false });
    expect(await detectInstall({ ...base, execPath: '/home/me/Your-Bot/your-bot', run: pacman })).toMatchObject({ kind: 'manual', canInstall: false });
  });
  it('finds the macOS bundle and refuses translocated or read-only ones', async () => {
    const bundle = path.join(dir, 'Your Bot.app'); await mkdir(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
    expect(await detectInstall({ ...base, platform: 'darwin', execPath: path.join(bundle, 'Contents/MacOS/Your Bot') })).toMatchObject({ kind: 'mac', canInstall: true, target: bundle });
    expect(await detectInstall({ ...base, platform: 'darwin', execPath: '/private/var/folders/x/AppTranslocation/1/d/Your Bot.app/Contents/MacOS/Your Bot' })).toMatchObject({ kind: 'mac', canInstall: false });
    expect(await detectInstall({ ...base, platform: 'darwin', execPath: '/usr/bin/your-bot' })).toMatchObject({ kind: 'manual', canInstall: false });
  });
  it('tells the Windows installer build from the portable zip', async () => {
    await writeFile(path.join(dir, 'Uninstall Your Bot.exe'), '');
    expect(await detectInstall({ ...base, platform: 'win32', execPath: path.join(dir, 'your-bot.exe'), env: {} })).toMatchObject({ kind: 'nsis', canInstall: true, allUsers: false });
    expect(await detectInstall({ ...base, platform: 'win32', execPath: path.join(dir, 'your-bot.exe'), env: { ProgramFiles: dir } })).toMatchObject({ kind: 'nsis', allUsers: true });
    expect(await detectInstall({ ...base, platform: 'win32', execPath: path.join(dir, 'portable', 'your-bot.exe'), env: {} })).toMatchObject({ kind: 'manual', canInstall: false });
  });
});

describe('checking for updates', () => {
  it('reports the newest stable release and caches the list', async () => {
    const fetch = github([releaseJSON('0.3.0', {}, { prerelease: true }), releaseJSON('0.2.5', {}), releaseJSON('0.2.0', {}), releaseJSON('0.1.0', {})], {});
    const updater = createUpdater(deps({ fetch, env: { APPIMAGE: path.join(dir, 'Your-Bot.AppImage') } }));
    const result = await updater.check();
    expect(result).toMatchObject({ currentVersion: '0.2.0', latest: 'v0.2.5', updateAvailable: true, autoCheck: true, install: { kind: 'appimage', canInstall: true } });
    expect(result.releases.map(release => release.tag)).toEqual(['v0.3.0', 'v0.2.5', 'v0.2.0', 'v0.1.0']);
    expect(JSON.stringify(result)).not.toMatch(/https?:/);
    await updater.check(); expect(fetch).toHaveBeenCalledTimes(1);
    await updater.check(true); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('explains rate limits and offline errors instead of throwing', async () => {
    const limited = createUpdater(deps({ fetch: vi.fn(async (url: string) => respond('{}', url, 403)) }));
    expect((await limited.check()).error).toMatch(/limiting update checks/);
    const offline = createUpdater(deps({ fetch: vi.fn(async () => { throw new TypeError('fetch failed'); }) }));
    expect(await offline.check()).toMatchObject({ updateAvailable: false, releases: [], error: expect.stringMatching(/internet connection/) });
  });
  it('remembers the automatic-check preference', async () => {
    const updater = createUpdater(deps({}));
    expect((await updater.status()).autoCheck).toBe(true);
    expect(await updater.setAutoCheck(false)).toBe(true);
    expect((await updater.status()).autoCheck).toBe(false);
    expect(JSON.parse(await readFile(path.join(dir, 'updates.json'), 'utf8'))).toEqual({ autoCheck: false });
  });
  it('opens only GitHub release pages', async () => {
    const d = deps({ fetch: github([releaseJSON('0.1.0', {})], {}) });
    const updater = createUpdater(d);
    await updater.openRelease(); expect(d.openExternal).toHaveBeenLastCalledWith(`${REPO}/releases`);
    await updater.check(); await updater.openRelease('v0.1.0'); expect(d.openExternal).toHaveBeenLastCalledWith(`${REPO}/releases/tag/v0.1.0`);
  });
});

describe('installing a release', () => {
  const appImage = () => path.join(dir, 'Your-Bot.AppImage');
  async function appImageSetup(extra: Partial<UpdaterDeps> = {}, files?: Record<string, Record<string, string>>, options?: Parameters<typeof github>[2]) {
    await writeFile(appImage(), 'old build', { mode: 0o755 });
    const available = files ?? { '0.3.0': { 'Your-Bot-0.3.0-linux-x86_64.AppImage': 'new build' }, '0.1.0': { 'Your-Bot-0.1.0-linux-x86_64.AppImage': 'older build' } };
    const fetch = github(Object.entries(available).map(([version, assets]) => releaseJSON(version, assets)), available, options);
    const d = deps({ fetch, env: { APPIMAGE: appImage() }, ...extra });
    const progress: UpdateProgress[] = [];
    return { d, updater: createUpdater(d), progress, onProgress: (value: UpdateProgress) => progress.push(value) };
  }
  it('updates an AppImage in place after verifying it, then restarts from the AppImage', async () => {
    const { d, updater, progress, onProgress } = await appImageSetup();
    const result = await updater.install('v0.3.0', onProgress);
    expect(result).toMatchObject({ ok: true, restarting: true, message: expect.stringMatching(/Updated to 0\.3\.0/) });
    expect(await readFile(appImage(), 'utf8')).toBe('new build');
    expect((await stat(appImage())).mode & 0o777).toBe(0o755);
    expect(d.relaunch).toHaveBeenCalledWith({ execPath: appImage(), args: [] });
    await vi.waitFor(() => expect(d.quit).toHaveBeenCalledOnce());
    expect(progress.map(p => p.phase)).toEqual(expect.arrayContaining(['downloading', 'verifying', 'installing', 'restarting']));
    expect(progress.find(p => p.phase === 'downloading' && p.received === 9)).toMatchObject({ total: 9 });
    expect((await readdir(dir)).filter(name => name.startsWith('.your-bot-update-'))).toEqual([]);
  });
  it('reverts to an older release the same way', async () => {
    const { updater } = await appImageSetup();
    expect(await updater.install('v0.1.0')).toMatchObject({ ok: true, message: expect.stringMatching(/Switched to 0\.1\.0/) });
    expect(await readFile(appImage(), 'utf8')).toBe('older build');
  });
  it('refuses a download that does not match the published checksum and leaves the app untouched', async () => {
    const { d, updater } = await appImageSetup({}, undefined, { sums: () => `${'0'.repeat(64)}  Your-Bot-0.3.0-linux-x86_64.AppImage` });
    expect(await updater.install('v0.3.0')).toMatchObject({ ok: false, message: expect.stringMatching(/does not match the release checksum/) });
    expect(await readFile(appImage(), 'utf8')).toBe('old build'); expect(d.relaunch).not.toHaveBeenCalled(); expect(d.quit).not.toHaveBeenCalled();
    expect((await readdir(dir)).filter(name => name.startsWith('.your-bot-update-'))).toEqual([]);
  });
  it('refuses a release with no checksum entry for the installer', async () => {
    const { updater } = await appImageSetup({}, undefined, { sums: () => '' });
    expect(await updater.install('v0.3.0')).toMatchObject({ ok: false, message: expect.stringMatching(/does not list/) });
    expect(await readFile(appImage(), 'utf8')).toBe('old build');
  });
  it('refuses a download redirected away from GitHub', async () => {
    const { updater } = await appImageSetup({}, undefined, { cdn: 'evil.example' });
    expect(await updater.install('v0.3.0')).toMatchObject({ ok: false, message: expect.stringMatching(/evil\.example/) });
    expect(await readFile(appImage(), 'utf8')).toBe('old build');
  });
  it('rejects unknown, current and malformed versions, and a second install while one runs', async () => {
    const { updater } = await appImageSetup({}, { '0.2.0': { 'Your-Bot-0.2.0-linux-x86_64.AppImage': 'same' }, '0.3.0': { 'Your-Bot-0.3.0-linux-x86_64.AppImage': 'new build' } });
    expect(await updater.install('v9.9.9')).toMatchObject({ ok: false, message: expect.stringMatching(/not found/) });
    expect(await updater.install('v0.2.0')).toMatchObject({ ok: false, message: expect.stringMatching(/already installed/) });
    expect(await updater.install('../../etc/passwd')).toMatchObject({ ok: false });
    const [first, second] = await Promise.all([updater.install('v0.3.0'), updater.install('v0.3.0')]);
    expect(first.ok).toBe(true); expect(second).toMatchObject({ ok: false, message: expect.stringMatching(/already being installed/) });
  });
  it('does nothing in a build that cannot install', async () => {
    const d = deps({ packaged: false, fetch: github([releaseJSON('0.3.0', { x: 'y' })], {}) });
    expect(await createUpdater(d).install('v0.3.0')).toMatchObject({ ok: false, message: expect.stringMatching(/packaged builds/) });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  describe('Linux packages', () => {
    const debFiles = { '0.1.0': { 'Your-Bot-0.1.0-linux-amd64.deb': 'deb bytes' } };
    const ownedByDpkg = (pkexec: (file: string, args: string[]) => { code: number; stdout: string; stderr: string }) => vi.fn(async (file: string, args: string[]) => file === 'dpkg-query' ? { code: 0, stdout: 'install ok installed', stderr: '' } : file.endsWith('pkexec') ? pkexec(file, args) : { code: 1, stdout: '', stderr: '' });
    it('installs through pkexec, allowing a downgrade, and restarts', async () => {
      const pkexec = path.join(dir, 'pkexec'); await writeFile(pkexec, '');
      let seen: string[] = []; let installed = '';
      const run = ownedByDpkg((_file, args) => { seen = args; return { code: 0, stdout: 'done', stderr: '' }; });
      const d = deps({ fetch: github([releaseJSON('0.1.0', debFiles['0.1.0'])], debFiles), run, pkexecPaths: [pkexec] });
      run.mockImplementation(async (file: string, args: string[]) => {
        if (file === 'dpkg-query') return { code: 0, stdout: 'install ok installed', stderr: '' };
        if (file === pkexec) { seen = args; installed = await readFile(args.at(-1)!, 'utf8'); return { code: 0, stdout: 'done', stderr: '' }; }
        return { code: 1, stdout: '', stderr: '' };
      });
      expect(await createUpdater(d).install('v0.1.0')).toMatchObject({ ok: true, restarting: true });
      expect(installed).toBe('deb bytes');
      expect(seen.slice(0, -1)).toEqual(seen[0] === '/usr/bin/apt-get' ? ['/usr/bin/apt-get', 'install', '-y', '--allow-downgrades'] : ['/usr/bin/dpkg', '-i']);
      expect(seen.at(-1)).toMatch(/Your-Bot-0\.1\.0-linux-amd64\.deb$/);
      expect(d.relaunch).toHaveBeenCalledWith({}); await vi.waitFor(() => expect(d.quit).toHaveBeenCalled());
    });
    it('reports a cancelled password prompt without restarting', async () => {
      const pkexec = path.join(dir, 'pkexec'); await writeFile(pkexec, '');
      const d = deps({ fetch: github([releaseJSON('0.1.0', debFiles['0.1.0'])], debFiles), run: ownedByDpkg(() => ({ code: 126, stdout: '', stderr: '' })), pkexecPaths: [pkexec] });
      expect(await createUpdater(d).install('v0.1.0')).toMatchObject({ ok: false, message: expect.stringMatching(/cancelled/) });
      expect(d.relaunch).not.toHaveBeenCalled(); expect(d.quit).not.toHaveBeenCalled();
    });
    it('hands over a sudo command when there is no way to ask for the password', async () => {
      const d = deps({ fetch: github([releaseJSON('0.1.0', debFiles['0.1.0'])], debFiles), run: ownedByDpkg(() => ({ code: 0, stdout: '', stderr: '' })), pkexecPaths: [] });
      const result = await createUpdater(d).install('v0.1.0');
      expect(result).toMatchObject({ ok: false, command: expect.stringMatching(/^sudo \/usr\/bin\/(apt-get install -y --allow-downgrades|dpkg -i) .*Your-Bot-0\.1\.0-linux-amd64\.deb$/) });
      const file = result.command!.split(' ').at(-1)!;
      expect(await readFile(file, 'utf8')).toBe('deb bytes');
    });
  });

  it('swaps the macOS bundle from a detached script after quitting', async () => {
    const bundle = path.join(dir, 'Your Bot.app'); await mkdir(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
    const files = { '0.3.0': { 'Your-Bot-0.3.0-mac-arm64.zip': 'zip bytes' } };
    const run = vi.fn(async (file: string, args: string[]) => {
      if (file !== '/usr/bin/ditto') return { code: 1, stdout: '', stderr: '' };
      expect(args.slice(0, 2)).toEqual(['-x', '-k']); await mkdir(path.join(args[3]!, 'Your Bot.app'));
      return { code: 0, stdout: '', stderr: '' };
    });
    const d = deps({ platform: 'darwin', arch: 'arm64', execPath: path.join(bundle, 'Contents/MacOS/Your Bot'), fetch: github([releaseJSON('0.3.0', files['0.3.0'])], files), run, pid: 4242 });
    expect(await createUpdater(d).install('v0.3.0')).toMatchObject({ ok: true, restarting: true });
    const [shell, args] = d.spawnDetached.mock.calls[0] as [string, string[]];
    expect(shell).toBe('/bin/sh'); expect(args[0]).toBe('-c'); expect(args[1]).toBe(MAC_SWAP_SCRIPT);
    expect(args.slice(3, 5)).toEqual(['4242', bundle]); expect(args[5]).toMatch(/extracted\/Your Bot\.app$/);
    expect(d.relaunch).not.toHaveBeenCalled(); await vi.waitFor(() => expect(d.quit).toHaveBeenCalled());
  });

  it('runs the Windows installer silently over the current install', async () => {
    await writeFile(path.join(dir, 'Uninstall Your Bot.exe'), '');
    const files = { '0.1.0': { 'Your-Bot-Setup-0.1.0-x64.exe': 'exe bytes' } };
    const d = deps({ platform: 'win32', execPath: path.join(dir, 'your-bot.exe'), fetch: github([releaseJSON('0.1.0', files['0.1.0'])], files) });
    expect(await createUpdater(d).install('v0.1.0')).toMatchObject({ ok: true, restarting: true });
    const [installer, args] = d.spawnDetached.mock.calls[0] as [string, string[]];
    expect(await readFile(installer, 'utf8')).toBe('exe bytes'); expect(args).toEqual(['--updated', '/S', '--force-run', '/currentuser']);
    await vi.waitFor(() => expect(d.quit).toHaveBeenCalled());
  });
});
