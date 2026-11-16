/** In-memory DesktopGatewayV2 for transport tests. Records every principal it receives. */
import type {
  AnyCommandResult, AnyDesktopCommand, AppSnapshotV2, DesktopEventV2, DesktopGatewayV2, EventPayloadV2,
  PermissionDecision, PermissionRequestV2, Principal, PrincipalV2, SubscribeOptions,
} from '@your-bot/contracts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type AnyPrincipal = Principal | PrincipalV2;
const ownerOf = (p: AnyPrincipal) => ('ownerId' in p && p.ownerId) || p.id;

export class FakeGateway implements DesktopGatewayV2 {
  readonly dispatched: { command: AnyDesktopCommand; principal: AnyPrincipal }[] = [];
  readonly subscriptions: { principal: AnyPrincipal; options?: SubscribeOptions; active: boolean }[] = [];
  readonly cancelled: string[] = [];
  readonly log: DesktopEventV2[] = [];
  pending: PermissionRequestV2[] = [];
  readonly decisions: { decision: unknown; principal: AnyPrincipal }[] = [];
  private listeners = new Map<string, Set<(event: DesktopEventV2) => void>>();
  private sequence = 0;
  constructor(readonly hostId = 'host', readonly hostName = 'Fake host') {}

  emit(owner: string, payload: EventPayloadV2): DesktopEventV2 {
    const event = { ...payload, version: 2, sequence: ++this.sequence, timestamp: new Date().toISOString(), principalId: owner } as DesktopEventV2;
    this.log.push(event);
    for (const listener of this.listeners.get(owner) ?? []) listener(structuredClone(event));
    return event;
  }
  addPending(owner: string, request: Omit<PermissionRequestV2, 'principalId' | 'sessionId' | 'taskId'> & Partial<Pick<PermissionRequestV2, 'sessionId' | 'taskId'>>): PermissionRequestV2 {
    const full = { sessionId: 'session', taskId: 'task', ...request, principalId: owner } as PermissionRequestV2;
    this.pending.push(full);
    this.emit(owner, { type: 'permission.requested', request: full });
    return full;
  }
  snapshot(owner: string): AppSnapshotV2 {
    return {
      sessions: [], agents: [], activeTasks: [], lastSequence: this.sequence, bots: [], grants: [], routines: [], routineRuns: [],
      notifications: [], skills: [], devices: [{ id: 'secret-device', name: 'x', capabilities: [], pairedAt: '' }],
      settings: { providers: [{ id: 'p', name: 'p', kind: 'openai-compatible', enabled: true, apiKey: 'sk-secret' }] },
      pendingPermissions: this.pending.filter(p => p.principalId === owner), host: { id: this.hostId, name: this.hostName },
    };
  }
  async dispatch(command: AnyDesktopCommand, principal: AnyPrincipal): Promise<AnyCommandResult> {
    this.dispatched.push({ command: structuredClone(command), principal: structuredClone(principal) });
    const owner = ownerOf(principal);
    const ok = { ok: true as const, commandId: command.id };
    switch (command.type) {
      case 'state.sync': {
        if (command.afterSequence !== undefined) {
          if (command.afterSequence > this.sequence) return { ok: false, commandId: command.id, error: { code: 'INVALID_CURSOR', message: 'ahead' } };
          for (const event of this.log.filter(e => e.principalId === owner && e.sequence > command.afterSequence!)) {
            for (const listener of this.listeners.get(owner) ?? []) listener(structuredClone(event));
          }
        }
        const snapshot = this.snapshot(owner);
        this.emit(owner, { type: 'state.snapshot', snapshot });
        return { ...ok, snapshot };
      }
      case 'permission.decide': {
        const request = this.pending.find(r => r.id === command.decision.requestId && r.principalId === owner);
        if (!request) return { ok: false, commandId: command.id, error: { code: 'NOT_FOUND', message: 'No such request' } };
        this.pending = this.pending.filter(r => r !== request);
        this.decisions.push({ decision: command.decision, principal });
        this.emit(owner, { type: 'permission.resolved', requestId: request.id, outcome: command.decision.outcome });
        return ok;
      }
      default: return ok;
    }
  }
  subscribe(listener: (event: DesktopEventV2) => void, principal: AnyPrincipal, options?: SubscribeOptions) {
    const owner = ownerOf(principal);
    const record = { principal: structuredClone(principal), options, active: true };
    this.subscriptions.push(record);
    const set = this.listeners.get(owner) ?? new Set(); set.add(listener); this.listeners.set(owner, set);
    return () => { record.active = false; set.delete(listener); };
  }
  async requestPermission(): Promise<PermissionDecision> { throw new Error('not used'); }
  async cancelTask(taskId: string): Promise<void> { this.cancelled.push(taskId); }
  async close(): Promise<void> {}
  activeSubscriptions(): number { return this.subscriptions.filter(s => s.active).length; }
}

export function tempDir(prefix = 'yb-remote-'): { path: string; cleanup(): void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
