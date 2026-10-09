import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ExecutorError } from './files.js';

export function validatePackages(packages: unknown): asserts packages is string[] {
  if (!Array.isArray(packages) || !packages.length || packages.length > 16 ||
    !packages.every(p => typeof p === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*(?:==[A-Za-z0-9][A-Za-z0-9._+!-]*)?$/.test(p)) ||
    new Set(packages.map(p => p.toLowerCase().replace(/[_.]/g, '-'))).size !== packages.length) {
    throw new ExecutorError('INVALID_PACKAGES', 'Approve exact PyPI names, optionally ==version; URLs, flags, extras, ranges and duplicates are refused');
  }
}
async function boundedFetch(url: string, signal: AbortSignal, limit: number): Promise<Buffer> {
  const response = await fetch(url, { signal, redirect: 'error', headers: { 'User-Agent': 'YourBot-executor/1' } });
  if (!response.ok || !response.body) throw new ExecutorError('PACKAGE_DOWNLOAD_FAILED', 'Package source returned HTTP ' + response.status);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) throw new ExecutorError('PACKAGE_DOWNLOAD_LIMIT', 'Package response exceeded its size limit');
      parts.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(parts);
}
/** Network is host-brokered to two HTTPS origins. The pip sandbox stays offline. */
export async function downloadWheels(packages: string[], destination: string, signal: AbortSignal): Promise<string[]> {
  const wheels: string[] = [];
  let total = 0;
  for (const spec of packages) {
    const [name, version] = spec.split('==');
    const endpoint = `https://pypi.org/pypi/${encodeURIComponent(name)}${version ? '/' + encodeURIComponent(version) : ''}/json`;
    const metadata = JSON.parse((await boundedFetch(endpoint, signal, 4 * 1024 * 1024)).toString()) as {
      info?: { name: string; version: string };
      urls?: { filename: string; url: string; digests: { sha256: string }; yanked: boolean }[];
    };
    const normalize = (value: string) => value.toLowerCase().replace(/[-_.]+/g, '-');
    if (!metadata.info || normalize(metadata.info.name) !== normalize(name) || (version && metadata.info.version !== version)) {
      throw new ExecutorError('PACKAGE_INTEGRITY_FAILED', 'Registry identity differs from the approved package');
    }
    // Conservative compatibility: universal, pure Python wheels only. No builds.
    const candidates = metadata.urls?.filter(w => !w.yanked && normalize(w.filename.split('-')[0]) === normalize(name) && w.filename.split('-')[1] === metadata.info!.version && /(?:-py3|-py2\.py3)-none-any\.whl$/.test(w.filename));
    const wheel = candidates?.[0];
    if (!wheel || path.basename(wheel.filename) !== wheel.filename || !/^[A-Za-z0-9._+-]+\.whl$/.test(wheel.filename)) {
      throw new ExecutorError('PACKAGE_UNSUPPORTED', 'Only universal pure-Python wheels are supported: ' + spec);
    }
    const url = new URL(wheel.url);
    if (url.protocol !== 'https:' || url.hostname !== 'files.pythonhosted.org' || url.port || url.username || url.password) {
      throw new ExecutorError('PACKAGE_DOWNLOAD_FAILED', 'Wheel origin was not approved');
    }
    const bytes = await boundedFetch(url.href, signal, 32 * 1024 * 1024);
    total += bytes.length;
    if (total > 64 * 1024 * 1024) throw new ExecutorError('PACKAGE_DOWNLOAD_LIMIT', 'Total wheel download exceeds 64 MiB');
    if (createHash('sha256').update(bytes).digest('hex') !== wheel.digests.sha256) {
      throw new ExecutorError('PACKAGE_INTEGRITY_FAILED', 'Wheel SHA-256 differs from registry metadata');
    }
    await writeFile(path.join(destination, wheel.filename), bytes, { flag: 'wx', mode: 0o600 });
    wheels.push('/wheels/' + wheel.filename);
  }
  return wheels;
}
