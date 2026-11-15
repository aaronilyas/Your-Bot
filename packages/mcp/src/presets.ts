import type { McpServerConfig } from '@your-bot/contracts';

/** Pinned Playwright MCP release used by the `browser` preset. Bump deliberately. */
export const PLAYWRIGHT_MCP_VERSION = '0.0.85';

type StdioConfig = Extract<McpServerConfig, { transport: 'stdio' }>;

/**
 * Expands `preset: 'browser'` into a stdio server running the pinned `@playwright/mcp`
 * (`--headless --isolated`: no window, in-memory profile that is never written to disk).
 * Command and args of the incoming config are replaced; `env`/`cwd` of a stdio config are kept.
 * Configs without a known preset are returned unchanged. Idempotent.
 */
export function expandPreset(config: McpServerConfig): McpServerConfig {
  if (config.preset !== 'browser') return config;
  const previous = config.transport === 'stdio' ? config : undefined;
  const expanded: StdioConfig = {
    id: config.id,
    name: config.name,
    enabled: config.enabled,
    preset: 'browser',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`, '--headless', '--isolated']
  };
  if (previous?.env) expanded.env = { ...previous.env };
  if (previous?.cwd) expanded.cwd = previous.cwd;
  return expanded;
}
