import json
import sys

def send(message):
    print(json.dumps(dict(jsonrpc='2.0', **message)), flush=True)

for line in sys.stdin:
    message = json.loads(line)
    if message.get('method') == 'initialize':
        send(dict(id=message['id'], result=dict(protocolVersion=1)))
    elif message.get('method') == 'session/new':
        send(dict(id=message['id'], result=dict(sessionId='contained-session')))
    elif message.get('method') == 'session/prompt':
        send(dict(method='session/update', params=dict(sessionId='contained-session', update=dict(
            sessionUpdate='agent_message_chunk', content=dict(type='text', text='Contained 🌍')))))
        send(dict(id=message['id'], result=dict(stopReason='end_turn')))
