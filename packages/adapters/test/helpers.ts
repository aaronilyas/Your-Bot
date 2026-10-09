import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AgentRunContext, AgentUpdate, ProviderConfig } from '@your-bot/contracts';
import { vi } from 'vitest';

export function context(overrides: Partial<AgentRunContext> = {}): AgentRunContext & { updates: AgentUpdate[] } {
  const updates: AgentUpdate[] = [];
  return {
    taskId: 'task-1',
    session: { id: 'session-1', agentId: 'local', title: 'Test', createdAt: '', updatedAt: '', messages: [{ id: 'm1', role: 'user', content: 'Hello', createdAt: '' }] },
    principal: { id: 'owner', kind: 'local', capabilities: ['conversation', 'tool.execute'] },
    signal: new AbortController().signal,
    emit: update => updates.push(update),
    executeTool: vi.fn(async () => ({ ok: true, value: 'host-result' })),
    requestPermission: vi.fn<AgentRunContext['requestPermission']>(async () => ({ requestId: 'p1', outcome: 'deny', scope: 'once' })),
    ...overrides, updates,
  };
}

export function provider(endpoint: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id: 'local', name: 'Local model', kind: 'openai-compatible', enabled: true, endpoint, modelId: 'test-model', ...overrides };
}

export async function httpServer(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => { Promise.resolve(handler(req, res)).catch(() => { res.destroy(); }); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

export async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
}

export function event(delta: unknown, finish_reason: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`;
}

export async function waitUntil(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('Condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
