import { spawn } from 'node:child_process';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentSpec } from './catalog.js';
import { agentSearchPath, which } from './environment.js';
import { loginPlan, type CommandPlan } from './install.js';

/**
 * Sign-in commands are interactive (browser hand-off, device codes, prompts), so the desktop app opens
 * them in the user's terminal, as if typed there. The CLI runs them in the current terminal instead.
 */

export interface LoginTarget { plan: CommandPlan; name: string }

export async function loginTarget(id: string, searchPath?: string): Promise<LoginTarget> {
  const spec = agentSpec(id);
  if (!spec) throw new Error(`Unknown agent ${id}`);
  if (!spec.login.length) throw new Error(`${spec.name} signs in the first time it runs, or with an API key in your environment. See ${spec.docs}`);
  const pathValue = searchPath ?? await agentSearchPath();
  const binary = spec.binaries.map(name => which(name, pathValue)).find(Boolean);
  if (!binary) throw new Error(`${spec.name} is not installed. Install it with: ${spec.install}`);
  return { plan: loginPlan(spec, binary), name: spec.name };
}

const POSIX_HOLD = 'printf "\\033]0;%s\\007" "Your Bot sign-in"; "$0" "$@"; status=$?; echo; if [ $status -eq 0 ]; then echo "Done. You can close this window."; else echo "Sign-in exited with status $status."; fi; printf "Press Enter to close. "; read _';

/** Terminal emulators and how each takes a command, in preference order. */
const LINUX_TERMINALS: { bin: string; prefix: readonly string[] }[] = [
  { bin: 'xdg-terminal-exec', prefix: [] },
  { bin: 'x-terminal-emulator', prefix: ['-e'] },
  { bin: 'ghostty', prefix: ['-e'] },
  { bin: 'kitty', prefix: [] },
  { bin: 'alacritty', prefix: ['-e'] },
  { bin: 'foot', prefix: [] },
  { bin: 'wezterm', prefix: ['start', '--'] },
  { bin: 'gnome-terminal', prefix: ['--'] },
  { bin: 'konsole', prefix: ['-e'] },
  { bin: 'xfce4-terminal', prefix: ['-x'] },
  { bin: 'tilix', prefix: ['-e'] },
  { bin: 'xterm', prefix: ['-e'] },
];

function detach(file: string, args: string[], options: { windowsVerbatimArguments?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false, ...options });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

/** Open the sign-in command in a new terminal window. Rejects with a message naming the command to run by hand. */
export async function openInTerminal(target: LoginTarget, env: NodeJS.ProcessEnv = process.env, searchPath?: string): Promise<void> {
  const { plan } = target;
  const fallback = `Open a terminal and run: ${plan.display}`;
  if (process.platform === 'darwin') {
    const dir = await mkdtemp(path.join(tmpdir(), 'your-bot-login-'));
    const script = path.join(dir, 'sign-in.command');
    const quoted = [plan.command, ...plan.args].map(part => `'${part.replace(/'/g, `'\\''`)}'`).join(' ');
    await writeFile(script, `#!/bin/sh\nsh -c '${POSIX_HOLD.replace(/'/g, `'\\''`)}' ${quoted}\n`, { mode: 0o700 });
    await chmod(script, 0o700);
    await detach('/usr/bin/open', ['-a', 'Terminal', script]).catch(() => { throw new Error(fallback); });
    return;
  }
  if (process.platform === 'win32') {
    const quote = (part: string) => /[\s&()^|<>"]/.test(part) ? `"${part.replace(/"/g, '""')}"` : part;
    const line = [plan.command, ...plan.args].map(quote).join(' ');
    const comspec = env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    await detach(comspec, ['/d', '/c', `start "Your Bot sign-in" "${comspec}" /k ${line}`], { windowsVerbatimArguments: true }).catch(() => { throw new Error(fallback); });
    return;
  }
  const pathValue = searchPath ?? await agentSearchPath(env);
  const preferred = env.TERMINAL ? [{ bin: env.TERMINAL, prefix: ['-e'] as readonly string[] }] : [];
  for (const terminal of [...preferred, ...LINUX_TERMINALS]) {
    const bin = path.isAbsolute(terminal.bin) ? terminal.bin : which(terminal.bin, pathValue);
    if (!bin) continue;
    try { await detach(bin, [...terminal.prefix, '/bin/sh', '-c', POSIX_HOLD, plan.command, ...plan.args]); return; }
    catch { /* try the next terminal */ }
  }
  throw new Error(`No terminal app was found. ${fallback}`);
}
