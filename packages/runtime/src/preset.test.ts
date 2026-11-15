import { describe, expect, it } from 'vitest';
import { PLAYWRIGHT_MCP_VERSION } from '@your-bot/mcp';
import { expandHostMcpServer } from './mcp-host.js';

describe('expandHostMcpServer', () => {
  it('expands a browser preset that already names npx and pins the browser cwd', () => {
    const input = { id: 'browser', name: 'Browser', enabled: true, preset: 'browser' as const, transport: 'stdio' as const, command: 'npx' };
    expect(expandHostMcpServer(input, '/data/mcp/browser')).toMatchObject({
      preset: 'browser',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`, '--headless', '--isolated'],
      cwd: '/data/mcp/browser',
    });
  });

  it('keeps an explicit cwd and returns a config without a preset unchanged', () => {
    const plain = { id: 'tools', name: 'Tools', enabled: true, transport: 'stdio' as const, command: 'npx' };
    expect(expandHostMcpServer(plain, '/data/mcp/browser')).toBe(plain);
    const kept = { ...plain, preset: 'browser' as const, cwd: '/keep' };
    expect(expandHostMcpServer(kept, '/data/mcp/browser')).toMatchObject({ cwd: '/keep', command: 'npx' });
  });
});
