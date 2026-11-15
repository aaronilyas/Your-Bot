// Runs the full validation inside a disposable Ubuntu 26.04 container.
//   node tests/linux/run.mjs [--only <step>] [--keep-image]
// Steps: build, typecheck, vitest, security, integration  (npm ci runs at image build).
// Env: YOUR_BOT_LINUX_FILTER="<vitest filters>" is appended to the vitest step.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const IMAGE = 'your-bot-linux:local';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STEPS = {
  build: 'npm run build',
  typecheck: 'npm run typecheck',
  vitest: 'npx vitest run',
  security: 'npm run test:security',
  integration: 'npm run test:integration',
};

const args = process.argv.slice(2);
const oi = args.indexOf('--only');
const only = oi >= 0 ? args[oi + 1] : undefined;
if (oi >= 0 && !(only in STEPS)) {
  console.error(`unknown step "${only}"; expected one of: ${Object.keys(STEPS).join(', ')}`);
  process.exit(2);
}
const filter = (process.env.YOUR_BOT_LINUX_FILTER ?? '').trim();
if (filter && !/^[\w@./:=,\- ]+$/.test(filter)) {
  console.error('YOUR_BOT_LINUX_FILTER contains unsupported characters');
  process.exit(2);
}
if (filter) STEPS.vitest += ` ${filter}`;

function spawnP(cmd, cmdArgs, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, opts);
    child.once('error', reject);
    child.once('exit', (code, sig) => resolve(code ?? (sig ? 128 : 1)));
    opts.onChild?.(child);
  });
}

// 1. Image build; context is the committed tree only.
const t0 = Date.now();
console.log('== image: git archive HEAD -> docker build (network allowed: apt, node tarball, npm ci)');
const archive = spawn('git', ['archive', '--format=tar', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
const buildCode = await spawnP('docker', ['build', '-f', 'tests/linux/Dockerfile', '-t', IMAGE, '-'],
  { stdio: [archive.stdout, 'inherit', 'inherit'] });
if (buildCode !== 0) { console.error('image build FAILED'); process.exit(1); }
console.log(`== image ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// 2. Tests: no network, no host mounts. SYS_ADMIN + unconfined seccomp/apparmor/systempaths let
// bubblewrap create nested namespaces and mount proc inside this disposable container only.
// One container for all steps so build output (dist) carries over; removed on exit.
const NAME = `your-bot-linux-${process.pid}`;
const started = await spawnP('docker', ['run', '-d', '--name', NAME, '--network', 'none', '--cap-add', 'SYS_ADMIN',
  '--security-opt', 'seccomp=unconfined', '--security-opt', 'apparmor=unconfined',
  '--security-opt', 'systempaths=unconfined', IMAGE, 'sleep', 'infinity'], { stdio: ['ignore', 'ignore', 'inherit'] });
if (started !== 0) { console.error('container start FAILED'); process.exit(1); }
const cleanup = () => spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
process.on('SIGINT', () => { cleanup(); process.exit(130); });
const results = [];
try {
  for (const [name, cmd] of Object.entries(STEPS)) {
    if (only && only !== name) continue;
    // Steps other than build/typecheck need dist; build first when running a single later step.
    const s = Date.now();
    console.log(`\n== step ${name}: ${cmd}`);
    const prefix = only && name !== 'build' ? 'npm run build >/dev/null 2>&1 && ' : '';
    const code = await spawnP('docker', ['exec', NAME, 'sh', '-c', prefix + cmd], { stdio: 'inherit' });
    results.push({ name, code, secs: ((Date.now() - s) / 1000).toFixed(1) });
  }
} finally { cleanup(); }
console.log('\n== summary');
for (const r of results) console.log(`${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.name}  (${r.secs}s)`);
const failed = results.filter(r => r.code !== 0);
console.log(failed.length ? `${failed.length} step(s) failed` : 'all steps passed');
process.exit(failed.length ? 1 : 0);
