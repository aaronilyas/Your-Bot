import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopStore } from './store';
import type { AgentRowInfo, LocalServerInfo, ProvidersApi, ProvidersScanResult } from '../shared/ipc';
import { Badge, Icon } from './ui';

interface RowNote { text: string; output?: string; tone?: 'good' | 'bad' }

/** "Agents on this computer": detected agent CLIs and local model servers, with one-click connect, update and sign-in. */
export function AgentsPanel({ api, store, onLinked }: { api: ProvidersApi; store: DesktopStore; onLinked: (providerIds: string[]) => void }) {
  const [scan, setScan] = useState<ProvidersScanResult>();
  const [scanning, setScanning] = useState(true);
  const [scanError, setScanError] = useState<string>();
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, RowNote>>({});
  const [message, setMessage] = useState<string>();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const refresh = useCallback(async () => {
    setScanning(true); setScanError(undefined);
    try { const result = await api.scan(); if (alive.current) setScan(result); }
    catch (error) { if (alive.current) setScanError(error instanceof Error ? error.message : 'Could not scan this computer.'); }
    if (alive.current) setScanning(false);
  }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);
  const mark = (id: string, action?: string) => setBusy(current => { const next = { ...current }; if (action) next[id] = action; else delete next[id]; return next; });
  const note = (id: string, value?: RowNote) => setNotes(current => { const next = { ...current }; if (value) next[id] = value; else delete next[id]; return next; });
  async function connect(targets: string[] | 'all', key: string) {
    mark(key, 'connect'); setMessage(undefined);
    try {
      const result = await api.link(targets);
      if (!alive.current) return;
      if (result.error) setMessage(result.error);
      else {
        if (result.linked.length) { await store.command({ type: 'state.sync' }); if (alive.current) onLinked(result.linked.map(entry => entry.providerId)); }
        const names = result.linked.map(entry => entry.name).join(', ');
        const skipped = result.skipped.map(entry => entry.reason).join(' ');
        setMessage([names ? `Connected ${names}.` : 'Nothing new to connect.', skipped].filter(Boolean).join(' '));
        await refresh();
      }
    } catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : 'Could not connect.'); }
    if (alive.current) mark(key);
  }
  async function update(agent: AgentRowInfo) {
    mark(agent.id, 'update'); note(agent.id);
    try {
      const result = await api.update(agent.id);
      if (!alive.current) return;
      note(agent.id, { text: result.message, output: result.output, tone: result.ok ? 'good' : 'bad' });
      if (result.ok) await refresh();
    } catch (error) { if (alive.current) note(agent.id, { text: error instanceof Error ? error.message : 'Update failed.', tone: 'bad' }); }
    if (alive.current) mark(agent.id);
  }
  async function signIn(agent: AgentRowInfo) {
    mark(agent.id, 'login'); note(agent.id);
    try {
      const result = await api.login(agent.id);
      if (alive.current) note(agent.id, result.ok ? { text: 'Finish signing in in the terminal window that opened, then press Rescan.', tone: 'good' } : { text: result.message ?? 'Could not open a terminal.', tone: 'bad' });
    } catch (error) { if (alive.current) note(agent.id, { text: error instanceof Error ? error.message : 'Could not open a terminal.', tone: 'bad' }); }
    if (alive.current) mark(agent.id);
  }
  const installed = scan?.agents.filter(agent => agent.installed) ?? [];
  const missing = scan?.agents.filter(agent => !agent.installed) ?? [];
  const servers = scan?.servers.filter(server => server.running) ?? [];
  const working = Object.keys(busy).length > 0;
  const agentRow = (agent: AgentRowInfo) => {
    const action = busy[agent.id]; const row = notes[agent.id];
    return <li className="agent-row" key={agent.id}>
      <div className="agent-head"><strong>{agent.name}</strong>{agent.version && <span className="help">{agent.version}</span>}{agent.install && <span className="help">{agent.install.label}</span>}
        {agent.auth === 'signed-in' && <Badge tone="good">Signed in</Badge>}{agent.auth === 'signed-out' && <Badge tone="warn">Not signed in</Badge>}
        {agent.updateAvailable && <Badge tone="info">Update available{agent.latestVersion ? ` → ${agent.latestVersion}` : ''}</Badge>}{agent.linked && <Badge tone="good">Connected</Badge>}</div>
      <div className="agent-actions">
        <button type="button" className="button secondary" disabled={!!action} aria-label={`${agent.linked ? 'Reconnect' : 'Connect'} ${agent.name}`} onClick={() => void connect([agent.id], agent.id)}><Icon name={agent.linked ? 'refresh' : 'plus'} size={14} />{action === 'connect' ? 'Connecting…' : agent.linked ? 'Reconnect' : 'Connect'}</button>
        {agent.update && 'command' in agent.update && <button type="button" className="button secondary" disabled={!!action} aria-label={`Update ${agent.name}`} onClick={() => void update(agent)}><Icon name="download" size={14} />{action === 'update' ? 'Updating…' : 'Update'}</button>}
        {agent.login && agent.auth !== 'signed-in' && <button type="button" className="button secondary" disabled={!!action} aria-label={`Sign in to ${agent.name}`} onClick={() => void signIn(agent)}><Icon name="login" size={14} />Sign in</button>}
      </div>
      {agent.update && 'manual' in agent.update && <p className="help">{agent.update.manual}</p>}
      {agent.missingNpx && <p className="warning-inline" role="note">{agent.name} needs Node.js (npx) to connect. Install Node.js, then press Rescan.</p>}
      {agent.error && <p className="inline-error">{agent.error}</p>}
      {row && <div role="status" className={`agent-note ${row.tone ?? ''}`}>{row.text}{row.output && <details><summary>Output</summary><pre className="agent-output">{row.output}</pre></details>}</div>}
    </li>;
  };
  const serverRow = (server: LocalServerInfo) => <li className="agent-row" key={server.id}>
    <div className="agent-head"><strong>{server.name}</strong><span className="help">{server.endpoint}{server.models.length ? ` · ${server.models.length} model${server.models.length === 1 ? '' : 's'}` : ''}</span>{server.linked && <Badge tone="good">Connected</Badge>}</div>
    {!server.linked && <div className="agent-actions"><button type="button" className="button secondary" disabled={!!busy[server.id]} aria-label={`Connect ${server.name}`} onClick={() => void connect([server.id], server.id)}><Icon name="plus" size={14} />{busy[server.id] ? 'Connecting…' : 'Connect'}</button></div>}
  </li>;
  return <section className="agents-section" aria-labelledby="agents-heading">
    <div className="agents-title"><h3 className="settings-group-title" id="agents-heading">Agents on this computer</h3><div className="agent-actions">
      <button type="button" className="button text" disabled={scanning || working} onClick={() => void refresh()}><Icon name="refresh" size={14} />Rescan</button>
      <button type="button" className="button secondary" disabled={scanning || working} onClick={() => void connect('all', 'all')}>Connect all</button></div></div>
    <p className="help">Your Bot finds agent apps you already have installed. Connecting one adds it as a provider automatically.</p>
    {scanning && <p className="help" role="status">Scanning this computer…</p>}
    {scanError && <p className="inline-error" role="alert">{scanError}</p>}
    {message && <p className="help" role="status">{message}</p>}
    {scan && <><ul className="agent-list" aria-label="Installed agents">{installed.map(agentRow)}{servers.map(serverRow)}</ul>
      {!scanning && installed.length === 0 && servers.length === 0 && <p className="help">No supported agents or running model servers were found.</p>}
      {missing.length > 0 && <details className="agent-missing"><summary>Not installed ({missing.length})</summary><ul>{missing.map(agent => <li key={agent.id}><strong>{agent.name}</strong><code>{agent.installHint}</code><span className="help">{agent.docs}</span></li>)}</ul></details>}</>}
    <p className="help">Prefer the terminal? Run <code>your-bot providers link --all</code>.</p>
  </section>;
}
