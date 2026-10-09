import readline from 'node:readline';
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const sid = 'tools';
let prompt;
const observations = {};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: 1 } });
  else if (msg.method === 'session/new') send({ id: msg.id, result: { sessionId: sid } });
  else if (msg.method === 'session/prompt') {
    prompt = msg.id;
    send({ id: 100, method: 'session/request_permission', params: {
      sessionId: sid, toolCall: { toolCallId: 'native', title: 'Run terminal', kind: 'execute' },
      options: [{ optionId: 'no', kind: 'reject_once', name: 'Deny' }, { optionId: 'yes', kind: 'allow_once', name: 'Allow' }],
    } });
  } else if (msg.id === 100) {
    observations.permission = msg.result;
    send({ id: 101, method: 'fs/read_text_file', params: { sessionId: sid, path: '/home/secret' } });
  } else if (msg.id === 101) {
    observations.filesystem = msg.error.code;
    send({ id: 102, method: '_your_bot/execute_tool', params: {
      sessionId: sid, toolCallId: 'extension', arguments: { kind: 'skill', skillId: 'example', input: {} },
    } });
  } else if (msg.id === 102) {
    observations.tool = msg.result;
    send({ method: 'session/update', params: { sessionId: sid, update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(observations) },
    } } });
    send({ id: prompt, result: { stopReason: 'end_turn' } });
  }
});
