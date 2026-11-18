import { agentSpec, npmPackageFor } from './catalog.js';
import { agentSearchPath, which } from './environment.js';
import { detectInstallMethod, refineInstall, updatePlan } from './install.js';
import { probeEnvironment, run } from './process.js';
import { scanAgentClis, type AgentCliStatus, type ScanOptions } from './detect.js';

export interface UpdateResult {
  ok: boolean;
  /** Status after the update (re-probed). */
  status?: AgentCliStatus;
  /** The command that ran, shell-style. */
  command?: string;
  message: string;
  output: string;
}

const locks = new Map<string, Promise<UpdateResult>>();

/**
 * Update one agent CLI with the command its install method calls for (mise, npm, bun, pnpm, Volta,
 * Homebrew or the CLI's own updater). Only fixed catalog commands run; nothing comes from the caller
 * except the agent id. Concurrent updates of the same agent share one run.
 */
export function updateAgentCli(id: string, options: ScanOptions & { onOutput?(text: string): void; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<UpdateResult> {
  const existing = locks.get(id);
  if (existing) return existing;
  const task = (async (): Promise<UpdateResult> => {
    const spec = agentSpec(id);
    if (!spec) return { ok: false, message: `Unknown agent ${id}`, output: '' };
    const searchPath = options.searchPath ?? await agentSearchPath(options.env ?? process.env);
    const binary = spec.binaries.map(name => which(name, searchPath)).find(Boolean);
    if (!binary) return { ok: false, message: `${spec.name} is not installed. Install it with: ${spec.install}`, output: '' };
    const [before] = await scanAgentClis({ ...options, ids: [id], searchPath, checkAuth: false, checkUpdates: false });
    const plan = updatePlan(spec, await refineInstall(detectInstallMethod(spec, binary), searchPath), binary, npmPackageFor(spec, before?.version));
    if ('manual' in plan) return { ok: false, message: `${spec.name} can't be updated automatically. ${plan.manual}`, output: '' };
    const tool = plan.command === binary ? binary : which(process.platform === 'win32' && plan.command === 'npm' ? 'npm.cmd' : plan.command, searchPath);
    if (!tool) return { ok: false, command: plan.display, message: `\`${plan.command}\` was not found, so ${spec.name} can't be updated from here. Run: ${plan.display}`, output: '' };
    let output = '';
    const result = await run(tool, plan.args, {
      // Updates are explicit: let mise install the new version, but keep the probe's PATH.
      env: { ...probeEnvironment(searchPath, options.env ?? process.env), MISE_AUTO_INSTALL: '1', CI: '' },
      timeoutMs: options.timeoutMs ?? 30 * 60 * 1000, maxBytes: 1024 * 1024, signal: options.signal,
      onOutput: (_stream, text) => { output += text; options.onOutput?.(text); },
    });
    const [status] = await scanAgentClis({ ...options, ids: [id], searchPath, checkAuth: false });
    if (result.code !== 0) {
      const why = result.timedOut ? 'timed out' : result.error ?? `exited with code ${result.code}`;
      return { ok: false, status, command: plan.display, message: `Updating ${spec.name} failed: ${why}.`, output };
    }
    return { ok: true, status, command: plan.display, message: status?.version ? `${spec.name} is now ${status.version}.` : `${spec.name} was updated.`, output };
  })();
  locks.set(id, task);
  return task.finally(() => locks.delete(id));
}
