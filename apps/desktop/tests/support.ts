import { vi } from 'vitest';
import type { AppSnapshotV2, Bot, CommandResultV2, DesktopCommandV2, DesktopEventV2, EventPayloadV2, SessionV2 } from '@your-bot/contracts';
import { emptySnapshot, type DesktopTransport } from '../src/renderer/store';

export const T0 = '2026-03-01T09:00:00.000Z';
export const agents: AppSnapshotV2['agents'] = [
  { id: 'grok', name: 'Grok Build', kind: 'acp', models: [{ id: 'grok-4', name: 'Grok 4' }, { id: 'grok-mini', name: 'Grok mini' }], available: true },
  { id: 'local', name: 'Local model', kind: 'local', models: [{ id: 'm1', name: 'Model one' }], available: true },
];
export const coder: Bot = {
  id: 'bot-1', name: 'Coder', instructions: 'Be careful', agentId: 'grok', modelId: 'grok-4', workspace: '/w', profile: 'trusted',
  mcpServers: [{ id: 'tracker', name: 'Tracker', enabled: true, transport: 'stdio', command: 'tracker-mcp', env: { TOKEN: '' } }],
  skills: ['summarize'], memoryEnabled: true, compaction: { maxMessages: 40, keepRecent: 8 }, createdAt: T0, updatedAt: T0,
};
export const helper: Bot = { id: 'bot-2', name: 'Helper', instructions: '', agentId: 'local', profile: 'strict', mcpServers: [], skills: [], memoryEnabled: false, createdAt: T0, updatedAt: T0 };
export const session = (id: string, botId: string | undefined, title: string): SessionV2 => ({ id, ...(botId ? { botId } : {}), title, agentId: 'grok', createdAt: T0, updatedAt: T0, messages: [] });

export type Responder = (command: DesktopCommandV2) => Partial<CommandResultV2> | CommandResultV2 | void | Promise<Partial<CommandResultV2> | CommandResultV2 | void>;

/** A fake v2 transport: state.sync serves `snapshot`; everything else is answered by `respond` (default `{ok: true}`). */
export function harness(initial: Partial<AppSnapshotV2> = {}, respond: Responder = () => undefined) {
  const snapshot: AppSnapshotV2 = { ...emptySnapshot(), agents, ...initial };
  let listener: ((event: DesktopEventV2) => void) | undefined;
  let sequence = snapshot.lastSequence;
  const dispatch = vi.fn(async (command: DesktopCommandV2): Promise<CommandResultV2> => {
    if (command.type === 'state.sync') return { ok: true, commandId: command.id, snapshot: structuredClone(snapshot) };
    const answer = await respond(command);
    if (answer && 'ok' in answer && answer.ok === false) return answer as CommandResultV2;
    return { ok: true, commandId: command.id, ...(answer ?? {}) } as CommandResultV2;
  });
  const chooseDirectory = vi.fn(async () => '/home/me/project');
  const transport: DesktopTransport = { dispatch, subscribe: fn => { listener = fn; return () => { listener = undefined; }; }, chooseDirectory };
  const emit = (payload: EventPayloadV2, version: 1 | 2 = 2): void => listener?.({ ...payload, version, sequence: ++sequence, timestamp: T0, principalId: 'local-owner' } as DesktopEventV2);
  const commands = <T extends DesktopCommandV2['type']>(type: T): Extract<DesktopCommandV2, { type: T }>[] => dispatch.mock.calls.map(([command]) => command).filter((command): command is Extract<DesktopCommandV2, { type: T }> => command.type === type);
  return { transport, dispatch, emit, commands, snapshot, chooseDirectory };
}
