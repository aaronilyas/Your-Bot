/** Shared fakes and helpers for v2 tests (excluded from the build). */
import { expect, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type {
  AgentAdapterV2, AgentRunContext, AgentRunContextV2, AnyCommandResult, CommandResultV2, Bot, BotInput, CapabilityV2, CommandPayloadV2, DesktopEventV2,
  DesktopGatewayV2, DeviceInfo, DeviceManager, McpBroker, McpBuiltinTool, McpCall, OwnerNotification, PermissionRequestV2, PrincipalV2, RoutineRun,
  SecretCipher, SkillCatalog, SkillInfo, TerminalExitStatus, ToolExecutor, WorkspaceHost,
} from '@your-bot/contracts';
import { createGatewayV2, isWithin, type GatewayClock, type GatewayOptions } from './index.js';

export const ALL: CapabilityV2[] = ['conversation', 'settings', 'tool.execute', 'file.read', 'file.write', 'file.delete', 'library.install', 'network', 'process.spawn', 'mcp.call'];
export const owner: PrincipalV2 = { id: 'owner', kind: 'local', capabilities: [...ALL] };
/** A paired device of the local owner holding every capability, to prove owner-only rules do not depend on capabilities. */
export const device: PrincipalV2 = { id: 'device:phone', kind: 'remote', ownerId: 'owner', deviceId: 'phone', capabilities: [...ALL] };
export const stranger: PrincipalV2 = { id: 'stranger', kind: 'remote', capabilities: [...ALL] };

const gateways: DesktopGatewayV2[] = []; const directories: string[] = []; let next = 0;
export function cmd(payload: CommandPayloadV2, id = `v2-${++next}`) { return { ...payload, version: 2 as const, id }; }
export function ok(result: AnyCommandResult): asserts result is Extract<CommandResultV2, {ok: true}> {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
}
export async function directory(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), 'your-bot-core-v2-'))); directories.push(dir); return dir; }
export async function cleanupAll(): Promise<void> {
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()));
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
}

export type Run = (context: AgentRunContextV2) => Promise<void>;
export function agent(id: string, profiles: AgentAdapterV2['profiles'], run: Run = async context => { context.emit({ type: 'text', text: 'Hello' }); }) {
  const adapter = {
    id, ...(profiles ? { profiles } : {}),
    getInfo: vi.fn(async () => ({ id, name: `Agent ${id}`, kind: 'acp' as const, available: true, models: [{ id: 'model', name: 'Model' }] })),
    run: vi.fn(async (context: AgentRunContext | AgentRunContextV2) => run(context as AgentRunContextV2)),
    cancel: vi.fn(async () => {}), close: vi.fn(async () => {}),
  };
  return adapter;
}
export function executor(): ToolExecutor { return { execute: vi.fn(async () => ({ ok: true, value: 'done' })), cancel: vi.fn(async () => {}), close: vi.fn(async () => {}) }; }

/** Real-filesystem fake WorkspaceHost confining by canonical parent + basename. */
export class FakeHost implements WorkspaceHost {
  readonly calls: string[] = [];
  readonly released: string[] = [];
  private terminals = new Map<string, {taskId: string; argv: string[]; cwd: string}>(); private seq = 0;
  async resolve(root: string, path: string): Promise<string> {
    const target = resolve(root, path);
    let parent: string;
    try { parent = await realpath(dirname(target)); } catch { throw Object.assign(new Error('Parent not found'), { code: 'NOT_FOUND' }); }
    let canonical = join(parent, basename(target));
    try { canonical = await realpath(canonical); } catch { /* new file */ }
    if (target === root) canonical = await realpath(root);
    if (!isWithin(root, canonical)) throw Object.assign(new Error('Outside workspace'), { code: 'OUTSIDE_WORKSPACE' });
    return canonical;
  }
  async readTextFile(_root: string, path: string): Promise<string> { this.calls.push(`read ${path}`); return readFile(path, 'utf8'); }
  async writeTextFile(_root: string, path: string, content: string): Promise<void> { this.calls.push(`write ${path}`); await writeFile(path, content); }
  async createTerminal(_root: string, request: {command: string; args?: string[]; cwd: string}, options: {taskId: string}): Promise<string> {
    const id = `term-${++this.seq}`; this.terminals.set(id, { taskId: options.taskId, argv: [request.command, ...(request.args ?? [])], cwd: request.cwd });
    this.calls.push(`spawn ${JSON.stringify([request.command, ...(request.args ?? [])])} ${request.cwd}`); return id;
  }
  async terminalOutput(id: string) { this.calls.push(`output ${id}`); return { output: 'out', truncated: false }; }
  async waitForTerminalExit(id: string): Promise<TerminalExitStatus> { this.calls.push(`wait ${id}`); return { exitCode: 0, signal: null }; }
  async killTerminal(id: string) { this.calls.push(`kill ${id}`); }
  async releaseTerminal(id: string) { this.calls.push(`release ${id}`); this.terminals.delete(id); }
  async releaseTask(taskId: string) { this.released.push(taskId); }
  close = vi.fn(async () => {});
}

export class FakeBroker implements McpBroker {
  sessions: {taskId: string; servers: unknown[]; builtins: McpBuiltinTool[]; authorize: (call: McpCall, signal: AbortSignal) => Promise<boolean>; closed: boolean}[] = [];
  async open(input: Parameters<McpBroker['open']>[0]) {
    const entry = { taskId: input.taskId, servers: input.servers, builtins: input.builtins, authorize: input.authorize, closed: false };
    this.sessions.push(entry);
    return {
      endpoint: { name: 'your-bot', url: 'http://127.0.0.1:9/mcp', headers: [{ name: 'Authorization', value: 'Bearer token' }] },
      tools: async () => [], close: async () => { entry.closed = true; },
    };
  }
  close = vi.fn(async () => {});
}

export class FakeDevices implements DeviceManager {
  devices: DeviceInfo[] = [{ id: 'phone', name: 'Phone', capabilities: ['conversation'], pairedAt: '2026-01-01T00:00:00.000Z' }];
  async startPairing() { return { code: 'ybp1.secret', expiresAt: '2030-01-01T00:00:00.000Z', hostFingerprint: 'fp', urls: ['wss://host:1'] }; }
  async list() { return structuredClone(this.devices); }
  async revoke(id: string) { const entry = this.devices.find(item => item.id === id); if (entry) entry.revokedAt = new Date().toISOString(); }
}

/** Reversible fake cipher whose ciphertext never contains the plaintext. */
export const cipher: SecretCipher = {
  id: 'test-cipher',
  encrypt: plaintext => 'ct.' + Buffer.from(Buffer.from(plaintext, 'utf8').map(byte => byte ^ 0x5a)).toString('hex'),
  decrypt: ciphertext => { if (!ciphertext.startsWith('ct.')) throw new Error('bad'); return Buffer.from(Buffer.from(ciphertext.slice(3), 'hex').map(byte => byte ^ 0x5a)).toString('utf8'); },
};

export async function setup(options: Partial<GatewayOptions> = {}, principals: PrincipalV2[] = [owner]) {
  const strict = agent('fake', undefined); const trusted = agent('host-agent', ['trusted']);
  const gateway = await createGatewayV2({ databasePath: ':memory:', localPrincipalId: owner.id, adapters: [strict, trusted], executor: executor(), ...options });
  gateways.push(gateway);
  const events: DesktopEventV2[] = []; const v1Events: DesktopEventV2[] = [];
  for (const principal of principals) gateway.subscribe(event => events.push(event), principal, { contractVersion: 2 });
  gateway.subscribe(event => v1Events.push(event), owner);
  return { gateway, events, v1Events, strict, trusted };
}

export function botInput(patch: Partial<BotInput> = {}): BotInput {
  return { name: 'Bot', instructions: '', agentId: 'host-agent', profile: 'strict', mcpServers: [], skills: [], memoryEnabled: false, ...patch };
}
export async function createBot(gateway: DesktopGatewayV2, input: BotInput, principal: PrincipalV2 = owner): Promise<Bot> {
  const result = await gateway.dispatch(cmd({ type: 'bot.create', bot: input }), principal); ok(result); return result.bot!;
}
export async function botSession(gateway: DesktopGatewayV2, botId: string, principal: PrincipalV2 = owner): Promise<string> {
  const result = await gateway.dispatch(cmd({ type: 'bot.session.create', botId }), principal); ok(result); return result.sessionId!;
}
export async function send(gateway: DesktopGatewayV2, sessionId: string, principal: PrincipalV2 = owner, content = 'Go'): Promise<string> {
  const result = await gateway.dispatch(cmd({ type: 'message.send', sessionId, content }), principal); ok(result); return result.taskId!;
}
export async function requested(events: DesktopEventV2[], predicate: (request: PermissionRequestV2) => boolean = () => true, excluded: string[] = []): Promise<PermissionRequestV2> {
  let found: PermissionRequestV2 | undefined;
  await vi.waitFor(() => {
    found = events.filter((event): event is Extract<DesktopEventV2, {type: 'permission.requested'}> => event.type === 'permission.requested')
      .map(event => event.request as PermissionRequestV2).find(request => predicate(request) && !excluded.includes(request.id));
    expect(found).toBeDefined();
  });
  return found!;
}
export async function decide(gateway: DesktopGatewayV2, requestId: string, principal: PrincipalV2 = owner, outcome: 'allow' | 'deny' = 'allow', scope: 'once' | 'task' = 'once') {
  return gateway.dispatch(cmd({ type: 'permission.decide', decision: { requestId, outcome, scope } }), principal);
}
export async function finished(events: DesktopEventV2[], taskId: string) {
  let event: DesktopEventV2 | undefined;
  await vi.waitFor(() => {
    event = events.find(item => ['task.completed', 'task.failed', 'task.cancelled'].includes(item.type) && 'taskId' in item && item.taskId === taskId);
    expect(event).toBeDefined();
  });
  return event!;
}
export function audits(events: DesktopEventV2[]) {
  return events.filter((event): event is Extract<DesktopEventV2, {type: 'grant.audited'}> => event.type === 'grant.audited').map(event => event.entry);
}
/** A promise with an external resolver, for pausing fake agents. */
export function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; }

/** Deterministic clock: timers fire only from `advance` / `fireDue`, in due order. */
export class FakeClock implements GatewayClock {
  private timers = new Map<number, {at: number; callback: () => void}>(); private seq = 0;
  constructor(public time: number) {}
  now = () => this.time;
  setTimeout = (callback: () => void, ms: number) => { const id = ++this.seq; this.timers.set(id, { at: this.time + ms, callback }); return id; };
  clearTimeout = (handle: unknown) => { this.timers.delete(handle as number); };
  get pending(): number { return this.timers.size; }
  /** Normal running host: time passes and timers fire on time, letting the gateway settle between fires. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.timers.delete(next[0]); this.time = Math.max(this.time, next[1].at); next[1].callback();
      await settle();
    }
    this.time = target; await settle();
  }
  /** Suspended host (sleep): time passes without any timer firing. */
  sleep(ms: number): void { this.time += ms; }
  /** Fires every timer that is due now (late after a sleep). */
  async fireDue(): Promise<void> {
    for (const [id, timer] of [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > this.time || !this.timers.has(id)) continue;
      this.timers.delete(id); timer.callback(); await settle();
    }
  }
}
export async function settle(): Promise<void> { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); }

export class FakeSkills implements SkillCatalog {
  listed: string[][] = [];
  constructor(public skills: SkillInfo[], public bodies: Record<string, string>) {}
  async list(workspaces: string[]) { this.listed.push([...workspaces]); return structuredClone(this.skills.filter(skill => skill.source === 'global' || workspaces.some(ws => skill.folder.startsWith(ws)))); }
  async read(skill: SkillInfo) {
    const body = this.bodies[`${skill.source}:${skill.id}`];
    if (body === undefined) throw new Error('unreadable');
    return body;
  }
}

export function notifications(events: DesktopEventV2[]): OwnerNotification[] {
  return events.filter((event): event is Extract<DesktopEventV2, {type: 'notification'}> => event.type === 'notification').map(event => event.notification);
}
export function runEvents(events: DesktopEventV2[]): RoutineRun[] {
  return events.filter((event): event is Extract<DesktopEventV2, {type: 'routine.run'}> => event.type === 'routine.run').map(event => event.run);
}
/** Latest state of each run, in creation order. */
export function latestRuns(events: DesktopEventV2[]): RoutineRun[] {
  const runs = new Map<string, RoutineRun>();
  for (const run of runEvents(events)) runs.set(run.id, run);
  return [...runs.values()];
}
export async function runStatus(events: DesktopEventV2[], predicate: (run: RoutineRun) => boolean): Promise<RoutineRun> {
  let found: RoutineRun | undefined;
  await vi.waitFor(() => { found = latestRuns(events).find(predicate); expect(found).toBeDefined(); });
  return found!;
}
