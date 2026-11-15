// Fake trusted ACP agent for headless runtime tests.
// Mode `act`: write workspace/edited.txt and run node to write workspace/ran.txt.
// Relative paths and the default terminal cwd stay inside the bot workspace.
// No loadSession advertisement. Speaks newline-delimited JSON-RPC on stdio.
import readline from 'node:readline';

const mode = process.argv[2] ?? 'act';
const sessionId = 'trusted-session';
let promptId;
let next = 100;
const pending = new Map();

const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const reply = (id, result) => send({ id, result });
const fail = (id, code, message) => send({ id, error: { code, message } });
const ask = (method, params) => new Promise(resolve => {
  const id = next++;
  pending.set(id, resolve);
  send({ id, method, params });
});

async function act() {
  const script = "require('node:fs').writeFileSync('ran.txt','ok\\n')";
  try {
    await ask('fs/write_text_file', { sessionId, path: 'edited.txt', content: 'edited-by-agent\n' });
    const created = await ask('terminal/create', { sessionId, command: process.execPath, args: ['-e', script] });
    const terminalId = created && created.terminalId;
    if (typeof terminalId === 'string' && terminalId) {
      await ask('terminal/wait_for_exit', { sessionId, terminalId });
      await ask('terminal/release', { sessionId, terminalId });
    }
  } finally {
    try { reply(promptId, { stopReason: 'end_turn' }); } catch { /* stdout may already be closed */ }
  }
}

readline.createInterface({ input: process.stdin }).on('line', raw => {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const callback = pending.get(msg.id);
    pending.delete(msg.id);
    callback(Object.hasOwn(msg, 'result') ? msg.result : msg.error);
    return;
  }
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, mcpCapabilities: { http: false, sse: false } },
      authMethods: [],
    });
    return;
  }
  if (msg.method === 'session/new') {
    reply(msg.id, { sessionId });
    return;
  }
  if (msg.method === 'session/prompt') {
    promptId = msg.id;
    if (mode === 'act') { void act(); return; }
    fail(msg.id, -32601, `unsupported mode ${mode}`);
    return;
  }
  if (msg.id !== undefined) fail(msg.id, -32601, `unexpected ${msg.method ?? 'request'}`);
});
