import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { createMcpBroker, expandPreset } from './index.js';

/**
 * OPT-IN real browser test (not part of the default run): set YOUR_BOT_BROWSER_TEST=1.
 * Needs network access to npm (npx fetches the pinned @playwright/mcp) and a Chromium/Chrome.
 * Set YOUR_BOT_BROWSER_EXECUTABLE=/path/to/chrome to use a system browser instead of Playwright's download.
 */
const enabled = process.env.YOUR_BOT_BROWSER_TEST === '1';

describe('browser preset (opt-in: YOUR_BOT_BROWSER_TEST=1)', () => {
  it.skipIf(!enabled)('opens a local file:// page through the proxy and reads its title', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcp-browser-'));
    const page = path.join(dir, 'page.html');
    writeFileSync(page, '<!doctype html><html><head><title>Your Bot Browser Test</title></head><body><h1>hello</h1></body></html>');
    const preset = expandPreset({ id: 'browser', name: 'Browser', enabled: true, preset: 'browser', transport: 'stdio', command: '' });
    if (preset.transport !== 'stdio') throw new Error('expected stdio');
    const executable = process.env.YOUR_BOT_BROWSER_EXECUTABLE;
    // The preset deliberately blocks file:// (Playwright MCP default); the test opts in for its local page only.
    const config = { ...preset, cwd: dir, args: [...(preset.args ?? []), '--allow-unrestricted-file-access', ...(executable ? ['--executable-path', executable] : [])] };
    const broker = createMcpBroker({ connectTimeoutMs: 180_000 });
    const decisions: string[] = [];
    const session = await broker.open({
      taskId: 't', botId: 'b', servers: [config], builtins: [],
      authorize: async call => { decisions.push(call.tool); return true; }, signal: new AbortController().signal
    });
    const client = new Client({ name: 'browser-test', version: '1.0.0' });
    try {
      expect(session.failures()).toEqual([]);
      const names = (await session.tools()).map(tool => tool.name);
      expect(names).toContain('browser_navigate');
      await client.connect(new StreamableHTTPClientTransport(new URL(session.endpoint.url), {
        requestInit: { headers: Object.fromEntries(session.endpoint.headers.map(header => [header.name, header.value])) }
      }));
      const nav = await client.callTool({ name: 'browser__browser_navigate', arguments: { url: pathToFileURL(page).href } });
      const evaluated = await client.callTool({ name: 'browser__browser_evaluate', arguments: { function: '() => document.title' } });
      const text = JSON.stringify([nav, evaluated]);
      expect(text).toContain('Your Bot Browser Test');
      expect(decisions).toEqual(['browser_navigate', 'browser_evaluate']);
    } finally {
      await client.close().catch(() => undefined);
      await session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
