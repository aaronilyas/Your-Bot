import { app } from 'electron';
import assert from 'node:assert/strict';
import { createDesktopHost } from '../dist/main/host.js';
const snapshot = { sessions: [], agents: [{ id: 'smoke-agent', name: 'Smoke agent', kind: 'local', available: true, models: [{ id: 'smoke-model', name: 'Smoke model' }] }], settings: { providers: [{ id: 'p', name: 'Local', kind: 'lmstudio', enabled: true, apiKey: 'never-render-this' }] }, activeTasks: [], pendingPermissions: [], lastSequence: 0 };
let boundPrincipal;
const watchdog = setTimeout(() => { console.error('DESKTOP_SMOKE_TIMEOUT'); app.exit(1); }, 15000);
let host;
try {
  host = await createDesktopHost({ gatewayFactory: ({ principal }) => {
    boundPrincipal = principal;
    return { async dispatch(command, identity) { assert.equal(identity, boundPrincipal); return { ok: true, commandId: command.id, snapshot }; }, subscribe() { return () => {}; }, async requestPermission() { throw new Error('unused'); }, async cancelTask() {}, async close() {} };
  } });
  const preferences = host.window.webContents.getLastWebPreferences();
  assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
  const result = await host.window.webContents.executeJavaScript(`(async () => {
    const transport = window.yourBot;
    const snapshot = await transport.dispatch({version:1,id:'smoke-sync',type:'state.sync'});
    const forged = await transport.dispatch({version:1,id:'smoke-forge',type:'state.sync',principalId:'admin'});
    await new Promise(resolve => setTimeout(resolve, 500));
    return { keys: Object.keys(transport).sort(), node: typeof require, snapshot, forged, title: document.title, text: document.body.innerText, csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content };
  })()`);
  assert.deepEqual(result.keys, ['dispatch', 'subscribe']); assert.equal(result.node, 'undefined');
  assert.equal(result.snapshot.snapshot.settings.providers[0].apiKey, undefined);
  assert.equal(result.forged.ok, false); assert.equal(result.forged.error.code, 'INVALID_COMMAND');
  assert.equal(result.title, 'Your Bot'); assert.match(result.text, /Where shall we begin/); assert.match(result.text, /Backend connected/);
  assert.match(result.csp, /connect-src 'none'/);
  console.log('DESKTOP_SMOKE_OK: packaged renderer, sandbox preload, identity binding, credential redaction, command rejection, CSP');
  await host.close(); clearTimeout(watchdog); app.exit(0);
} catch (error) { console.error(error); if (host) await host.close(); clearTimeout(watchdog); app.exit(1); }
