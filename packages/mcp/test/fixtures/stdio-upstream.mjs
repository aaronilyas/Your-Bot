// Fake stdio MCP upstream used by the broker tests. Side effects are recorded in FIXTURE_COUNTER_FILE.
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const counter = process.env.FIXTURE_COUNTER_FILE;
const record = line => { if (counter) appendFileSync(counter, `${line}\n`); };
const object = properties => ({ type: 'object', properties });
const text = value => ({ content: [{ type: 'text', text: String(value) }] });

const server = new Server({ name: 'fixture-stdio', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'echo', description: 'Echo text', inputSchema: object({ text: { type: 'string' } }) },
    { name: 'side_effect', description: 'Records a call', inputSchema: object({}) },
    { name: 'pids', description: 'Returns own pid and a grandchild pid', inputSchema: object({}) },
    { name: 'env', description: 'Returns an env var', inputSchema: object({ name: { type: 'string' } }) },
    { name: 'huge', description: 'Returns >1 MiB', inputSchema: object({}) },
    { name: 'bad.name', description: 'Invalid proxied name', inputSchema: object({}) }
  ]
}));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args = {} } = request.params;
  record(`call:${name}`);
  if (name === 'echo') return text(args.text);
  if (name === 'side_effect') return text('done');
  if (name === 'env') return text(process.env[args.name] ?? '<unset>');
  if (name === 'huge') return text('x'.repeat(1024 * 1024 + 10));
  if (name === 'pids') {
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    return text(JSON.stringify({ pid: process.pid, grandchild: grandchild.pid }));
  }
  return { isError: true, content: [{ type: 'text', text: `unknown ${name}` }] };
});
await server.connect(new StdioServerTransport());
