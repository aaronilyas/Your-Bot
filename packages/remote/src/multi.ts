/** Connects to every saved host at once and merges their events and pending approvals. */
import { randomUUID } from 'node:crypto';
import type { CommandResultV2, DesktopCommandV2, DesktopEventV2, PermissionDecisionV2, PermissionRequestV2, Unsubscribe } from '@your-bot/contracts';
import { RemoteTransport, type RemoteTransportOptions, type TransportStatus } from './client.js';
import type { HostDirectory, SavedHost } from './directory.js';

export interface HostState extends SavedHost { status: TransportStatus; error?: string; }
export interface PendingApproval { hostId: string; hostName: string; request: PermissionRequestV2; }

export class MultiHostClient {
  private readonly transports = new Map<string, RemoteTransport>();
  private readonly listeners = new Set<(hostId: string, event: DesktopEventV2) => void>();
  private readonly statusListeners = new Set<(hostId: string, status: TransportStatus) => void>();
  constructor(private readonly directory: HostDirectory, private readonly options: Omit<RemoteTransportOptions, 'credentials' | 'afterSequence'> & { persistCursor?: boolean } = {}) {}

  /** Every saved host with its live status (`idle` if not started). */
  hosts(): HostState[] {
    return this.directory.list().map(host => {
      const transport = this.transports.get(host.hostId);
      return { ...host, status: transport?.status ?? 'idle', ...(transport?.lastError ? { error: transport.lastError.message } : {}) };
    });
  }
  transport(hostId: string): RemoteTransport | undefined { return this.transports.get(hostId); }

  /**
   * Starts (or reuses) a transport per host and waits until each one is ready or has failed its
   * first attempt. Hosts that failed keep reconnecting in the background unless the failure is
   * permanent. Returns per-host outcomes.
   */
  async start(hostIds?: string[]): Promise<{ hostId: string; ok: boolean; error?: string }[]> {
    const hosts = this.directory.list().filter(h => !hostIds || hostIds.includes(h.hostId));
    return Promise.all(hosts.map(async host => {
      let transport = this.transports.get(host.hostId);
      if (!transport) {
        let credentials;
        try { credentials = this.directory.credentials(host.hostId); }
        catch (error) { return { hostId: host.hostId, ok: false, error: (error as Error).message }; }
        transport = new RemoteTransport({ ...this.options, credentials, ...(host.lastSequence !== undefined ? { afterSequence: host.lastSequence } : {}) });
        const hostId = host.hostId, current = transport;
        current.subscribe(event => {
          if (this.options.persistCursor && current.lastSequence !== undefined) { try { this.directory.setLastSequence(hostId, current.lastSequence); } catch { /* best effort */ } }
          for (const listener of this.listeners) { try { listener(hostId, event); } catch { /* isolate */ } }
        });
        current.onStatus(status => { for (const listener of this.statusListeners) { try { listener(hostId, status); } catch { /* isolate */ } } });
        this.transports.set(host.hostId, transport);
      }
      try { await transport.connect(); return { hostId: host.hostId, ok: true }; }
      catch (error) { return { hostId: host.hostId, ok: false, error: (error as Error).message }; }
    }));
  }
  subscribe(listener: (hostId: string, event: DesktopEventV2) => void): Unsubscribe { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onStatus(listener: (hostId: string, status: TransportStatus) => void): Unsubscribe { this.statusListeners.add(listener); return () => { this.statusListeners.delete(listener); }; }

  /** Pending permission requests across all connected hosts (from each host's synchronized snapshot). */
  pendingApprovals(hostId?: string): PendingApproval[] {
    const out: PendingApproval[] = [];
    for (const [id, transport] of this.transports) {
      if (hostId && id !== hostId) continue;
      for (const request of transport.snapshot?.pendingPermissions ?? []) out.push({ hostId: id, hostName: transport.ready?.hostName ?? transport.snapshot?.host?.name ?? id, request });
    }
    return out;
  }
  dispatch(hostId: string, command: DesktopCommandV2): Promise<CommandResultV2> {
    const transport = this.transports.get(hostId);
    if (!transport) return Promise.resolve({ ok: false, commandId: command.id, error: { code: 'UNKNOWN_HOST', message: `Host ${hostId} is not connected` } });
    return transport.dispatch(command);
  }
  decide(hostId: string, decision: PermissionDecisionV2): Promise<CommandResultV2> {
    return this.dispatch(hostId, { version: 2, id: randomUUID(), type: 'permission.decide', decision });
  }
  async close(): Promise<void> {
    await Promise.all([...this.transports.values()].map(t => t.close()));
    this.transports.clear();
  }
}
