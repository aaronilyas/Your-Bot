/** `your-bot-remote` command implementation (bin wrapper in bin.ts). */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SecretCipher } from '@your-bot/contracts';
import { pairWithCode } from './client.js';
import { HostDirectory } from './directory.js';
import { MultiHostClient } from './multi.js';

export interface CliIO {
  env: Record<string, string | undefined>;
  stdout(line: string): void;
  stderr(line: string): void;
  cipher?: SecretCipher;
  /** Ends `watch`. */
  signal?: AbortSignal;
  connectTimeoutMs?: number;
}

const USAGE = `Usage: your-bot-remote [--config <dir>] <command>
  pair <code> [--name <device name>]   Pair this device with a host using a one-time code
  hosts                                List saved hosts
  approvals [--host <id>] [--json]     Show pending permission requests across hosts
  approve <requestId> [--deny] [--scope once|task] [--host <id>]
  watch [--host <id>]                  Stream approvals and notifications until interrupted
Config directory: --config, $YOUR_BOT_REMOTE_HOME, or $XDG_CONFIG_HOME/your-bot-remote`;

interface Parsed { positional: string[]; flags: Map<string, string | true>; }
const VALUE_FLAGS = new Set(['config', 'name', 'host', 'scope']);
const BOOLEAN_FLAGS = new Set(['deny', 'json', 'help']);
function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [], flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (BOOLEAN_FLAGS.has(name) && inline === undefined) flags.set(name, true);
    else if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new Error(`--${name} requires a value`);
      flags.set(name, value);
    } else throw new Error(`Unknown option --${name}`);
  }
  return { positional, flags };
}

export function configDirectory(flag: string | undefined, env: Record<string, string | undefined>): string {
  if (flag) return flag;
  if (env.YOUR_BOT_REMOTE_HOME) return env.YOUR_BOT_REMOTE_HOME;
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'your-bot-remote');
}

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  let args: Parsed;
  try { args = parseArgs(argv); } catch (error) { io.stderr((error as Error).message); io.stderr(USAGE); return 2; }
  const [command, ...rest] = args.positional;
  if (args.flags.has('help')) { io.stdout(USAGE); return 0; }
  if (!command) { io.stderr(USAGE); return 2; }
  const directory = new HostDirectory(configDirectory(args.flags.get('config') as string | undefined, io.env), io.cipher ? { cipher: io.cipher } : {});
  const host = args.flags.get('host') as string | undefined;
  const transportOptions = { connectTimeoutMs: io.connectTimeoutMs ?? 10_000, commandTimeoutMs: 30_000 };
  try {
    switch (command) {
      case 'pair': {
        const code = rest[0];
        if (!code) { io.stderr('pair requires a code'); return 2; }
        const name = (args.flags.get('name') as string | undefined) ?? io.env.HOSTNAME ?? 'Remote device';
        const paired = await pairWithCode(code, { name, timeoutMs: transportOptions.connectTimeoutMs });
        directory.add(paired);
        io.stdout(`Paired with ${paired.hostName} (${paired.hostId}) as device ${paired.deviceId}`);
        if (!io.cipher) io.stderr(`Warning: the device key is stored unencrypted in ${directory.file} (owner-only permissions).`);
        return 0;
      }
      case 'hosts': {
        const hosts = directory.list();
        if (args.flags.has('json')) { io.stdout(JSON.stringify(hosts)); return 0; }
        if (!hosts.length) { io.stdout('No paired hosts.'); return 0; }
        for (const h of hosts) io.stdout(`${h.hostId}  ${h.hostName}  device=${h.deviceId}  ${h.urls.join(',')}  fp=${h.fingerprint.slice(0, 16)}…`);
        return 0;
      }
      case 'approvals': {
        const client = new MultiHostClient(directory, { ...transportOptions, autoReconnect: false });
        try {
          const outcomes = await client.start(host ? [host] : undefined);
          if (host && !outcomes.length) { io.stderr(`Unknown host ${host}`); return 1; }
          for (const o of outcomes) if (!o.ok) io.stderr(`${o.hostId}: ${o.error}`);
          const approvals = client.pendingApprovals(host);
          if (args.flags.has('json')) io.stdout(JSON.stringify(approvals));
          else if (!approvals.length) io.stdout('No pending approvals.');
          else for (const a of approvals) io.stdout(formatApproval(a.hostId, a.hostName, a.request));
          return outcomes.every(o => o.ok) ? 0 : 1;
        } finally { await client.close(); }
      }
      case 'approve': {
        const requestId = rest[0];
        if (!requestId) { io.stderr('approve requires a request id'); return 2; }
        const scope = (args.flags.get('scope') as string | undefined) ?? 'once';
        if (scope !== 'once' && scope !== 'task') { io.stderr('--scope must be once or task'); return 2; }
        const client = new MultiHostClient(directory, { ...transportOptions, autoReconnect: false });
        try {
          const outcomes = await client.start(host ? [host] : undefined);
          for (const o of outcomes) if (!o.ok) io.stderr(`${o.hostId}: ${o.error}`);
          const match = client.pendingApprovals(host).find(a => a.request.id === requestId);
          const target = match?.hostId ?? (host && outcomes.some(o => o.ok) ? host : undefined);
          if (!target) { io.stderr(`No pending request ${requestId} on ${host ?? 'any connected host'}`); return 1; }
          const outcome = args.flags.has('deny') ? 'deny' : 'allow';
          const result = await client.decide(target, { requestId, outcome, scope });
          if (!result.ok) { io.stderr(`${result.error.code}: ${result.error.message}`); return 1; }
          io.stdout(`${outcome === 'allow' ? 'Allowed' : 'Denied'} ${requestId} on ${target}`);
          return 0;
        } finally { await client.close(); }
      }
      case 'watch': {
        const client = new MultiHostClient(directory, { ...transportOptions, persistCursor: true });
        const announced = new Set<string>();
        const announce = (hostId: string, hostName: string, request: Parameters<typeof formatApproval>[2]) => {
          const key = `${hostId}/${request.id}`;
          if (announced.has(key)) return;
          announced.add(key); io.stdout(`approval ${formatApproval(hostId, hostName, request)}`);
        };
        client.onStatus((hostId, status) => io.stderr(`${hostId}: ${status}`));
        client.subscribe((hostId, event) => {
          const hostName = client.transport(hostId)?.ready?.hostName ?? hostId;
          if (event.type === 'permission.requested') announce(hostId, hostName, event.request);
          else if (event.type === 'notification') io.stdout(`notification ${hostId}  ${event.notification.title}: ${event.notification.body}`);
          else if (event.type === 'permission.resolved') io.stdout(`resolved ${hostId}  ${event.requestId} ${event.outcome}`);
        });
        try {
          const outcomes = await client.start(host ? [host] : undefined);
          for (const o of outcomes) if (!o.ok) io.stderr(`${o.hostId}: ${o.error}`);
          for (const a of client.pendingApprovals(host)) announce(a.hostId, a.hostName, a.request);
          await new Promise<void>(resolve => {
            if (io.signal?.aborted) return resolve();
            io.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          return 0;
        } finally { await client.close(); }
      }
      default:
        io.stderr(`Unknown command ${command}`); io.stderr(USAGE); return 2;
    }
  } catch (error) {
    io.stderr(`Error: ${(error as Error).message}`);
    return 1;
  }
}

function formatApproval(hostId: string, hostName: string, request: { id: string; capability: string; reason: string; paths?: { path: string; access: string }[]; packages?: string[]; command?: { command: string; args: string[] } }): string {
  const detail = [
    ...(request.paths ?? []).map(p => `${p.access}:${p.path}`),
    ...(request.packages?.length ? [`packages:${request.packages.join(',')}`] : []),
    ...(request.command ? [`$ ${[request.command.command, ...request.command.args].join(' ')}`] : []),
  ].join(' ');
  return `${hostId} (${hostName})  ${request.id}  ${request.capability}  ${request.reason.replace(/[\u0000-\u001f\u007f]/g, ' ')}${detail ? `  ${detail}` : ''}`;
}
