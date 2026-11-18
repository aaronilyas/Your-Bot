// Fills the download page from the latest GitHub release.
// release.json is written by .github/workflows/pages.yml at deploy time; the live GitHub API is the fallback.
(() => {
  'use strict';

  const REPO = 'aaronilyas/Your-Bot';
  const RELEASES_URL = `https://github.com/${REPO}/releases`;

  // Ordered so specific names are claimed before broader patterns. `arch` is the CPU the file is for.
  const CATALOG = {
    windows: [
      { re: /^Your-Bot-Setup-.+-x64\.exe$/, label: 'Installer', ext: '.exe', arch: 'x64', archLabel: 'x64 only' },
      { re: /^Your-Bot-Setup-.+-arm64\.exe$/, label: 'Installer', ext: '.exe', arch: 'arm64', archLabel: 'ARM64 only' },
      { re: /^Your-Bot-Setup-.+\.exe$/, label: 'Installer', ext: '.exe', arch: 'any', archLabel: 'x64 + ARM64', recommended: true },
      { re: /-win-x64\.zip$/, label: 'Portable', ext: '.zip', arch: 'x64', archLabel: 'x64' },
      { re: /-win-arm64\.zip$/, label: 'Portable', ext: '.zip', arch: 'arm64', archLabel: 'ARM64' },
    ],
    mac: [
      { re: /-mac-arm64\.dmg$/, label: 'Apple Silicon', ext: '.dmg', arch: 'arm64', archLabel: 'M1 and later', recommended: true },
      { re: /-mac-x64\.dmg$/, label: 'Intel', ext: '.dmg', arch: 'x64', archLabel: 'x64' },
      { re: /-mac-universal\.dmg$/, label: 'Universal', ext: '.dmg', arch: 'any', archLabel: 'Intel + Apple Silicon' },
      { re: /-mac-arm64\.zip$/, label: 'Apple Silicon', ext: '.zip', arch: 'arm64', archLabel: 'M1 and later' },
      { re: /-mac-x64\.zip$/, label: 'Intel', ext: '.zip', arch: 'x64', archLabel: 'x64' },
    ],
    linux: [
      { re: /-linux-x86_64\.AppImage$/, label: 'AppImage', ext: '', arch: 'x64', archLabel: 'x86_64', recommended: true },
      { re: /-linux-arm64\.AppImage$/, label: 'AppImage', ext: '', arch: 'arm64', archLabel: 'arm64' },
      { re: /-linux-amd64\.deb$/, label: 'Debian, Ubuntu', ext: '.deb', arch: 'x64', archLabel: 'amd64' },
      { re: /-linux-arm64\.deb$/, label: 'Debian, Ubuntu', ext: '.deb', arch: 'arm64', archLabel: 'arm64' },
      { re: /-linux-x86_64\.rpm$/, label: 'Fedora, RHEL, openSUSE', ext: '.rpm', arch: 'x64', archLabel: 'x86_64' },
      { re: /-linux-aarch64\.rpm$/, label: 'Fedora, RHEL, openSUSE', ext: '.rpm', arch: 'arm64', archLabel: 'aarch64' },
      { re: /-linux-x64\.pacman$/, label: 'Arch, Manjaro', ext: '.pacman', arch: 'x64', archLabel: 'x64' },
      { re: /-linux-aarch64\.pacman$/, label: 'Arch, Manjaro', ext: '.pacman', arch: 'arm64', archLabel: 'aarch64' },
      { re: /-linux-x64\.tar\.gz$/, label: 'Portable', ext: '.tar.gz', arch: 'x64', archLabel: 'x64' },
      { re: /-linux-arm64\.tar\.gz$/, label: 'Portable', ext: '.tar.gz', arch: 'arm64', archLabel: 'arm64' },
    ],
  };

  const OS_NAMES = { windows: 'Windows', mac: 'macOS', linux: 'Linux' };

  const $ = (sel) => document.querySelector(sel);

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const child of children) node.append(child);
    return node;
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(mb >= 100 ? 0 : 1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
  }

  function formatDate(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  async function detectPlatform() {
    const ua = navigator.userAgent || '';
    const uaPlatform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    const probe = `${uaPlatform} ${ua}`;
    let os = null;
    if (/android|iphone|ipad|ipod/i.test(ua)) os = null;
    else if (/win/i.test(probe)) os = 'windows';
    else if (/mac/i.test(probe)) os = 'mac';
    else if (/linux|x11|cros/i.test(probe)) os = 'linux';

    // Arch: Client Hints where available (Chromium); otherwise UA hints; Macs default to Apple Silicon.
    let arch = null;
    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        const hints = await navigator.userAgentData.getHighEntropyValues(['architecture']);
        if (hints.architecture === 'arm') arch = 'arm64';
        else if (hints.architecture === 'x86') arch = 'x64';
      }
    } catch { /* hints unavailable */ }
    if (!arch && /aarch64|arm64/i.test(ua)) arch = 'arm64';
    if (!arch) arch = os === 'mac' ? 'arm64' : 'x64';
    return { os, arch };
  }

  async function loadRelease() {
    const usable = (r) => r && Array.isArray(r.assets) && r.assets.length > 0;
    try {
      const res = await fetch('release.json', { cache: 'no-cache' });
      if (res.ok) {
        const data = await res.json();
        if (usable(data)) return data;
      }
    } catch { /* fall through to the API */ }
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (res.ok) {
        const data = await res.json();
        if (usable(data)) return data;
      }
    } catch { /* offline or rate limited */ }
    return null;
  }

  function classify(assets) {
    const byOs = { windows: [], mac: [], linux: [] };
    const claimed = new Set();
    for (const [os, rules] of Object.entries(CATALOG)) {
      for (const rule of rules) {
        const asset = assets.find((a) => !claimed.has(a.name) && rule.re.test(a.name));
        if (!asset) continue;
        claimed.add(asset.name);
        byOs[os].push({ ...rule, name: asset.name, size: asset.size, url: asset.browser_download_url });
      }
    }
    const checksums = assets.find((a) => a.name === 'SHA256SUMS.txt');
    return { byOs, checksums };
  }

  function renderLists(byOs, platform) {
    for (const os of Object.keys(CATALOG)) {
      const list = document.querySelector(`.files[data-os="${os}"]`);
      list.replaceChildren();
      const files = byOs ? byOs[os] : [];
      if (!files.length) {
        list.append(el('li', { class: 'empty', text: byOs ? 'No builds in this release.' : 'Available with the first release.' }));
        continue;
      }
      const ordered = [...files].sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended));
      for (const f of ordered) {
        const label = el('span', { class: 'label' }, [`${f.label}${f.ext ? ` (${f.ext})` : ''}`]);
        if (f.recommended) label.append(el('em', { text: 'recommended' }));
        const detail = el('span', { class: 'detail', text: [f.archLabel, formatSize(f.size)].filter(Boolean).join(' · ') });
        const link = el('a', { href: f.url, title: f.name, class: f.recommended ? 'recommended' : '' }, [label, detail]);
        list.append(el('li', {}, [link]));
      }
    }
    if (platform.os) document.getElementById(`os-${platform.os}`).classList.add('detected');
  }

  function pickPrimary(byOs, platform) {
    if (!byOs || !platform.os) return null;
    const files = byOs[platform.os];
    const installers = files.filter((f) => f.ext !== '.zip' && f.ext !== '.tar.gz');
    return installers.find((f) => f.arch === 'any')
      || installers.find((f) => f.arch === platform.arch)
      || installers[0]
      || null;
  }

  function renderPrimary(primary, platform) {
    const label = platform.os ? `Download for ${OS_NAMES[platform.os]}` : 'Download';
    const href = primary ? primary.url : '#downloads';
    // Every download button on the page (hero, nav, closer) points at the same file.
    for (const btn of document.querySelectorAll('.js-primary')) btn.href = href;
    for (const node of document.querySelectorAll('#primary-label, .js-primary-label')) node.textContent = label;
    if (primary) {
      $('#primary-sub').textContent = [primary.label === 'Installer' ? null : primary.label, primary.ext || null, primary.archLabel, formatSize(primary.size)]
        .filter(Boolean).join(' · ');
    } else if (platform.os) {
      $('#primary-sub').textContent = 'See all downloads below';
    } else {
      $('#primary-sub').textContent = 'Linux · macOS · Windows';
    }
  }

  function renderMeta(release) {
    const pill = $('#release-meta');
    const text = pill.querySelector('.announce-text');
    text.replaceChildren();
    if (!release) {
      pill.href = RELEASES_URL;
      text.append('First release coming soon ', el('span', { class: 'arrow', text: '→' }));
      return;
    }
    const date = formatDate(release.published_at);
    pill.href = release.html_url || `${RELEASES_URL}/latest`;
    text.append(el('b', { text: release.tag_name }), ` is out${date ? ` · ${date}` : ''} · Release notes `,
      el('span', { class: 'arrow', text: '→' }));
  }

  function watchScroll() {
    const nav = $('.nav');
    const update = () => nav.classList.toggle('scrolled', window.scrollY > 8);
    update();
    window.addEventListener('scroll', update, { passive: true });
  }

  function wireCopyButtons() {
    for (const button of document.querySelectorAll('button.copy')) {
      button.addEventListener('click', async () => {
        const text = document.getElementById(button.dataset.copy).textContent;
        try {
          await navigator.clipboard.writeText(text);
          button.textContent = 'Copied';
        } catch {
          button.textContent = 'Select & copy';
        }
        setTimeout(() => { button.textContent = 'Copy'; }, 1600);
      });
    }
  }

  async function main() {
    wireCopyButtons();
    watchScroll();
    const [platform, release] = await Promise.all([detectPlatform(), loadRelease()]);
    const { byOs, checksums } = release ? classify(release.assets) : { byOs: null, checksums: null };
    renderLists(byOs, platform);
    renderPrimary(pickPrimary(byOs, platform), platform);
    renderMeta(release);
    if (checksums) {
      const p = $('#checksums');
      p.querySelector('a').href = checksums.browser_download_url;
      p.hidden = false;
    }
  }

  main();
})();
