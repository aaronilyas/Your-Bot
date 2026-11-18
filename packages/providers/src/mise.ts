import { which } from './environment.js';
import { probeEnvironment, run } from './process.js';

/**
 * mise stores installs under a directory derived from the tool name (`http:kiro-cli` → `http-kiro-cli`),
 * so `mise upgrade` needs the real name. Read it from `mise ls --installed --json`, cached briefly.
 */
let cache: { at: number; searchPath: string; tools: Promise<Record<string, string[]>> } | undefined;

function installedTools(searchPath: string): Promise<Record<string, string[]>> {
  if (cache && cache.searchPath === searchPath && Date.now() - cache.at < 30_000) return cache.tools;
  const tools = (async () => {
    const mise = which(process.platform === 'win32' ? 'mise.exe' : 'mise', searchPath);
    if (!mise) return {};
    const result = await run(mise, ['ls', '--installed', '--json'], { env: probeEnvironment(searchPath), timeoutMs: 10_000, maxBytes: 4 * 1024 * 1024 });
    try {
      const parsed = JSON.parse(result.stdout) as Record<string, { install_path?: unknown }[]>;
      return Object.fromEntries(Object.entries(parsed).map(([name, installs]) => [name, (Array.isArray(installs) ? installs : [])
        .map(install => typeof install.install_path === 'string' ? install.install_path.replace(/\\/g, '/') : '').filter(Boolean)]));
    } catch { return {}; }
  })();
  cache = { at: Date.now(), searchPath, tools };
  return tools;
}

/** The mise tool name owning `installs/<dir>/`, or `fallback` when mise cannot say. */
export async function resolveMiseTool(dir: string | undefined, fallback: string, searchPath: string): Promise<string> {
  if (!dir) return fallback;
  const tools = await installedTools(searchPath);
  const owner = Object.entries(tools).find(([, paths]) => paths.some(install => install.includes(`/mise/installs/${dir}/`)));
  return owner?.[0] ?? fallback;
}
