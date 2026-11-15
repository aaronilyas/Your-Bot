// Fake trusted ACP agent. Speaks newline-delimited JSON-RPC on stdio.
// argv: mode, optional trace file. Cross-platform; no shell.
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const mode = process.argv[2] ?? 'echo';
const tracePath = process.argv[3];
const sid = 'trusted-session';
let activeSession = sid;
let promptId;
let next = 100;
const pending = new Map();
const configOptions = [{ id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: 'a', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] }];

const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const trace = entry => { if (tracePath) appendFileSync(tracePath, JSON.stringify(entry) + '\n'); };
const text = value => send({ method: 'session/update', params: { sessionId: activeSession, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } } } });
const reply = (id, result) => send({ id, result });
const fail = (id, code, message) => send({ id, error: { code, message } });
const ask = (method, params) => new Promise(resolve => {
  const id = next++;
  pending.set(id, resolve);
  send({ id, method, params });
});
const permissionParams = sessionId => ({
  sessionId,
  toolCall: { toolCallId: 'tool-9', title: 'Edit file', kind: 'edit' },
  options: [
    { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'always', name: 'Always', kind: 'allow_always' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
  ],
});

trace({ method: 'startup', params: { pid: process.pid } });

const capabilities = () => ({
  loadSession: mode !== 'no-load',
  mcpCapabilities: { http: mode !== 'no-http', sse: false },
  ...(mode === 'system' ? { sessionCapabilities: { systemPrompt: {} } } : {}),
});

async function exercise(prompt) {
  const sessionId = activeSession;
  if (mode === 'bad-session') {
    text('bad:' + JSON.stringify(await ask('fs/read_text_file', { sessionId: 'nope', path: '/etc/passwd' })));
    reply(promptId, { stopReason: 'end_turn' });
    return;
  }
  if (mode === 'slow-permission') {
    text('perm:' + JSON.stringify(await ask('session/request_permission', permissionParams(sessionId))));
    reply(promptId, { stopReason: 'end_turn' });
    return;
  }
  if (mode === 'host-error') {
    text('read:' + JSON.stringify(await ask('fs/read_text_file', { sessionId, path: '/secret/place' })));
    reply(promptId, { stopReason: 'end_turn' });
    return;
  }
  if (mode === 'tool') {
    text('tool:' + JSON.stringify(await ask('_your_bot/execute_tool', {
      sessionId, toolCallId: 'tool-1', arguments: { kind: 'skill', skillId: 'example', input: { hello: true } },
    })));
    reply(promptId, { stopReason: 'end_turn' });
    return;
  }
  text('read:' + JSON.stringify(await ask('fs/read_text_file', { sessionId, path: '/w/a.txt', line: 2, limit: 3 })));
  text('write:' + JSON.stringify(await ask('fs/write_text_file', { sessionId, path: '/w/b.txt', content: 'hello' })));
  const term = await ask('terminal/create', { sessionId, command: 'node', args: ['-e', '1'], env: [{ name: 'A', value: 'B' }], cwd: '/w', outputByteLimit: 100 });
  text('create:' + JSON.stringify(term));
  const terminalId = term && term.terminalId;
  text('output:' + JSON.stringify(await ask('terminal/output', { sessionId, terminalId })));
  text('exit:' + JSON.stringify(await ask('terminal/wait_for_exit', { sessionId, terminalId })));
  text('kill:' + JSON.stringify(await ask('terminal/kill', { sessionId, terminalId })));
  text('release:' + JSON.stringify(await ask('terminal/release', { sessionId, terminalId })));
  text('perm:' + JSON.stringify(await ask('session/request_permission', permissionParams(sessionId))));
  text('prompt:' + prompt);
  reply(promptId, { stopReason: 'end_turn' });
}

readline.createInterface({ input: process.stdin }).on('line', raw => {
  const msg = JSON.parse(raw);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const callback = pending.get(msg.id);
    pending.delete(msg.id);
    callback(Object.hasOwn(msg, 'result') ? msg.result : msg.error);
    return;
  }
  trace({ method: msg.method, params: msg.params });
  if (msg.method === 'initialize') {
    if (mode === 'hang-init') return;
    reply(msg.id, { protocolVersion: mode === 'v2' ? 2 : 1, agentCapabilities: capabilities(), authMethods: [] });
  } else if (msg.method === 'session/load') {
    activeSession = msg.params.sessionId;
    if (mode === 'load-fail') { fail(msg.id, -32000, 'missing'); return; }
    send({ method: 'session/update', params: { sessionId: activeSession, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAY_SHOULD_NOT_LEAK' } } } });
    reply(msg.id, { configOptions });
  } else if (msg.method === 'session/new') {
    activeSession = sid;
    reply(msg.id, { sessionId: sid, configOptions });
  } else if (msg.method === 'session/set_config_option') {
    configOptions[0].currentValue = msg.params.value;
    reply(msg.id, { configOptions });
  } else if (msg.method === 'session/prompt') {
    promptId = msg.id;
    const prompt = msg.params?.prompt?.[0]?.text ?? '';
    if (mode === 'env') {
      text(`env:${Object.keys(process.env).sort().join(',')} secret:${process.env.YOUR_BOT_SECRET_SHOULD_NOT_LEAK ?? ''} pass:${process.env.YOUR_BOT_PASS ?? ''}`);
      reply(promptId, { stopReason: 'end_turn' });
      return;
    }
    if (['exercise', 'host-error', 'bad-session', 'slow-permission', 'tool'].includes(mode)) {
      void exercise(prompt);
      return;
    }
    text(prompt);
    reply(promptId, { stopReason: 'end_turn' });
  } else if (msg.method === 'session/cancel') {
    if (promptId !== undefined) reply(promptId, { stopReason: 'cancelled' });
  }
});
