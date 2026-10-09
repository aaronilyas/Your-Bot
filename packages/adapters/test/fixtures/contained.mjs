import fs from 'node:fs';
import readline from 'node:readline';

const send = message => fs.writeSync(1, JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: 1 } });
  if (message.method === 'session/new') send({ id: message.id, result: { sessionId: 'contained-session' } });
  if (message.method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: 'contained-session', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: message.params.prompt[0].text === 'Hang' ? 'started' : 'Contained 🌍' },
    } } });
    if (message.params.prompt[0].text === 'Hang') return;
    send({ id: message.id, result: { stopReason: 'end_turn' } });
  }
});
