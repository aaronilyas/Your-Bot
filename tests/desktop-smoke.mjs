import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

// Observe real managed processes without changing the gateway/executor.
const children = [];
const originalSpawn = childProcess.spawn;
childProcess.spawn = (...args) => { const child = originalSpawn(...args); children.push(child); return child; };
syncBuiltinESMExports();
const dataPath = process.env.YOUR_BOT_SMOKE_DATA ?? '/home/desktop-test/state';
await mkdir(dataPath, { recursive: true, mode: 0o700 });
app.setPath('userData', dataPath);
const restart = process.argv.includes('--restart');
const server = createServer(async (request, response) => {
  if (request.url === '/v1/models') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'desktop-model' }] })); return; }
  let body = ''; for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  assert.equal(request.headers.authorization, 'Bearer smoke-local-secret');
  response.setHeader('Content-Type', 'text/event-stream');
  const frame = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (payload.messages.at(-1).role === 'tool') { frame({ content: 'Approved Python calculated ' }); frame({ content: '42.' }); frame({}, 'stop'); }
  else {
    frame({ tool_calls: [{ index: 0, id: 'native-calculation', type: 'function', function: { name: 'execute_tool', arguments: JSON.stringify({ kind: 'skill', skillId: 'calculation', input: { operation: 'sum', values: [20, 22] } }) } }] });
    frame({}, 'tool_calls');
  }
  response.end('data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let window;
const watchdog = setTimeout(() => { console.error('INTEGRATED_DESKTOP_TIMEOUT'); app.exit(1); }, 60000);
async function until(read, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('Native desktop condition timed out');
}
const evaluate = expression => window.webContents.executeJavaScript(expression);
const dispatch = payload => evaluate(`window.yourBot.dispatch(${JSON.stringify({ ...payload, version: 1, id: randomUUID() })})`);
const bodyText = () => evaluate('document.body.innerText');
const approve = async expected => {
  await until(async () => (await bodyText()).includes('Your permission is needed'));
  assert.match(await bodyText(), expected);
  await evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find(button => button.textContent === 'Allow once').click()`);
};
const state = async () => {
  const result = await dispatch({ type: 'state.sync' }); assert.equal(result.ok, true, JSON.stringify(result)); return result.snapshot;
};
try {
  const entry = process.env.YOUR_BOT_SMOKE_ENTRY ?? '/validation/application.asar/dist/main/entry.js';
  await import(pathToFileURL(entry).href);
  window = await until(() => BrowserWindow.getAllWindows()[0]);
  await until(async () => window.webContents.getURL().startsWith('file:') && !window.webContents.isLoading() && (await bodyText()).includes('Backend connected'));
  const prefs = window.webContents.getLastWebPreferences();
  assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
  assert.equal(await evaluate('typeof require'), 'undefined');
  assert.deepEqual(await evaluate('Object.keys(window.yourBot).sort()'), ['dispatch', 'subscribe']);
  const forged = await evaluate(`window.yourBot.dispatch({version:1,id:'forged-owner',type:'state.sync',principalId:'admin'})`);
  assert.equal(forged.ok, false);
  if (restart) {
    const restored = await state();
    assert.ok(restored.sessions.some(session => session.messages.some(message => message.content === 'Approved Python calculated 42.')));
    console.log('INTEGRATED_DESKTOP_RESTART_OK: actual SQLite conversation restoration');
  } else {
    await evaluate(`window.__smokeEvents=[]; window.yourBot.subscribe(event => window.__smokeEvents.push(event))`);
    const configured = await dispatch({ type: 'settings.update', settings: { providers: [{ id: 'native-local', name: 'Native local model', kind: 'lmstudio', endpoint: `http://127.0.0.1:${server.address().port}/v1`, enabled: true, apiKey: 'smoke-local-secret' }] } });
    assert.equal(configured.ok, true, JSON.stringify(configured));
    assert.ok(!JSON.stringify(await state()).includes('smoke-local-secret'));
    await until(async () => (await bodyText()).includes('Native local model'));
    await evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('New conversation')).click()`);
    await until(async () => (await state()).sessions.length === 1);
    await evaluate(`(() => { const input=document.querySelector('textarea[aria-label="Message"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'calculate'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await until(() => evaluate(`!document.querySelector('button[aria-label="Send message"]').disabled`));
    await evaluate(`document.querySelector('button[aria-label="Send message"]').click()`);
    await approve(/tool.execute/);
    await until(async () => (await bodyText()).includes('Approved Python calculated 42.'));
    const completed = await state(); const sessionId = completed.sessions[0].id;
    assert.ok(completed.sessions[0].messages.some(message => message.role === 'tool' && JSON.parse(message.content).result.value === 42));
    assert.ok(await evaluate(`window.__smokeEvents.some(event => event.type==='message.delta')`));
    const loop = await dispatch({ type: 'tool.run', sessionId, invocation: { id: 'native-loop', kind: 'python', code: "import time\nprint('native worker ready',flush=True)\nwhile True:\n time.sleep(0.1)", input: null, timeoutMs: 30000 } });
    assert.equal(loop.ok, true, JSON.stringify(loop));
    await approve(/custom Python sha256:/);
    await until(() => evaluate(`window.__smokeEvents.some(event => event.type==='tool.output' && event.text.includes('native worker ready'))`));
    const cancelled = await dispatch({ type: 'task.cancel', taskId: loop.taskId }); assert.equal(cancelled.ok, true);
    assert.equal((await state()).activeTasks.length, 0);
    // Quit with another worker still running; actual before-quit cleanup must kill it.
    const closing = await dispatch({ type: 'tool.run', sessionId, invocation: { id: 'shutdown-loop', kind: 'python', code: "import time\nprint('shutdown worker ready',flush=True)\nwhile True:\n time.sleep(0.1)", input: null, timeoutMs: 30000 } });
    assert.equal(closing.ok, true); await approve(/custom Python sha256:/);
    await until(() => evaluate(`window.__smokeEvents.some(event => event.type==='tool.output' && event.text.includes('shutdown worker ready'))`));
    console.log('INTEGRATED_DESKTOP_OK: actual packaged UI/preload/IPC/gateway/model streaming, permission dialog, real sandboxed Python, cancellation, credentials, renderer protections');
  }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  app.once('will-quit', () => {
    try {
      assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null), 'Managed process survived gateway shutdown');
      console.log('INTEGRATED_DESKTOP_SHUTDOWN_OK: managed subprocesses terminated'); clearTimeout(watchdog);
    } catch (error) { console.error(error); app.exit(1); }
  });
  app.quit();
} catch (error) {
  console.error(error); clearTimeout(watchdog); server.closeAllConnections(); server.close(); app.exit(1);
}
