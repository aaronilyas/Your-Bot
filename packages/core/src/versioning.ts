import type {
  AppSettings, AppSettingsV2, AppSnapshot, AppSnapshotV2, Capability, CapabilityV2, ContractVersion, DesktopEvent,
  DesktopEventV2, PermissionRequest, PermissionRequestV2, Principal, PrincipalV2, ProviderConfig, ProviderConfigV2, Session, SessionV2,
} from '@your-bot/contracts';
import { V1_CAPABILITIES } from '@your-bot/contracts';

/** Event types introduced by contract v2; never delivered to v1 subscribers. */
export const V2_ONLY_EVENTS = new Set([
  'bot.updated', 'bot.deleted', 'grant.updated', 'grant.audited', 'memory.updated', 'routine.updated', 'routine.deleted',
  'routine.run', 'notification', 'device.updated', 'skills.updated',
]);
/** "Every event carries the version of the contract that defines its type." */
export function eventVersion(type: string): ContractVersion { return V2_ONLY_EVENTS.has(type) ? 2 : 1; }

export function isV1Capability(capability: CapabilityV2): capability is Capability { return (V1_CAPABILITIES as readonly string[]).includes(capability); }

export function sessionV1(session: SessionV2 | Session): Session {
  const { botId: _bot, summary: _summary, compactedCount: _count, ...rest } = session as SessionV2;
  return rest;
}
export function providerV1(provider: ProviderConfigV2 | ProviderConfig): ProviderConfig {
  const { launch: _launch, envPassthrough: _env, ...rest } = provider as ProviderConfigV2;
  return rest;
}
export function settingsV1(settings: AppSettingsV2 | AppSettings): AppSettings { return { providers: settings.providers.map(providerV1) }; }

/** v1 shape of a request, or undefined when its capability does not exist in v1 (withheld). */
export function requestV1(request: PermissionRequestV2): PermissionRequest | undefined {
  if (!isV1Capability(request.capability)) return undefined;
  const { botId: _bot, command: _command, mcp: _mcp, agentTool: _tool, routineRunId: _run, ...rest } = request;
  return { ...rest, capability: request.capability };
}
export function principalV1(principal: PrincipalV2): Principal {
  return { id: principal.id, kind: principal.kind, capabilities: principal.capabilities.filter(isV1Capability) };
}

export function snapshotV1(snapshot: AppSnapshotV2): AppSnapshot {
  return {
    sessions: snapshot.sessions.map(sessionV1), agents: snapshot.agents, settings: settingsV1(snapshot.settings),
    activeTasks: snapshot.activeTasks,
    pendingPermissions: snapshot.pendingPermissions.flatMap(request => { const v1 = requestV1(request); return v1 ? [v1] : []; }),
    lastSequence: snapshot.lastSequence,
  };
}

/** Converts a stored (v2-shaped) event for a subscriber; undefined means "withhold". */
export function eventFor(event: DesktopEventV2, version: ContractVersion): DesktopEventV2 | DesktopEvent | undefined {
  if (version === 2) return event;
  if (V2_ONLY_EVENTS.has(event.type)) return undefined;
  const meta = { version: 1 as const, sequence: event.sequence, timestamp: event.timestamp, principalId: event.principalId };
  switch (event.type) {
    case 'state.snapshot': return { type: 'state.snapshot', snapshot: snapshotV1(event.snapshot as AppSnapshotV2), ...meta };
    case 'session.updated': return { type: 'session.updated', session: sessionV1(event.session), ...meta };
    case 'permission.requested': {
      const request = requestV1(event.request);
      return request ? { type: 'permission.requested', request, ...meta } : undefined;
    }
    default: return { ...event, version: 1 } as DesktopEvent;
  }
}
