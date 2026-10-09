// Protocol mock only. The TEST launcher intentionally does not provide OS containment.
import readline from 'node:readline';
const mode = process.argv[2] ?? 'stream';
const sid = 'acp-session';
let promptId;
let next = 100;
let permissionCount = 0;
const configOptions = [{ id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: 'a', options:
  mode === 'model-grouped' ? [{ group: 'all', name: 'All', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] }]
    : [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] }];
const pending = new Map();
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const text = value => send({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } } } });
const reply = (id, result) => send({ id, result });
const finish = () => reply(promptId, { stopReason: 'end_turn' });
const ask = (method, params, callback) => {
  const id = next++;
  pending.set(id, callback);
  send({ id, method, params });
};
const permission = () => ask('session/request_permission', {
  sessionId: sid, toolCall: { toolCallId: 'native-1', title: 'Read approved file', kind: 'read', locations: [{ path: '/allowed/data' }] },
  options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
}, result => {
  text(`permission:${JSON.stringify(result)}`);
  if (mode === 'permission-many' && ++permissionCount < 2) permission();
  else finish();
});

readline.createInterface({ input: process.stdin }).on('line', raw => {
  const msg = JSON.parse(raw);
  if (msg.method === 'initialize') {
    if (mode === 'exit') process.exit(3);
    if (mode === 'malformed') { process.stdout.write('not-json\n'); return; }
    if (mode === 'timeout-init') return;
    reply(msg.id, { protocolVersion: mode === 'v2' ? 2 : 1, agentCapabilities: {}, authMethods: [] });
  } else if (msg.method === 'session/new') {
    reply(msg.id, { sessionId: sid, configOptions });
  } else if (msg.method === 'session/set_config_option') {
    configOptions[0].currentValue = msg.params.value;
    reply(msg.id, { configOptions });
  } else if (msg.method === 'session/prompt') {
    promptId = msg.id;
    if (mode === 'hang') { text('started'); return; }
    if (mode === 'permission' || mode === 'permission-many') { permission(); return; }
    if (mode === 'rpc-deny') {
      ask('fs/read_text_file', { sessionId: sid, path: '/etc/passwd' }, result => {
        text(`fs:${JSON.stringify(result)}`);
        ask('terminal/create', { sessionId: sid, command: 'sh' }, result => { text(`terminal:${JSON.stringify(result)}`); finish(); });
      });
      return;
    }
    if (mode === 'tool') {
      ask('_your_bot/execute_tool', { sessionId: sid, toolCallId: 'tool-1', arguments: { kind: 'skill', skillId: 'example', input: { hello: true } } }, result => { text(`tool:${JSON.stringify(result)}`); finish(); });
      return;
    }
    if (mode === 'wrong-session') {
      send({ method: 'session/update', params: { sessionId: 'wrong', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'wrong' } } } });
      return;
    }
    if (mode === 'oversize') { process.stdout.write('x'.repeat(4000)); return; }
    // Split multibyte unicode across stdout writes, interleave a notification.
    const raw = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello 🌍' } } } }) + '\r\n');
    const split = raw.indexOf(Buffer.from('🌍')) + 1;
    process.stdout.write(raw.subarray(0, split));
    setTimeout(() => {
      process.stdout.write(raw.subarray(split));
      send({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId: 'native', title: 'Thinking', kind: 'think', status: 'completed' } } });
      process.stderr.write('SENSITIVE HARNESS DIAGNOSTIC\n');
      finish();
    }, 10);
  } else if (msg.method === 'session/cancel') {
    text('late text');
    if (promptId) reply(promptId, { stopReason: 'cancelled' });
  } else if (msg.id !== undefined && pending.has(msg.id)) {
    const callback = pending.get(msg.id);
    pending.delete(msg.id);
    callback(msg.result ?? msg.error);
  }
});
