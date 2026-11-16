#!/usr/bin/env node
/**
 * Unattended Your Bot demo.
 * Host on this machine, trusted Grok Build bot, standing-grant routine,
 * then a paired device on the SSH host `ubuntu` answers one approval.
 * Prints PASS/FAIL per step and exits non-zero on any failure.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hostBin = join(root, 'apps/host/dist/bin.js');
const SSH = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=30'];

const marker = `yb${randomBytes(8).toString('hex')}`;
const routineMarker = `yr${randomBytes(8).toString('hex')}`;
const remoteMarker = `yd${randomBytes(8).toString('hex')}`;

const state = {
  dataDir: '',
  workspace: '',
  host: undefined,
  hostExit: undefined,
  hostLog: [],
  watch: undefined,
  events: [],
  text: new Map(),
  problems: [],
  autoApprove: false,
  approved: new Set(),
  routinePerms: [],
  phase: '',
  botId: '',
  sessionId: '',
  ubuntu: undefined,
  prep: undefined,
};

function log(line) {
  process.stderr.write(`${line}\n`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shellSingle(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function summarizeRequest(request) {
  if (!request || typeof request !== 'object') return String(request);
  const command = request.command ? JSON.stringify([request.command.command, ...(request.command.args ?? [])]) : '';
  const paths = (request.paths ?? []).map(path => path.path).join(',');
  const tool = request.agentTool ? `${request.agentTool.kind ?? ''}:${request.agentTool.title ?? ''}` : '';
  return `${request.id ?? ''} ${request.capability ?? ''} ${command} ${paths} ${tool} ${(request.reason ?? '').replace(/\s+/g, ' ')}`.trim().slice(0, 600);
}

function remember(line, bucket) {
  bucket.push(line);
  if (bucket.length > 80) bucket.shift();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function git(args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`git ${args[0]} timed out`)); }, timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`git ${args.join(' ')} exited ${code}: ${(stderr || stdout).trim()}`));
      else resolve(stdout);
    });
  });
}

function hostCommand(args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hostBin, '--data', state.dataDir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`your-bot-host ${args[0] ?? ''} timed out`)); }, timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function hostOk(args, timeoutMs) {
  const result = await hostCommand(args, timeoutMs);
  if (result.code !== 0) throw new Error(`your-bot-host ${args.join(' ')} exited ${result.code}: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

async function ctl(command, timeoutMs = 30_000) {
  const result = await hostCommand(['ctl', JSON.stringify(command)], timeoutMs);
  const line = result.stdout.trim().split('\n').filter(Boolean).at(-1);
  let parsed;
  try { parsed = JSON.parse(line ?? ''); }
  catch { throw new Error(`ctl ${command.type} produced no JSON (status ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 800)}`); }
  if (!parsed.ok) throw new Error(`ctl ${command.type}: ${parsed.error?.code ?? 'ERROR'}: ${parsed.error?.message ?? 'failed'}`);
  return parsed;
}

function ssh(host, script, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn('ssh', [...SSH, host, 'bash', '-s'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, child });
    });
    child.stdin.end(script);
  });
}

function startSsh(host, script) {
  const child = spawn('ssh', [...SSH, host, 'bash', '-s'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(script);
  return child;
}

function linesOf(stream, onLine) {
  const rl = createInterface({ input: stream });
  rl.on('line', onLine);
  return rl;
}

function requireAlive() {
  if (state.hostExit) throw new Error(`host exited early code=${state.hostExit.code} signal=${state.hostExit.signal} log=${state.hostLog.slice(-15).join(' | ')}`);
}

/** The second machine clones the current branch from origin; the demo never pushes. */
async function pushBranch() {
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.trim()) {
    log('working tree is dirty; the second machine uses the committed branch on origin');
  }
  await git(['fetch', 'origin', branch], 120_000);
  const head = (await git(['rev-parse', 'HEAD'])).trim();
  const remote = (await git(['rev-parse', `origin/${branch}`])).trim();
  if (head !== remote) throw new Error(`push ${branch} first: HEAD ${head.slice(0, 7)} != origin ${remote.slice(0, 7)}`);
  log(`using origin/${branch} at ${head.slice(0, 7)}`);
  return branch;
}

function onWatchLine(line) {
  let event;
  try { event = JSON.parse(line); }
  catch { remember(`watch ${line}`, state.hostLog); return; }
  state.events.push(event);
  if (event.type === 'message.delta' && event.taskId && typeof event.text === 'string') {
    state.text.set(event.taskId, (state.text.get(event.taskId) ?? '') + event.text);
  }
  if (event.type === 'permission.requested') {
    log(`permission ${summarizeRequest(event.request)}`);
    if (state.phase === 'routine') state.routinePerms.push(event.request);
    if (state.autoApprove && event.request?.id && !state.approved.has(event.request.id)) {
      state.approved.add(event.request.id);
      const id = event.request.id;
      void hostOk(['approve', id, '--scope', 'once']).then(() => log(`allowed ${id}`), error => {
        state.approved.delete(id);
        state.problems.push(error instanceof Error ? error.message : String(error));
      });
    }
  }
}

async function waitUntil(label, timeoutMs, check) {
  const start = Date.now();
  for (;;) {
    requireAlive();
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeoutMs) {
      const tail = state.events.slice(-12).map(event => event.type).join(',');
      throw new Error(`timed out waiting for ${label} (${Math.round(timeoutMs / 1000)}s) events=${tail} problems=${state.problems.join('; ')}`);
    }
    await sleep(400);
  }
}

function taskEvent(type, taskId) {
  return state.events.find(event => event.type === type && event.taskId === taskId);
}

async function waitTask(taskId, timeoutMs) {
  return waitUntil(`task ${taskId}`, timeoutMs, async () => {
    const failed = taskEvent('task.failed', taskId);
    if (failed) throw new Error(`task failed: ${failed.error?.code}: ${failed.error?.message}`);
    if (taskEvent('task.cancelled', taskId)) throw new Error('task cancelled');
    return taskEvent('task.completed', taskId);
  });
}

async function assistantText(sessionId, taskId) {
  const sync = await ctl({ type: 'state.sync' });
  const session = sync.snapshot?.sessions?.find(item => item.id === sessionId);
  const saved = (session?.messages ?? []).filter(message => message.role === 'assistant' && message.taskId === taskId).map(message => message.content).join('\n');
  return saved || state.text.get(taskId) || '';
}

async function audits(taskId) {
  const listed = await ctl({ type: 'audit.list', botId: state.botId, limit: 200 });
  return (listed.audit ?? []).filter(entry => entry.taskId === taskId);
}

async function assertFile(name, expected) {
  const path = join(state.workspace, name);
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    const entries = await readdir(state.workspace).catch(() => []);
    throw new Error(`${name} missing (${error.code}); workspace: ${entries.join(', ') || '(empty)'}`);
  }
  if (text.trim() !== expected) throw new Error(`${name} content ${JSON.stringify(text)} is not ${expected}`);
}

function startUbuntuPrep(branch) {
  const script = `
set -u
dir=$(mktemp -d /tmp/yb-demo-XXXXXX)
echo "DIR=$dir"
echo "PID=$$"
trap 'status=$?; echo LOGS; tail -n 40 "$dir"/*.log 2>/dev/null || true; exit $status' ERR
set -e
branch=${shellSingle(branch)}
if ! git clone --branch "$branch" --single-branch --depth 1 git@github.com:aaronilyas/Your-Bot.git "$dir/repo" >"$dir/clone-ssh.log" 2>&1; then
  git clone --branch "$branch" --single-branch --depth 1 https://github.com/aaronilyas/Your-Bot.git "$dir/repo" >"$dir/clone-https.log" 2>&1
fi
cd "$dir/repo"
npm ci >"$dir/npm.log" 2>&1
npm run build -w @your-bot/contracts >"$dir/build-contracts.log" 2>&1
npm run build -w @your-bot/remote >"$dir/build-remote.log" 2>&1
mkdir -p "$dir/remote-home"
chmod 700 "$dir/remote-home"
echo READY
`;
  const child = startSsh('ubuntu', script);
  const prep = {
    child,
    dir: '',
    pid: '',
    ready: false,
    done: undefined,
    output: '',
  };
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; prep.output = stdout; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  linesOf(child.stdout, line => {
    if (line.startsWith('DIR=')) prep.dir = line.slice(4).trim();
    if (line.startsWith('PID=')) prep.pid = line.slice(4).trim();
    if (line === 'READY') prep.ready = true;
    if (line.startsWith('DIR=') || line.startsWith('PID=') || line === 'READY' || line === 'LOGS') log(`ubuntu ${line}`);
  });
  prep.done = new Promise(resolve => {
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
  state.prep = prep;
  return prep;
}

function ubuntuPaths() {
  const dir = state.prep?.dir ?? '';
  if (!/^\/tmp\/yb-demo-[A-Za-z0-9]+$/.test(dir)) throw new Error(`unexpected ubuntu dir ${JSON.stringify(dir)}`);
  return { dir, repo: `${dir}/repo`, home: `${dir}/remote-home` };
}

async function ubuntuNode(args, timeoutMs = 60_000) {
  const { repo, home } = ubuntuPaths();
  const script = `
set -euo pipefail
export YOUR_BOT_REMOTE_HOME=${shellSingle(home)}
cd ${shellSingle(repo)}
node packages/remote/dist/bin.js ${args}
`;
  const result = await ssh('ubuntu', script, timeoutMs);
  return result;
}

async function probeAdvertised(urls) {
  const checks = [];
  for (const url of urls.split(',').map(item => item.trim()).filter(Boolean)) {
    const match = /^wss:\/\/(\d{1,3}(?:\.\d{1,3}){3}):(\d+)\/ws$/.exec(url);
    if (!match) checks.push(`echo ${shellSingle(`BAD ${url}`)}`);
    else checks.push(`timeout 4 bash -c 'echo >/dev/tcp/${match[1]}/${match[2]}' && echo ${shellSingle(`OPEN ${url}`)} || echo ${shellSingle(`CLOSED ${url}`)}`);
  }
  const script = `
set +e
${checks.join('\n')}
`;
  const result = await ssh('ubuntu', script, 30_000);
  log(result.stdout.trim() || result.stderr.trim());
  return result.stdout;
}

async function stepHost() {
  const grok = spawnSync('grok', ['--version'], { encoding: 'utf8' });
  if (grok.status !== 0) throw new Error('grok is not on PATH');
  try { await readFile(hostBin); }
  catch { throw new Error('apps/host/dist/bin.js is missing; run npm run build'); }
  state.workspace = await realpath(await mkdtemp(join(tmpdir(), 'yb-demo-ws-')));
  state.dataDir = await realpath(await mkdtemp(join(tmpdir(), 'yb-demo-data-')));
  await hostOk(['init', '--name', 'demo']);
  const port = await freePort();
  const child = spawn(process.execPath, [hostBin, '--data', state.dataDir, 'run', '--listen', `0.0.0.0:${port}`, '--name', 'demo'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.host = child;
  const info = {};
  linesOf(child.stdout, line => {
    remember(`out ${line}`, state.hostLog);
    if (line.startsWith('fingerprint ')) info.fingerprint = line.slice('fingerprint '.length).trim();
    if (line.startsWith('listen ')) info.listen = line.slice('listen '.length).trim();
    if (line.startsWith('host ')) info.host = line.slice('host '.length).trim();
    if (line.startsWith('remoteHost ')) info.remoteHost = line.slice('remoteHost '.length).trim();
  });
  linesOf(child.stderr, line => remember(`err ${line}`, state.hostLog));
  child.on('exit', (code, signal) => { state.hostExit = { code, signal }; });
  await waitUntil('host advertisement', 30_000, async () => (info.fingerprint && info.listen ? info : undefined));
  state.info = info;
  console.log(`advertised ${info.listen}`);
  console.log(`fingerprint ${info.fingerprint}`);
  const watch = spawn(process.execPath, [hostBin, '--data', state.dataDir, 'watch'], { stdio: ['ignore', 'pipe', 'pipe'] });
  state.watch = watch;
  linesOf(watch.stdout, onWatchLine);
  linesOf(watch.stderr, line => remember(`watch ${line}`, state.hostLog));
  await sleep(300);
  requireAlive();
}

async function stepConfigure() {
  requireAlive();
  await ctl({
    type: 'settings.update',
    settings: {
      providers: [{
        id: 'grok', name: 'Grok', kind: 'acp', enabled: true, launch: 'host',
        command: 'grok', args: ['agent', 'stdio'],
      }],
    },
  });
  const instructions = 'Follow the latest user message exactly and finish. Do not ask questions.';
  const created = await hostOk(['bot', 'create', '--name', 'Demo', '--agent', 'grok', '--profile', 'trusted', '--workspace', state.workspace, '--instructions', instructions]);
  const botId = /^bot (\S+)/m.exec(created)?.[1];
  if (!botId) throw new Error(`bot create returned ${JSON.stringify(created.trim())}`);
  state.botId = botId;
  const session = await ctl({ type: 'bot.session.create', botId });
  if (!session.sessionId) throw new Error('bot session was not created');
  state.sessionId = session.sessionId;
  log(`bot ${botId} session ${session.sessionId}`);
}

async function stepInteractive() {
  requireAlive();
  state.phase = 'interactive';
  state.autoApprove = true;
  const content = [
    `Write a file named demo.txt in the workspace whose exact contents are ${marker}.`,
    'Then run this command and wait until it exits: cat demo.txt',
    'Reply with the command output only.',
  ].join('\n');
  const sent = await ctl({ type: 'message.send', sessionId: state.sessionId, content });
  if (!sent.taskId) throw new Error('message.send returned no task');
  log(`interactive task ${sent.taskId}`);
  await waitTask(sent.taskId, 600_000);
  state.autoApprove = false;
  const statuses = state.events.filter(event => event.type === 'task.status' && event.taskId === sent.taskId).map(event => event.status);
  log(`agent statuses: ${[...new Set(statuses)].join(' | ')}`);
  log(`agent reply: ${JSON.stringify((await assistantText(state.sessionId, sent.taskId)).slice(0, 800))}`);
  await assertFile('demo.txt', marker);
  const text = await assistantText(state.sessionId, sent.taskId);
  if (!text.includes(marker)) throw new Error(`command output did not appear in the assistant reply: ${JSON.stringify(text.slice(0, 500))}`);
  const rows = await audits(sent.taskId);
  const allowed = capability => rows.some(entry => entry.capability === capability && entry.outcome === 'allow');
  if (!allowed('file.write') || !allowed('process.spawn')) {
    throw new Error(`audit missing file.write or process.spawn: ${JSON.stringify(rows.map(entry => ({ capability: entry.capability, via: entry.via, subject: entry.subject })))}`);
  }
  log(`interactive audit ${rows.map(entry => `${entry.capability}/${entry.via}`).join(', ')}`);
}

async function stepRoutine() {
  requireAlive();
  state.phase = 'routine';
  state.autoApprove = false;
  state.routinePerms = [];
  await hostOk(['grant', 'create', '--bot', state.botId, '--capability', 'file.write', '--folder', state.workspace]);
  for (const prefix of ['pwd', '/bin/pwd', '/usr/bin/pwd']) {
    await hostOk(['grant', 'create', '--bot', state.botId, '--capability', 'process.spawn', '--folder', state.workspace, '--prefix', prefix]);
  }
  const at = new Date(Date.now() + 8_000).toISOString();
  const prompt = [
    `Write a file named routine.txt in the workspace whose exact contents are ${routineMarker}.`,
    'Then run this command and wait until it exits: pwd',
    'Do not read files or run any other command. Reply with the command output only.',
  ].join('\n');
  const created = await hostOk(['routine', 'create', '--bot', state.botId, '--name', 'soon', '--prompt', prompt, '--at', at, '--session', 'new', '--missed', 'skip']);
  const routineId = /^routine (\S+)/m.exec(created)?.[1];
  if (!routineId) throw new Error(`routine create returned ${JSON.stringify(created.trim())}`);
  log(`routine ${routineId} at ${at}`);
  const run = await waitUntil('routine completion', 600_000, async () => {
  if (state.routinePerms.length) throw new Error(`permission.requested during routine: ${state.routinePerms.map(summarizeRequest).join(' || ')}`);
    const events = state.events.filter(event => event.type === 'routine.run' && event.run?.routineId === routineId);
    const latest = events.at(-1)?.run;
    if (!latest) return undefined;
    if (latest.status === 'blocked') throw new Error(`routine blocked on ${(latest.blockedOn ?? []).join(',')}`);
    if (latest.status === 'failed') throw new Error(`routine failed: ${latest.error?.code}: ${latest.error?.message}`);
    if (latest.status === 'skipped' || latest.status === 'cancelled' || latest.status === 'interrupted') throw new Error(`routine ${latest.status}`);
    if (latest.status === 'completed') return latest;
    return undefined;
  });
  log(`routine reply: ${JSON.stringify((await assistantText(run.sessionId, run.taskId)).slice(0, 800))}`);
  if (state.routinePerms.length) throw new Error(`permission.requested during routine: ${state.routinePerms.map(summarizeRequest).join(' || ')}`);
  await assertFile('routine.txt', routineMarker);
  const rows = await audits(run.taskId);
  const standing = capability => rows.filter(entry => entry.capability === capability && entry.outcome === 'allow' && entry.via === 'standing');
  if (!standing('file.write').length || !standing('process.spawn').length) {
    throw new Error(`standing audit missing: ${JSON.stringify(rows.map(entry => ({ capability: entry.capability, via: entry.via, subject: entry.subject, decidedBy: entry.decidedBy })))}`);
  }
  log(`routine audit ${rows.map(entry => `${entry.capability}/${entry.via}`).join(', ')}`);
}

async function stepRemote(branch) {
  requireAlive();
  state.phase = 'remote';
  state.autoApprove = false;
  const prep = state.prep;
  if (!prep) throw new Error('ubuntu prep was not started');
  const finished = await Promise.race([
    prep.done,
    (async () => {
      await waitUntil('ubuntu build', 20 * 60_000, async () => prep.ready);
      return undefined;
    })(),
  ]);
  if (!prep.ready) {
    throw new Error(`ubuntu prep failed status ${finished?.code}: ${(finished?.stdout || prep.output || '').slice(-2000)}\n${(finished?.stderr || '').slice(-1000)}`);
  }
  const { home } = ubuntuPaths();
  log(`probing advertised URLs from ubuntu`);
  const probe = await probeAdvertised(state.info.listen);
  if (!probe.includes('OPEN ')) throw new Error(`ubuntu cannot open any advertised URL:\n${probe}`);
  const codeResult = await hostOk(['pair', '--name', 'ubuntu-demo']);
  const code = /^code (\S+)/m.exec(codeResult)?.[1];
  if (!code || !/^ybp1\.[A-Za-z0-9_-]+$/.test(code)) throw new Error('host did not return a pairing code');
  const paired = await ubuntuNode(`pair ${shellSingle(code)} --name ubuntu-demo`, 90_000);
  if (paired.code !== 0) throw new Error(`pair failed: ${paired.stderr || paired.stdout}`);
  log(paired.stdout.trim());
  const deviceId = /as device (\S+)/.exec(paired.stdout)?.[1];
  if (!deviceId) throw new Error(`pair output had no device id: ${paired.stdout.trim()}`);
  const remoteSession = await ctl({ type: 'bot.session.create', botId: state.botId });
  const content = [
    `Run this command and wait until it exits: echo ${remoteMarker}`,
    'Do not write files or run any other command. Reply with the command output only.',
  ].join('\n');
  const sent = await ctl({ type: 'message.send', sessionId: remoteSession.sessionId, content });
  if (!sent.taskId) throw new Error('remote message returned no task');
  log(`remote task ${sent.taskId}`);
  const decided = new Set();
  await waitUntil('remote approval', 600_000, async () => {
    const failed = taskEvent('task.failed', sent.taskId);
    if (failed) throw new Error(`remote task failed: ${failed.error?.code}: ${failed.error?.message}`);
    const listed = await ubuntuNode('approvals --json', 40_000);
    if (listed.code !== 0) throw new Error(`approvals failed before revoke: ${listed.stderr || listed.stdout}`);
    let pending = [];
    try { pending = JSON.parse(listed.stdout.trim() || '[]'); }
    catch { throw new Error(`approvals JSON was ${JSON.stringify(listed.stdout.slice(0, 400))}`); }
    for (const item of pending) {
      const id = item?.request?.id;
      if (!id || decided.has(id)) continue;
      decided.add(id);
      log(`remote approving ${summarizeRequest(item.request)}`);
      const allowed = await ubuntuNode(`approve ${shellSingle(id)} --scope once`, 40_000);
      if (allowed.code !== 0) throw new Error(`remote approve ${id} failed: ${allowed.stderr || allowed.stdout}`);
      log(allowed.stdout.trim());
    }
    return taskEvent('task.completed', sent.taskId);
  });
  const text = await assistantText(remoteSession.sessionId, sent.taskId);
  if (!text.includes(remoteMarker)) throw new Error(`remote command output did not appear: ${JSON.stringify(text.slice(0, 500))}`);
  const rows = await audits(sent.taskId);
  const device = `device:${deviceId}`;
  if (!rows.some(entry => entry.decidedBy === device && entry.outcome === 'allow')) {
    throw new Error(`no audit decided by ${device}: ${JSON.stringify(rows.map(entry => ({ capability: entry.capability, via: entry.via, decidedBy: entry.decidedBy, subject: entry.subject })))}`);
  }
  log(`remote audit decidedBy ${device}`);
  await hostOk(['revoke', deviceId]);
  const revoked = await ubuntuNode('approvals --json', 40_000);
  const body = `${revoked.stderr}\n${revoked.stdout}`;
  if (revoked.code === 0) throw new Error(`approvals still succeeded after revoke: ${body}`);
  if (!/revok|4003/i.test(body)) throw new Error(`approvals failed without a revocation error (exit ${revoked.code}): ${body.slice(0, 800)}`);
  log(`revoked device ${deviceId}; remote approvals rejected`);
}

async function teardown() {
  state.autoApprove = false;
  if (state.watch && !state.watch.killed) state.watch.kill('SIGTERM');
  if (state.host && state.host.exitCode === null && !state.host.killed) {
    state.host.kill('SIGTERM');
    const exited = sleep(8_000).then(() => false);
    const closed = new Promise(resolve => state.host.once('exit', () => resolve(true)));
    if (!await Promise.race([closed, exited])) state.host.kill('SIGKILL');
  }
  const prep = state.prep;
  if (prep?.child && prep.child.exitCode === null) prep.child.kill('SIGTERM');
  if (prep && !prep.dir) {
    const found = /DIR=(\/tmp\/yb-demo-[A-Za-z0-9]+)/.exec(prep.output || '');
    if (found) prep.dir = found[1];
  }
  if (prep?.dir && /^\/tmp\/yb-demo-[A-Za-z0-9]+$/.test(prep.dir)) {
    const pid = /^\d+$/.test(prep.pid) ? prep.pid : '';
    const script = `
set +e
${pid ? `kill -TERM -- -${pid} 2>/dev/null || true; sleep 1; kill -KILL -- -${pid} 2>/dev/null || true` : ''}
rm -rf -- ${shellSingle(prep.dir)}
if [ -e ${shellSingle(prep.dir)} ]; then echo STILL_THERE; exit 1; fi
echo REMOVED
`;
    const removed = await ssh('ubuntu', script, 30_000);
    if (removed.code !== 0 || !removed.stdout.includes('REMOVED')) log(`ubuntu cleanup: ${removed.stdout} ${removed.stderr}`);
    else log(`removed ${prep.dir}`);
  }
  if (state.dataDir) await rm(state.dataDir, { recursive: true, force: true });
  if (state.workspace) await rm(state.workspace, { recursive: true, force: true });
}

async function runStep(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
    if (state.problems.length) console.error(state.problems.join('\n'));
    if (state.hostLog.length) console.error(state.hostLog.slice(-20).join('\n'));
    throw Object.assign(new Error(name), { printed: true });
  }
}

async function main() {
  let failed = false;
  try {
    const branch = await pushBranch();
    startUbuntuPrep(branch);
    await runStep('host', stepHost);
    await runStep('configure', stepConfigure);
    await runStep('interactive', stepInteractive);
    await runStep('routine', stepRoutine);
    await runStep('remote', () => stepRemote(branch));
  } catch (error) {
    failed = true;
    if (!error || !error.printed) console.log(`FAIL demo: ${error instanceof Error ? error.message : error}`);
  } finally {
    try { await teardown(); console.log('PASS teardown'); }
    catch (error) {
      failed = true;
      console.log(`FAIL teardown: ${error instanceof Error ? error.message : error}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

await main();
