import { copyFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
await mkdir('.validation', { recursive: true });
await copyFile('node_modules/electron/dist/resources/default_app.asar', '.validation/default_app.asar');
async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
await run('docker', ['build', '-f', 'tests/desktop.Dockerfile', '-t', 'your-bot-validation:local', '.']);
// The disposable container permits Chromium to establish its own namespace and
// seccomp sandbox. No sandbox-disable flag, host mount or host policy change.
await run('docker', ['run', '--rm', '--network', 'none', '--cap-add', 'SYS_ADMIN',
  '--security-opt', 'seccomp=unconfined', '--security-opt', 'apparmor=unconfined',
  '--security-opt', 'systempaths=unconfined', 'your-bot-validation:local']);
