import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AppSettingsV2, BotInput, CapabilityV2, CommandResultV2, DesktopCommandV2, MissedRunPolicy, Notifier, ProviderConfigV2, RoutineInput, StandingGrantScope } from '@your-bot/contracts';
import { agentSpec, linkProviders, linkedProvider, loginTarget, scanProviders, updateAgentCli, type AgentCliSpec, type LoginTarget, type ProviderScan } from '@your-bot/providers';
import { createRuntime, prepareDataLayout, type RuntimeListen } from '@your-bot/runtime';
import { connectControl, ControlClientError } from './client.js';
import { startControlServer } from './control.js';
import { controlEndpoint } from './endpoint.js';
import { ensureControlToken, readControlToken, tokenPath } from './token.js';

/** Talks to a running app or `your-bot-host run`. Undefined means it is not running. */
export interface OwnerSession {
  call(command: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

/** Provider operations. Tests inject these so a run does not probe the real machine. */
export interface ProvidersDeps {
  scanProviders: typeof scanProviders;
  linkProviders: typeof linkProviders;
  updateAgentCli: typeof updateAgentCli;
  loginTarget: typeof loginTarget;
  agentSpec: typeof agentSpec;
}

export interface CliIO {
  env: Record<string, string | undefined>;
  stdout(line: string): void;
  stderr(line: string): void;
  /** Raw stdout, used for update output that is not line-oriented. */
  write?(text: string): void;
  /** Ends `run` and `watch`. */
  signal?: AbortSignal;
  providers?: ProvidersDeps;
  /** When omitted, connects to the owner control socket. */
  connectOwner?(dataDir: string): Promise<OwnerSession | undefined>;
  /** Sign-in with inherited stdio. When omitted, the login plan is spawned (`shell: false`). */
  runLogin?(plan: LoginTarget['plan']): Promise<number>;
}

const USAGE_TEXT = `Usage: your-bot-host [--data <dir>] <command>
  init [--name <name>]
  run [--listen <host:port>] [--name <name>] [--agent-timeout <seconds>]
  ctl '<json v2 command>'
  pair [--name <device>]
  devices
  revoke <deviceId>
  bot create --name <name> --agent <id> --profile strict|trusted [--workspace <dir>] [--instructions <text>] [--model <id>] [--memory]
  grant create --bot <id> --capability <capability> [--folder <dir>] [--prefix <arg>]... [--mcp-server <id>] [--mcp-tool <name>] [--agent-tool-kind <kind>] [--expires <iso>]
  routine create --bot <id> --name <name> --prompt <text> (--every <minutes> | --cron <expr> [--timezone <iana>] | --at <iso>) [--missed skip|runOnce|runAll] [--session new|reuse] [--max-catch-up <n>] [--disabled]
  approvals
  approve <requestId> [--deny] [--scope once|task|standing] [--folder <dir>] [--prefix <arg>]... [--mcp-server <id>] [--mcp-tool <name>] [--agent-tool-kind <kind>] [--expires <iso>]
  watch
  providers list [--json] [--no-updates] [--no-auth]
  providers link [<id>...] [--all]
  providers update [<id>...] [--all]
  providers login <id>

Data directory: --data or $YOUR_BOT_DATA.
The desktop app installs this same CLI as \`your-bot\`.
providers list scans this machine. It annotates links from the running app when the control socket answers, otherwise from no saved providers.
providers link requires a running app (or \`your-bot-host run\`).
providers update runs locally. providers login runs the agent's sign-in in this terminal.
init creates the 0700 data directory and a 0600 control token (kept if it already exists).
run stays in the foreground and opens the owner control socket. A remote listener starts only with --listen.
The control token is read from <data>/control.token and sent as the first frame; it is never accepted as an argument.`;

/** The desktop app installs this CLI as `your-bot` (it sets YOUR_BOT_CLI_NAME); headless installs call it `your-bot-host`. */
function usageFor(env: Record<string, string | undefined>): string {
  const name = env.YOUR_BOT_CLI_NAME === 'your-bot' ? 'your-bot' : 'your-bot-host';
  return USAGE_TEXT.replace(/^Usage: your-bot-host/, `Usage: ${name}`);
}

const VALUE_FLAGS = new Set([
  'data', 'listen', 'name', 'agent-timeout', 'agent', 'workspace', 'profile', 'instructions', 'model', 'bot', 'capability',
  'folder', 'mcp-server', 'mcp-tool', 'agent-tool-kind', 'expires', 'prompt', 'every', 'cron', 'timezone',
  'at', 'missed', 'session', 'max-catch-up', 'scope',
]);
const REPEAT_FLAGS = new Set(['prefix']);
const BOOLEAN_FLAGS = new Set(['help', 'deny', 'disabled', 'memory', 'all', 'json', 'no-updates', 'no-auth']);

const NOT_RUNNING = 'Your Bot is not running. Open the app (or `your-bot-host run`) and try again.';
const SETTINGS_BUSY = 'Settings cannot change while a task is running. Wait for it to finish, then try again.';

interface Parsed { positional: string[]; flags: Map<string, string | true>; repeated: Map<string, string[]>; }

class UsageError extends Error {}

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const repeated = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (BOOLEAN_FLAGS.has(name) && inline === undefined) { flags.set(name, true); continue; }
    if (REPEAT_FLAGS.has(name)) {
      const value = inline ?? argv[++index];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} requires a value`);
      const list = repeated.get(name) ?? [];
      list.push(value);
      repeated.set(name, list);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new UsageError(`Unknown option --${name}`);
    const value = inline ?? argv[++index];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} requires a value`);
    if (flags.has(name)) throw new UsageError(`--${name} was given twice`);
    flags.set(name, value);
  }
  return { positional, flags, repeated };
}

function flag(args: Parsed, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function dataDirOf(args: Parsed, env: Record<string, string | undefined>): string {
  const data = flag(args, 'data') ?? env.YOUR_BOT_DATA;
  if (!data) throw new UsageError('Missing --data (or YOUR_BOT_DATA)');
  return data;
}

function parseListen(value: string): RuntimeListen {
  const match = /^\[(.+)\]:(\d+)$/.exec(value) ?? /^([^[\]]+):(\d+)$/.exec(value);
  if (!match?.[1] || match[2] === undefined) throw new UsageError('--listen must be host:port or [ipv6]:port');
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--listen port is invalid');
  return { host: match[1], port };
}

function scopeFrom(args: Parsed): StandingGrantScope {
  const scope: StandingGrantScope = {};
  const folder = flag(args, 'folder');
  const prefixes = args.repeated.get('prefix');
  const server = flag(args, 'mcp-server');
  const tool = flag(args, 'mcp-tool');
  const kind = flag(args, 'agent-tool-kind');
  if (folder) scope.folder = folder;
  if (prefixes?.length) scope.commandPrefix = prefixes;
  if (server) scope.mcp = { serverId: server, ...(tool ? { tool } : {}) };
  else if (tool) throw new UsageError('--mcp-tool requires --mcp-server');
  if (kind) scope.agentToolKind = kind;
  return scope;
}

function resultError(result: Record<string, unknown>): string | undefined {
  if (result.ok !== false) return undefined;
  const error = result.error;
  if (!error || typeof error !== 'object') return 'Command failed';
  const code = 'code' in error && typeof error.code === 'string' ? error.code : 'ERROR';
  const message = 'message' in error && typeof error.message === 'string' ? error.message : 'Command failed';
  return `${code}: ${message}`;
}

function codeOf(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

async function requireToken(dataDir: string): Promise<string> {
  try { return await readControlToken(tokenPath(dataDir)); }
  catch (error) {
    if (codeOf(error) === 'ENOENT') throw new Error('No control token. Run: your-bot-host init --data <dir>');
    throw error;
  }
}

async function ownerCall(dataDir: string, command: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = await requireToken(dataDir);
  const connection = await connectControl(await controlEndpoint(dataDir), token);
  try { return await connection.call({ ...command, version: 2, id: typeof command.id === 'string' ? command.id : randomUUID() }); }
  finally { connection.close(); }
}

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  let args: Parsed;
  try { args = parseArgs(argv); }
  catch (error) { io.stderr(error instanceof Error ? error.message : 'Invalid arguments'); io.stderr(usageFor(io.env)); return 2; }
  if (args.flags.has('help') || args.positional.length === 0) {
    (args.flags.has('help') ? io.stdout : io.stderr)(usageFor(io.env));
    return args.flags.has('help') ? 0 : 2;
  }
  const [command, ...rest] = args.positional;
  try {
    switch (command) {
      case 'init': return await initCommand(args, rest, io);
      case 'run': return await runCommand(args, rest, io);
      case 'ctl': return await ctlCommand(args, rest, io);
      case 'pair': return await pairCommand(args, rest, io);
      case 'devices': return await devicesCommand(args, rest, io);
      case 'revoke': return await revokeCommand(args, rest, io);
      case 'bot': return await botCreate(args, rest, io);
      case 'grant': return await grantCreate(args, rest, io);
      case 'routine': return await routineCreate(args, rest, io);
      case 'approvals': return await approvalsCommand(args, rest, io);
      case 'approve': return await approveCommand(args, rest, io);
      case 'watch': return await watchCommand(args, rest, io);
      case 'providers': return await providersCommand(args, rest, io);
      default: io.stderr(`Unknown command ${command}`); io.stderr(usageFor(io.env)); return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) { io.stderr(error.message); io.stderr(usageFor(io.env)); return 2; }
    io.stderr(error instanceof ControlClientError ? error.message : error instanceof Error ? error.message : 'your-bot-host failed');
    return 1;
  }
}

async function initCommand(args: Parsed, rest: string[], io: CliIO): Promise<number> {
  if (rest.length) throw new UsageError('init takes no positional arguments');
  const layout = await prepareDataLayout(dataDirOf(args, io.env), flag(args, 'name'));
  await ensureControlToken(tokenPath(layout.dataDir));
  io.stdout(`data ${layout.dataDir}`);
  io.stdout(`host ${layout.host.id}`);
  io.stdout(`name ${layout.host.name}`);
  io.stdout(`token ${tokenPath(layout.dataDir)}`);
  return 0;
}

async function runCommand(args: Parsed, rest: string[], io: CliIO): Promise<number> {
  if (rest.length) throw new UsageError('run takes no positional arguments');
  const requested = dataDirOf(args, io.env);
  await requireToken(requested);
  const listen = flag(args, 'listen');
  const agentTimeout = flag(args, 'agent-timeout');
  if (agentTimeout !== undefined && !/^[1-9][0-9]{0,6}$/.test(agentTimeout)) throw new UsageError('--agent-timeout must be a positive number of seconds');
  const notifier: Notifier = { notify: notification => io.stderr(`notification ${notification.title}: ${notification.body}`) };
  const runtime = await createRuntime({
    dataDir: requested,
    ...(flag(args, 'name') ? { hostName: flag(args, 'name') } : {}),
    ...(listen ? { listen: parseListen(listen) } : {}),
    ...(agentTimeout ? { acpTimeoutMs: Number(agentTimeout) * 1000 } : {}),
    notifier,
  });
  try {
    const control = await startControlServer({
      dataDir: runtime.dataDir,
      token: await readControlToken(tokenPath(runtime.dataDir)),
      dispatch: async command => await runtime.gateway.dispatch(command, runtime.principal) as CommandResultV2,
      subscribe: listener => runtime.gateway.subscribe(listener, runtime.principal, { contractVersion: 2 }),
    });
    io.stdout(`host ${runtime.host.id}`);
    io.stdout(`name ${runtime.host.name}`);
    io.stdout(`control ${control.endpoint}`);
    if (runtime.remote) {
      io.stdout(`fingerprint ${runtime.remote.fingerprint}`);
      io.stdout(`listen ${runtime.remote.address.urls.join(',')}`);
      io.stdout(`remoteHost ${runtime.remote.hostId}`);
    }
    try {
      await new Promise<void>(resolve => {
        if (io.signal?.aborted) return resolve();
        io.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    } finally { await control.close(); }
    return 0;
  } finally { await runtime.close(); }
}

async function ctlCommand(args: Parsed, rest: string[], io: CliIO): Promise<number> {
  if (rest.length !== 1) throw new UsageError("ctl requires one JSON command");
  let parsed: unknown;
  try { parsed = JSON.parse(rest[0]!); }
  catch { throw new UsageError('ctl argument is not JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UsageError('ctl argument must be a JSON object');
  const body = parsed as Record<string, unknown>;
  if (body.version !== undefined && body.version !== 2) throw new UsageError('ctl only sends contract version 2');
  const command: DesktopCommandV2 = { ...body, version: 2, id: typeof body.id === 'string' && body.id ? body.id : randomUUID() } as DesktopCommandV2;
  if (typeof command.type !== 'string' || !command.type) throw new UsageError('ctl command is missing type');
  const result = await ownerCall(dataDirOf(args, io.env), command);
  io.stdout(JSON.stringify(result));
  return result.ok === true ? 0 : 1;
}

async function pairCommand(args: Parsed, rest: string[], io: CliIO): Promise<number> {
  if (rest.length) throw new UsageError('pair takes no positional arguments');
  const name = flag(args, 'name');
  const result = await ownerCall(dataDirOf(args, io.env), { type: 'device.pair.start', ...(name ? { name } : {}) });
  const error = resultError(result);
  if (error) { io.stderr(error); return 1; }
  const pairing = result.pairing;
  if (!pairing || typeof pairing !== 'object' || !('code' in pairing) || typeof pairing.code !== 'string') throw new Error('Host returned no pairing code');
  io.stdout(`code ${pairing.code}`);
  return 0;
}

async function devicesCommand(args: Parsed, rest: string[], io: CliIO): Promise<number> {
  if (rest.length) throw new UsageError('devices takes no positional arguments');
  const result = await ownerCall(dataDirOf(args, io.env), { type: 'device.list' });
  const error = resultError(result);
  if (error) { io.stderr(error); return 1; }
  const devices = Array.isArray(result.devices) ? result.devices : [];
  if (!devices.length) { io.stdout('No devices.'); return 0; }
  for (const device of devices) {
    if (!device || typeof device !== 'object') continue;
    const row = device as { id?: string; name?: string; revokedAt?: string };
    io.stdout(`${row.id ?? ''}  ${row.name ?? ''}  ${row.revokedAt ? 'revoked' : 'active'}`);
  }
  return 0;
}

async function revokeCommand(args: Parsed, rest: string[], io: CliIO): Promise<number> {
  const deviceId = rest[0];
  if (!deviceId || rest.length !== 1) throw new UsageError('revoke requires a device id');
  const result = await ownerCall(dataDirOf(args, io.env), { type: 'device.revoke', deviceId });
  const error = resultError(result);
  if (error) { io.stderr(error); return 1; }
  io.stdout(`revoked ${deviceId}`);
  return 0;
}

async function botCreate(args: Parsed, rest: string[], io: CliIO): Promise<number> {
  if (rest[0] !== 'create' || rest.length !== 1) throw new UsageError('bot requires: create');
  const name = flag(args, 'name');
  const agentId = flag(args, 'agent');
  const profile = flag(args, 'profile');
  const workspace = flag(args, 'workspace');
  if (!name || !agentId || (profile !== 'strict' && profile !== 'trusted')) throw new UsageError('bot create requires --name, --agent and --profile strict|trusted');
  if (profile === 'trusted' && !workspace) throw new UsageError('a trusted bot requires --workspace');
  const bot: BotInput = {
    name, instructions: flag(args, 'instructions') ?? '', agentId, profile,
    ...(flag(args, 'model') ? { modelId: flag(args, 'model') } : {}),
    ...(workspace ? { workspace } : {}),
    mcpServers: [], skills: [], memoryEnabled: args.flags.has('memory'),
  };
  const result = await ownerCall(dataDirOf(args, io.env), { type: 'bot.create', bot });
  const error = resultError(result);
  if (error) { io.stderr(error); return 1; }
  const created = result.bot as { id?: string } | undefined;
  io.stdout(`bot ${created?.id ?? ''}`);
  return 0;
}

async function grantCreate(args: Parsed, rest: string[], io: CliIO): Promise<number> {
  if (rest[0] !== 'create' || rest.length !== 1) throw new UsageError('grant requires: create');
  const botId = flag(args, 'bot');
  const capability = flag(args, 'capability');
  if (!botId || !capability) throw new UsageError('grant create requires --bot and --capability');
  const result = await ownerCall(dataDirOf(args, io.env), {
    type: 'grant.create',
    grant: { botId, capability: capability as CapabilityV2, scope: scopeFrom(args), ...(flag(args, 'expires') ? { expiresAt: flag(args, 'expires') } : {}) },
  });
  const error = resultError(result);
  if (error) { io.stderr(error); return 1; }
  const grant = result.grant as { id?: string } | undefined;
  io.stdout(`grant ${grant?.id ?? ''}`);
  return 0;
}

async function routineCreate(args: Parsed, rest: string[], io: CliIO): Promise<number> {
  if (rest[0] !== 'create' || rest.length !== 1) throw new UsageError('routine requires: create');
  const botId = flag(args, 'bot');
  const name = flag(args, 'name');
  const prompt = flag(args, 'prompt');
  if (!botId || !name || prompt === undefined) throw new UsageError('routine create requires --bot, --name and --prompt');
  const every = flag(args, 'every');
  const cron = flag(args, 'cron');
  const at = flag(args, 'at');
  const schedules = [every, cron, at].filter(value => value !== undefined);
  if (schedules.length !== 1) throw new UsageError('routine create requires exactly one of --every, --cron or --at');
  const missed = flag(args, 'missed') ?? 'skip';
  if (missed !== 'skip' && missed !== 'runOnce' && missed !== 'runAll') throw new UsageError('--missed must be skip, runOnce or runAll');
  const session = flag(args, 'session') ?? 'new';
  if (session !== 'new' && session !== 'reuse') throw new UsageError('--session must be new or reuse');
  const catchUp = flag(args, 'max-catch-up');
  const maxCatchUp = catchUp === undefined ? undefined : Number(catchUp);
  if (maxCatchUp !== undefined && (!Number.isSafeInteger(maxCatchUp) || maxCatchUp < 1)) throw new UsageError('--max-catch-up must be a positive integer');
  let schedule: RoutineInput['schedule'];
  if (every !== undefined) {
    const everyMinutes = Number(every);
    if (!Number.isSafeInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > 525_600) throw new UsageError('--every must be a whole number of minutes from 1 to 525600');
    schedule = { kind: 'interval', everyMinutes };
  } else if (cron !== undefined) schedule = { kind: 'cron', expression: cron, ...(flag(args, 'timezone') ? { timezone: flag(args, 'timezone') } : {}) };
  else schedule = { kind: 'once', at: at! };
  const routine: RoutineInput = {
    botId, name, prompt, schedule, missedRunPolicy: missed as MissedRunPolicy, sessionMode: session,
    enabled: !args.flags.has('disabled'),
    ...(maxCatchUp !== undefined ? { maxCatchUp } : {}),
  };
  const result = await ownerCall(dataDirOf(args, io.env), { type: 'routine.create', routine });
  const error = resultError(result);
  if (error) { io.stderr(error); return 1; }
  const created = result.routine as { id?: string } | undefined;
  io.stdout(`routine ${created?.id ?? ''}`);
  return 0;
}

async function approvalsCommand(args: Parsed, rest: string[], io: CliIO): Promise<number> {
  if (rest.length) throw new UsageError('approvals takes no positional arguments');
  const result = await ownerCall(dataDirOf(args, io.env), { type: 'state.sync' });
  const error = resultError(result);
  if (error) { io.stderr(error); return 1; }
  const pending = result.snapshot && typeof result.snapshot === 'object' && 'pendingPermissions' in result.snapshot && Array.isArray(result.snapshot.pendingPermissions)
    ? result.snapshot.pendingPermissions : [];
  if (!pending.length) { io.stdout('No pending approvals.'); return 0; }
  for (const request of pending) {
    if (!request || typeof request !== 'object') continue;
    const row = request as { id?: string; capability?: string; reason?: string };
    io.stdout(`${row.id ?? ''}  ${row.capability ?? ''}  ${row.reason ?? ''}`);
  }
  return 0;
}

async function approveCommand(args: Parsed, rest: string[], io: CliIO): Promise<number> {
  const requestId = rest[0];
  if (!requestId || rest.length !== 1) throw new UsageError('approve requires a request id');
  const scope = flag(args, 'scope') ?? 'once';
  if (scope !== 'once' && scope !== 'task' && scope !== 'standing') throw new UsageError('--scope must be once, task or standing');
  const standing = scopeFrom(args);
  if (scope !== 'standing' && Object.keys(standing).length) throw new UsageError('standing scope flags require --scope standing');
  const decision = {
    requestId, outcome: args.flags.has('deny') ? 'deny' as const : 'allow' as const, scope,
    ...(scope === 'standing' ? { standing, ...(flag(args, 'expires') ? { standingExpiresAt: flag(args, 'expires') } : {}) } : {}),
  };
  const result = await ownerCall(dataDirOf(args, io.env), { type: 'permission.decide', decision });
  const error = resultError(result);
  if (error) { io.stderr(error); return 1; }
  io.stdout(`${decision.outcome === 'allow' ? 'Allowed' : 'Denied'} ${requestId}`);
  return 0;
}

function providersApi(io: CliIO): ProvidersDeps {
  return io.providers ?? { scanProviders, linkProviders, updateAgentCli, loginTarget, agentSpec };
}

function optionalDataDir(args: Parsed, env: Record<string, string | undefined>): string | undefined {
  return flag(args, 'data') ?? env.YOUR_BOT_DATA;
}

async function defaultConnectOwner(dataDir: string): Promise<OwnerSession | undefined> {
  let token: string;
  try { token = await readControlToken(tokenPath(dataDir)); }
  catch (error) {
    if (codeOf(error) === 'ENOENT') return undefined;
    throw error;
  }
  let endpoint: string;
  try { endpoint = await controlEndpoint(dataDir); }
  catch (error) {
    if (codeOf(error) === 'ENOENT') return undefined;
    throw error;
  }
  try { return await connectControl(endpoint, token); }
  catch (error) {
    if (error instanceof ControlClientError && error.message === 'UNAUTHORIZED') throw new Error('The control token was rejected.');
    return undefined;
  }
}

async function openOwner(args: Parsed, io: CliIO): Promise<OwnerSession | undefined> {
  const dataDir = optionalDataDir(args, io.env);
  if (!dataDir) return undefined;
  return (io.connectOwner ?? defaultConnectOwner)(dataDir);
}

function ownerCommand(session: OwnerSession, command: Record<string, unknown>): Promise<Record<string, unknown>> {
  return session.call({ ...command, version: 2, id: typeof command.id === 'string' ? command.id : randomUUID() });
}

function settingsFrom(result: Record<string, unknown>): AppSettingsV2 {
  const snapshot = result.snapshot;
  if (!snapshot || typeof snapshot !== 'object' || !('settings' in snapshot)) throw new Error('Host returned no settings');
  const settings = snapshot.settings;
  if (!settings || typeof settings !== 'object' || !('providers' in settings) || !Array.isArray((settings as AppSettingsV2).providers)) throw new Error('Host returned no settings');
  return settings as AppSettingsV2;
}

function emitOutput(io: CliIO, text: string): void {
  if (io.write) io.write(text);
  else if (text) io.stdout(text.replace(/\n$/, ''));
}

function agentLine(agent: ProviderScan['agents'][number]): string {
  const version = agent.version ?? '-';
  const install = agent.install?.label ?? '-';
  const update = agent.updateAvailable === true ? 'update available' : agent.updateAvailable === false ? 'current' : '-';
  const link = agent.linked ? `linked ${agent.providerId}` : 'not linked';
  return [agent.name, version, install, agent.auth, update, link].join('  ');
}

function printScan(scan: ProviderScan, io: CliIO): void {
  const installed = scan.agents.filter(agent => agent.installed);
  const missing = scan.agents.filter(agent => !agent.installed);
  const running = scan.servers.filter(server => server.running);
  for (const agent of installed) io.stdout(agentLine(agent));
  if (running.length && installed.length) io.stdout('');
  for (const server of running) {
    const models = server.models.length === 1 ? '1 model' : `${server.models.length} models`;
    const link = server.linked ? `linked ${server.providerId}` : 'not linked';
    io.stdout(`${server.name}  ${server.endpoint}  running  ${models}  ${link}`);
  }
  if (missing.length) {
    if (installed.length || running.length) io.stdout('');
    io.stdout('Not installed:');
    for (const agent of missing) io.stdout(`${agent.name}  ${agent.installHint}`);
  }
  if (!installed.length && !running.length && !missing.length) io.stdout('No agents found.');
}

async function providersCommand(args: Parsed, rest: string[], io: CliIO): Promise<number> {
  const [sub, ...ids] = rest;
  if (sub === 'list') return providersList(args, ids, io);
  if (sub === 'link') return providersLink(args, ids, io);
  if (sub === 'update') return providersUpdate(args, ids, io);
  if (sub === 'login') return providersLogin(args, ids, io);
  throw new UsageError('providers requires list, link, update or login');
}

async function providersList(args: Parsed, ids: string[], io: CliIO): Promise<number> {
  if (ids.length || args.flags.has('all')) throw new UsageError('providers list takes no ids');
  const api = providersApi(io);
  let providers: readonly ProviderConfigV2[] = [];
  const session = await openOwner(args, io);
  if (session) {
    try {
      const result = await ownerCommand(session, { type: 'state.sync' });
      const error = resultError(result);
      if (error) { io.stderr(error); return 1; }
      providers = settingsFrom(result).providers;
    } finally { session.close(); }
  }
  const scan = await api.scanProviders(providers, {
    checkUpdates: !args.flags.has('no-updates'),
    checkAuth: !args.flags.has('no-auth'),
    env: io.env,
  });
  if (args.flags.has('json')) io.stdout(JSON.stringify(scan, null, 2));
  else printScan(scan, io);
  return 0;
}

function targetIds(args: Parsed, ids: string[], command: 'link' | 'update'): readonly string[] | 'all' {
  const all = args.flags.has('all');
  if (all && ids.length) throw new UsageError(`providers ${command} accepts ids or --all, not both`);
  if (!all && !ids.length) throw new UsageError(`providers ${command} requires an id or --all`);
  return all ? 'all' : ids;
}

async function providersLink(args: Parsed, ids: string[], io: CliIO): Promise<number> {
  const targets = targetIds(args, ids, 'link');
  const session = await openOwner(args, io);
  if (!session) { io.stderr(NOT_RUNNING); return 1; }
  try {
    const sync = await ownerCommand(session, { type: 'state.sync' });
    const syncError = resultError(sync);
    if (syncError) { io.stderr(syncError); return 1; }
    const summary = await providersApi(io).linkProviders(settingsFrom(sync), targets, { checkAuth: false, checkUpdates: false, env: io.env });
    for (const skipped of summary.skipped) io.stdout(`skipped ${skipped.id}: ${skipped.reason}`);
    if (!summary.linked.length) {
      if (!summary.skipped.length) io.stdout('Nothing to link.');
      return summary.skipped.length ? 1 : 0;
    }
    const saved = await ownerCommand(session, { type: 'settings.update', settings: summary.settings });
    if (saved.ok !== true) {
      const code = saved.error && typeof saved.error === 'object' && 'code' in saved.error && typeof saved.error.code === 'string' ? saved.error.code : '';
      io.stderr(code === 'SETTINGS_BUSY' ? SETTINGS_BUSY : resultError(saved) ?? 'Could not save settings');
      return 1;
    }
    for (const linked of summary.linked) io.stdout(`${linked.created ? 'created' : 'refreshed'} ${linked.name} (${linked.providerId})`);
    const refreshed = await ownerCommand(session, { type: 'models.refresh' });
    if (refreshed.ok !== true) io.stderr(`Models were not refreshed: ${resultError(refreshed) ?? 'models.refresh failed'}`);
    return 0;
  } finally { session.close(); }
}

async function relinkNpx(id: string, spec: AgentCliSpec, args: Parsed, io: CliIO): Promise<void> {
  if (spec.acp.via !== 'npx') return;
  const session = await openOwner(args, io);
  if (!session) return;
  try {
    const sync = await ownerCommand(session, { type: 'state.sync' });
    if (sync.ok !== true) return;
    const settings = settingsFrom(sync);
    if (!linkedProvider(settings.providers, spec)) return;
    const summary = await providersApi(io).linkProviders(settings, [id], { checkAuth: false, checkUpdates: false, env: io.env });
    if (!summary.linked.length) return;
    const saved = await ownerCommand(session, { type: 'settings.update', settings: summary.settings });
    if (saved.ok !== true) return;
    await ownerCommand(session, { type: 'models.refresh' });
  } catch { /* The update succeeded; re-pinning can be retried with providers link. */ }
  finally { session.close(); }
}

async function providersUpdate(args: Parsed, ids: string[], io: CliIO): Promise<number> {
  const api = providersApi(io);
  let targets: string[];
  if (args.flags.has('all')) {
    if (ids.length) throw new UsageError('providers update accepts ids or --all, not both');
    const scan = await api.scanProviders([], { checkUpdates: true, checkAuth: false, env: io.env });
    targets = scan.agents.filter(agent => agent.installed && agent.updateAvailable === true).map(agent => agent.id);
    if (!targets.length) { io.stdout('Everything is up to date.'); return 0; }
  } else {
    if (!ids.length) throw new UsageError('providers update requires an id or --all');
    targets = ids;
  }
  let failed = false;
  for (const id of targets) {
    const spec = api.agentSpec(id);
    io.stdout(`Updating ${spec?.name ?? id}...`);
    const result = await api.updateAgentCli(id, {
      env: io.env,
      signal: io.signal,
      onOutput: text => emitOutput(io, text),
    });
    if (!result.ok) { io.stderr(result.message); failed = true; continue; }
    io.stdout(result.message);
    if (spec) await relinkNpx(id, spec, args, io);
  }
  return failed ? 1 : 0;
}

/** Spawn a sign-in plan. `.cmd` / `.bat` shims on Windows go through `cmd.exe /d /s /c` with `shell: false`. */
export function loginSpawnArgs(plan: { command: string; args: readonly string[] }, platform: NodeJS.Platform = process.platform): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  const shim = platform === 'win32' && /\.(cmd|bat)$/i.test(plan.command);
  if (!shim) return { command: plan.command, args: [...plan.args] };
  // `/s` strips one pair of surrounding quotes, so the whole line is wrapped once and each token is quoted.
  const quote = (token: string) => {
    if (token.length === 0) return '""';
    if (!/[\s"&<>()@^|]/.test(token)) return token;
    return `"${token.replace(/"/g, '""')}"`;
  };
  const inner = [plan.command, ...plan.args].map(quote).join(' ');
  return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${inner}"`], windowsVerbatimArguments: true };
}

async function defaultRunLogin(plan: LoginTarget['plan'], signal?: AbortSignal): Promise<number> {
  const spawned = loginSpawnArgs(plan);
  return new Promise((resolve, reject) => {
    const child = spawn(spawned.command, spawned.args, { stdio: 'inherit', shell: false, signal, windowsVerbatimArguments: spawned.windowsVerbatimArguments });
    child.once('error', error => { if (signal?.aborted) resolve(130); else reject(error); });
    child.once('exit', (code, exitSignal) => resolve(code ?? (exitSignal ? 1 : 0)));
  });
}

async function providersLogin(args: Parsed, ids: string[], io: CliIO): Promise<number> {
  if (args.flags.has('all') || ids.length !== 1) throw new UsageError('providers login requires one agent id');
  let target: LoginTarget;
  try { target = await providersApi(io).loginTarget(ids[0]!, undefined); }
  catch (error) { io.stderr(error instanceof Error ? error.message : 'Could not start sign-in'); return 1; }
  try { return await (io.runLogin ?? (plan => defaultRunLogin(plan, io.signal)))(target.plan); }
  catch (error) { io.stderr(error instanceof Error ? error.message : 'Could not start sign-in'); return 1; }
}

async function watchCommand(args: Parsed, rest: string[], io: CliIO): Promise<number> {
  if (rest.length) throw new UsageError('watch takes no positional arguments');
  const dataDir = dataDirOf(args, io.env);
  const connection = await connectControl(await controlEndpoint(dataDir), await requireToken(dataDir));
  try {
    await connection.watch(event => io.stdout(JSON.stringify(event)), io.signal);
    return 0;
  } finally { connection.close(); }
}
