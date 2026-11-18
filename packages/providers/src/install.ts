import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { npmPackagesOf, type AgentCliSpec } from './catalog.js';
import { resolveMiseTool } from './mise.js';

/** How an agent CLI was installed, which decides how it is updated. */
export type InstallMethod =
  | { kind: 'mise'; tool: string; dir?: string }
  | { kind: 'npm'; prefix: string; package: string }
  | { kind: 'bun' }
  | { kind: 'pnpm' }
  | { kind: 'volta' }
  | { kind: 'brew'; name: string; cask: boolean }
  | { kind: 'native' }
  | { kind: 'manual'; reason: string };

/** A fixed command to run. `display` is shown to the user and printed by the CLI. */
export interface CommandPlan { command: string; args: string[]; display: string }

const posix = (value: string) => value.replace(/\\/g, '/');

function safeRealpath(file: string): string {
  try { return realpathSync(file); } catch { return file; }
}

function readHead(file: string): string {
  try { return readFileSync(file, { encoding: 'utf8', flag: 'r' }).slice(0, 4096); } catch { return ''; }
}

/**
 * Classify an install from where the binary lives, in T3 Code's order: mise, Nix/MacPorts (manual),
 * bun/pnpm/Volta, npm global, Homebrew, else a native self-updating install.
 */
export function detectInstallMethod(spec: AgentCliSpec, binaryPath: string): InstallMethod {
  const found = posix(binaryPath);
  const real = posix(safeRealpath(binaryPath));
  const both = `${found}\n${real}`;
  const miseInstall = /\/mise\/installs\/([^/]+)\//.exec(real) ?? /\/mise\/installs\/([^/]+)\//.exec(found);
  if (miseInstall && miseInstall[1] !== 'node') return { kind: 'mise', tool: spec.miseTool ?? miseInstall[1]!, dir: miseInstall[1]! };
  if (/\/mise\/(shims|command-wrappers)\//.test(found) || /\/bin\/mise$/.test(real) || /\bmise (x|exec)\b/.test(readHead(binaryPath))) {
    return { kind: 'mise', tool: spec.miseTool ?? spec.binaries[0]! };
  }
  if (both.includes('/nix/store/')) return { kind: 'manual', reason: 'Installed with Nix. Update it through your Nix configuration.' };
  if (/^\/opt\/local\//.test(real)) return { kind: 'manual', reason: 'Installed with MacPorts. Run `sudo port upgrade` for it.' };
  if (both.includes('/.bun/')) return { kind: 'bun' };
  if (/\/pnpm\/(global\/)?/.test(both) || both.includes('/Library/pnpm/')) return { kind: 'pnpm' };
  if (both.includes('/.volta/') || both.includes('/Volta/')) return { kind: 'volta' };
  for (const pkg of npmPackagesOf(spec)) {
    const at = real.indexOf(`/node_modules/${pkg}/`);
    if (at > 0) {
      // <prefix>/lib/node_modules/<pkg>/ on POSIX, <prefix>/node_modules/<pkg>/ on Windows.
      const modules = real.slice(0, at);
      const prefix = modules.endsWith('/lib') ? modules.slice(0, -4) : modules;
      return { kind: 'npm', prefix: process.platform === 'win32' ? path.win32.normalize(prefix) : prefix, package: pkg };
    }
  }
  const brew = /\/(Cellar|Caskroom)\/([^/]+)\//.exec(real);
  if (brew) return { kind: 'brew', name: brew[2]!, cask: brew[1] === 'Caskroom' };
  if (spec.selfUpdate) return { kind: 'native' };
  return { kind: 'manual', reason: `Reinstall it to update: ${spec.install}` };
}

export function describeInstall(method: InstallMethod): string {
  switch (method.kind) {
    case 'mise': return `mise (${method.tool})`;
    case 'npm': return 'npm global';
    case 'brew': return method.cask ? 'Homebrew cask' : 'Homebrew';
    case 'native': return 'standalone installer';
    case 'manual': return 'unmanaged';
    default: return method.kind;
  }
}

function plan(command: string, args: string[]): CommandPlan {
  return { command, args, display: [command, ...args].map(part => /\s/.test(part) ? `"${part}"` : part).join(' ') };
}

/** The command that updates this install, or a reason it must be updated by hand. */
export function updatePlan(spec: AgentCliSpec, method: InstallMethod, binaryPath: string, npmPackage = spec.npmPackage): CommandPlan | { manual: string } {
  const pkg = method.kind === 'npm' ? method.package : npmPackage;
  switch (method.kind) {
    case 'mise': return plan('mise', ['upgrade', method.tool]);
    case 'npm': return pkg ? plan('npm', ['install', '-g', '--prefix', method.prefix, `${pkg}@latest`]) : { manual: spec.install };
    case 'bun': return pkg ? plan('bun', ['install', '-g', `${pkg}@latest`]) : { manual: spec.install };
    case 'pnpm': return pkg ? plan('pnpm', ['add', '-g', `${pkg}@latest`]) : { manual: spec.install };
    case 'volta': return pkg ? plan('volta', ['install', `${pkg}@latest`]) : { manual: spec.install };
    case 'brew': return plan('brew', method.cask ? ['upgrade', '--cask', method.name] : ['upgrade', method.name]);
    case 'native': return spec.selfUpdate ? plan(binaryPath, [...spec.selfUpdate]) : { manual: spec.install };
    case 'manual': return { manual: method.reason };
  }
}

export function loginPlan(spec: AgentCliSpec, binaryPath: string): CommandPlan {
  return plan(binaryPath, [...spec.login]);
}

/** Replace a guessed mise tool name with the one mise reports (e.g. `http:kiro-cli`). */
export async function refineInstall(method: InstallMethod, searchPath: string): Promise<InstallMethod> {
  if (method.kind !== 'mise' || !method.dir) return method;
  return { ...method, tool: await resolveMiseTool(method.dir, method.tool, searchPath) };
}
