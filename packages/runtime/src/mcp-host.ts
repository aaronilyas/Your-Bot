import type { McpBroker, McpServerConfig } from '@your-bot/contracts';
import { createMcpBroker, expandPreset } from '@your-bot/mcp';

/**
 * The desktop UI sends the browser preset as `{preset:'browser', command:'npx'}` with no args.
 * The broker only expands a preset whose command is empty, so the host expands every config that
 * carries `preset` before the broker sees it. The browser preset's cwd is the data directory
 * (Playwright writes `<cwd>/.playwright-mcp`) unless the config already names one.
 */
export function expandHostMcpServer(config: McpServerConfig, browserCwd: string): McpServerConfig {
  if (!config.preset) return config;
  const expanded = expandPreset(config);
  if (expanded.preset === 'browser' && expanded.transport === 'stdio' && !expanded.cwd) return { ...expanded, cwd: browserCwd };
  return expanded;
}

/** McpBroker that expands presets on every open. `close` closes the inner broker once. */
export function createHostMcpBroker(browserCwd: string): McpBroker {
  const inner = createMcpBroker();
  return {
    open(input) {
      return inner.open({ ...input, servers: input.servers.map(server => expandHostMcpServer(server, browserCwd)) });
    },
    close: () => inner.close(),
  };
}
