// A real stdio ACP harness fixture; all Python execution is requested from core.
import readline from 'node:readline';
const sessionId = 'integration-acp';
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
let promptId;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: 1 } });
  else if (message.method === 'session/new') send({ id: message.id, result: { sessionId } });
  else if (message.method === 'session/prompt') {
    promptId = message.id;
    send({ id: 'python-tool', method: '_your_bot/execute_tool', params: { sessionId, toolCallId: 'acp-calculation', arguments: { kind: 'skill', skillId: 'calculation', input: { operation: 'sum', values: [20, 22] } } } });
  } else if (message.id === 'python-tool') {
    if (!message.result?.ok) throw new Error('Gateway tool execution failed');
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `ACP Python result: ${message.result.value}` } } } });
    send({ id: promptId, result: { stopReason: 'end_turn' } });
  } else if (message.method === 'session/cancel' && promptId) send({ id: promptId, result: { stopReason: 'cancelled' } });
});
