import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import type { AgentInfo, AppSettings, BackendTransport, PermissionRequest, ProviderConfig } from '@your-bot/contracts';
import { DesktopStore } from './store';
export interface AppProps { transport: BackendTransport; demo?: boolean; }
type IconName = 'spark' | 'plus' | 'chat' | 'settings' | 'arrow' | 'stop' | 'shield' | 'close' | 'trash' | 'search' | 'refresh' | 'chevron' | 'terminal';
function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    spark: <><path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z" /><path d="m20 2 .7 2.3L23 5l-2.3.7L20 8l-.7-2.3L17 5l2.3-.7Z" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    chat: <path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2v-10a9 9 0 0 1 18 0Z" />,
    settings: <><path d="m9 3-1 3-3 1-2 4 2 2v3l4 3 3-1 3 1 4-3v-3l2-2-2-4-3-1-1-3Z" /><circle cx="11.5" cy="11" r="3" /></>,
    arrow: <path d="M12 19V5m-6 6 6-6 6 6" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" /><path d="m8 12 3 3 5-6" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    trash: <><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" /></>,
    search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></>,
    refresh: <><path d="M20 11a8 8 0 1 0-2 6M20 3v8h-8" /></>,
    chevron: <path d="m9 5 7 7-7 7" />,
    terminal: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3m6 0h4" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.querySelector<HTMLElement>('button, input, select, textarea, [tabindex="0"]')?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current?.(); }
      if (event.key === 'Tab' && dialog) {
        const elements = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')];
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => { document.removeEventListener('keydown', handler); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}><div className="modal-heading"><h2>{title}</h2>{onClose && <button className="icon-button" aria-label="Close dialog" onClick={onClose}><Icon name="close" /></button>}</div>{children}</div></div>;
}
function PermissionDialog({ request, sessionTitle, store }: { request: PermissionRequest; sessionTitle: string; store: DesktopStore }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  async function decide(outcome: 'allow' | 'deny', scope: 'once' | 'task') {
    setSending(true); setError(undefined);
    const result = await store.command({ type: 'permission.decide', decision: { requestId: request.id, outcome, scope } });
    if (!result?.ok) setError(result && !result.ok ? result.error.message : 'Could not send your decision. Reconnect and try again.');
    setSending(false);
  }
  return <Modal title="Your permission is needed"><div className="permission-intro"><span className="permission-icon"><Icon name="shield" size={25} /></span><div><strong>{request.capability}</strong><p>{sessionTitle}</p></div></div><p className="reason">{request.reason}</p>
    {request.paths?.length ? <div className="scope-list"><h3>Exact file access</h3>{request.paths.map((path, index) => <div className="scope" key={index}><span className="tag">{path.access}</span><code>{path.path}</code></div>)}</div> : null}
    {request.packages?.length ? <div className="scope-list"><h3>Packages to install</h3>{request.packages.map((name, index) => <code className="package" key={index}>{name}</code>)}</div> : null}
    <p className="help">Approval applies only to this request’s operation and exact scope. Task approval expires when this task ends.</p>
    {error && <p role="alert" className="inline-error">{error}</p>}
    <div className="permission-actions"><button className="button secondary" disabled={sending} onClick={() => void decide('deny', 'once')}>Deny</button><button className="button secondary" disabled={sending} onClick={() => void decide('allow', 'task')}>Allow for this task</button><button className="button primary" disabled={sending} onClick={() => void decide('allow', 'once')}>Allow once</button></div>
  </Modal>;
}
function SettingsDialog({ settings, store, onClose }: { settings: AppSettings; store: DesktopStore; onClose: () => void }) {
  const [providers, setProviders] = useState<ProviderConfig[]>(() => structuredClone(settings.providers).map(({ apiKey: _secret, ...provider }) => provider));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const patch = (id: string, values: Partial<ProviderConfig>) => setProviders(current => current.map(provider => provider.id === id ? { ...provider, ...values } : provider));
  async function save(event: FormEvent) {
    event.preventDefault(); setError(undefined);
    for (const provider of providers) {
      if (!provider.name.trim()) { setError('Give each provider a name.'); return; }
      if (provider.kind !== 'acp' && provider.enabled) {
        try { const url = new URL(provider.endpoint ?? ''); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(); }
        catch { setError(`Enter an HTTP or HTTPS endpoint without embedded credentials for ${provider.name}.`); return; }
      }
    }
    setSaving(true);
    const result = await store.command({ type: 'settings.update', settings: { providers } });
    if (result?.ok) { await store.command({ type: 'models.refresh' }); onClose(); }
    else setError(result && !result.ok ? result.error.message : 'Could not save settings. Reconnect and try again.');
    setSaving(false);
  }
  return <Modal title="Provider settings" onClose={onClose}><p className="help">Connect your local models or an OpenAI-compatible endpoint. Requests run through your backend.</p>
    <form onSubmit={event => void save(event)}><div className="provider-list">{providers.map((provider, index) => <fieldset className="provider" key={provider.id} disabled={saving}><legend>Provider {index + 1}</legend><div className="provider-top"><label>Name<input value={provider.name} onChange={e => patch(provider.id, { name: e.target.value })} /></label><label className="toggle"><input type="checkbox" checked={provider.enabled} onChange={e => patch(provider.id, { enabled: e.target.checked })} />Enabled</label><button type="button" className="icon-button" aria-label={`Remove ${provider.name}`} onClick={() => setProviders(current => current.filter(p => p.id !== provider.id))}><Icon name="trash" /></button></div>
      <div className="provider-grid"><label>Provider type<select value={provider.kind} disabled={provider.kind === 'acp'} onChange={e => patch(provider.id, { kind: e.target.value as ProviderConfig['kind'] })}>{provider.kind === 'acp' && <option value="acp">ACP agent</option>}<option value="lmstudio">LM Studio</option><option value="llamacpp">llama.cpp</option><option value="openai-compatible">OpenAI compatible</option></select></label><label>Model ID (optional)<input value={provider.modelId ?? ''} placeholder="Discovered automatically" onChange={e => patch(provider.id, { modelId: e.target.value || undefined })} /></label></div>
      {provider.kind === 'acp' ? <p className="help">ACP launch is configured by the host and requires enforced process containment.</p> : <label>Endpoint<input type="url" placeholder="http://127.0.0.1:1234/v1" value={provider.endpoint ?? ''} onChange={e => patch(provider.id, { endpoint: e.target.value })} /></label>}
    </fieldset>)}</div>
    <button type="button" className="button text" disabled={saving || providers.length >= 64} onClick={() => setProviders(current => [...current, { id: crypto.randomUUID(), name: 'Local provider', kind: 'openai-compatible', endpoint: 'http://127.0.0.1:8080/v1', enabled: true }])}><Icon name="plus" />Add provider</button>
    <p className="help">Credentials remain in the host’s local store and are never shown here. Configure API keys through the host integration.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="button secondary" disabled={saving} onClick={onClose}>Cancel</button><button className="button primary" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button></div>
    </form></Modal>;
}
function MessageContent({ content }: { content: string }) {
  const pieces = content.split(/(```[\s\S]*?```)/g);
  return <div className="message-content">{pieces.map((piece, index) => piece.startsWith('```') ? <pre key={index}><code>{piece.slice(3, -3).replace(/^[\w+-]*\n/, '')}</code></pre> : <span key={index}>{piece}</span>)}</div>;
}
const suggestions = [{ title: 'Think something through', text: 'Help me turn a rough idea into a clear plan.', icon: 'spark' as const }, { title: 'Explore my workspace', text: 'Read my workspace overview and help me find a useful next step.', icon: 'terminal' as const }, { title: 'Make a first draft', text: 'Help me draft a concise project update.', icon: 'chat' as const }];
export function App({ transport, demo = false }: AppProps) {
  const store = useMemo(() => new DesktopStore(transport), [transport]);
  const state = useSyncExternalStore(store.subscribe, store.getState);
  useEffect(() => store.start(), [store]);
  const { snapshot, selectedSessionId, connection } = state;
  const selected = snapshot.sessions.find(s => s.id === selectedSessionId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string>();
  const [search, setSearch] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [newAgentId, setNewAgentId] = useState('');
  const draftKey = selectedSessionId ?? 'new';
  const draft = drafts[draftKey] ?? '';
  const setDraft = (value: string) => setDrafts(current => ({ ...current, [draftKey]: value }));
  const availableAgents = snapshot.agents.filter(a => a.available);
  const agent = snapshot.agents.find(a => a.id === selected?.agentId) ?? snapshot.agents.find(a => a.id === newAgentId && a.available) ?? availableAgents[0];
  const tasks = Object.values(state.tasks).filter(task => task.sessionId === selectedSessionId);
  const activeTasks = snapshot.activeTasks.filter(task => task.sessionId === selectedSessionId);
  const busy = activeTasks.length > 0;
  const ready = connection === 'connected';
  const permission = snapshot.pendingPermissions[0];
  const modalOpen = Boolean(permission || settingsOpen || deleteId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { follow.current = true; }, [selectedSessionId]);
  useEffect(() => { if (follow.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [selected?.messages.length, tasks.map(task => task.text).join(''), selectedSessionId]);
  async function createConversation() {
    if (!agent || !ready || sending) return;
    setSending(true);
    await store.command({ type: 'session.create', agentId: agent.id, modelId: agent.models[0]?.id });
    setSending(false); inputRef.current?.focus();
  }
  async function send() {
    if (!draft.trim() || !ready || busy || sending || !agent?.available) return;
    setSending(true);
    let id = selectedSessionId;
    if (!id) { const created = await store.command({ type: 'session.create', agentId: agent.id, modelId: agent.models[0]?.id }); if (created?.ok) id = created.sessionId; }
    if (id) {
      const result = await store.command({ type: 'message.send', sessionId: id, content: draft.trim() });
      if (result?.ok) setDrafts(current => ({ ...current, [draftKey]: '', [id!]: '' }));
    }
    setSending(false); inputRef.current?.focus();
  }
  async function changeAgent(next: AgentInfo, modelId = next.models[0]?.id) {
    if (selected) await store.command({ type: 'session.selectAgent', sessionId: selected.id, agentId: next.id, modelId });
    else setNewAgentId(next.id);
  }
  return <>
    <div className="app-shell" inert={modalOpen}>
      <aside className="sidebar"><a className="brand" href="#" onClick={e => e.preventDefault()} aria-label="Your Bot"><span className="brand-icon"><Icon name="spark" size={24} /></span><span>Your Bot<span className="brand-caption">A little help. All yours.</span></span></a>
        <button className="new-chat" disabled={!ready || !agent || sending} onClick={() => void createConversation()}><Icon name="plus" />New conversation<span className="shortcut">＋</span></button>
        <div className="search"><Icon name="search" size={16} /><input aria-label="Search conversations" placeholder="Find a conversation" value={search} onChange={e => setSearch(e.target.value)} /></div>
        <div className="section-label">YOUR CONVERSATIONS<span>{snapshot.sessions.length.toString().padStart(2, '0')}</span></div>
        <nav className="sessions" aria-label="Conversations">{snapshot.sessions.filter(session => session.title.toLowerCase().includes(search.toLowerCase())).map(session => <div className={`session-row ${session.id === selectedSessionId ? 'selected' : ''}`} key={session.id}><button className="session-link" aria-current={session.id === selectedSessionId ? 'page' : undefined} onClick={() => void store.selectSession(session.id)} disabled={!ready}><Icon name="chat" size={16} /><span>{session.title || 'Untitled conversation'}</span>{snapshot.activeTasks.some(task => task.sessionId === session.id) && <span className="tiny-dot" aria-label="Task running" />}</button><button className="delete-session icon-button" aria-label={`Delete ${session.title}`} disabled={!ready} onClick={() => setDeleteId(session.id)}><Icon name="trash" size={14} /></button></div>)}
          {!snapshot.sessions.length && <p className="sidebar-empty">Your conversations will feel at home here.</p>}{snapshot.sessions.length > 0 && !snapshot.sessions.some(s => s.title.toLowerCase().includes(search.toLowerCase())) && <p className="sidebar-empty">No matching conversations.</p>}
        </nav>
        <div className="sidebar-bottom"><div className="local-card"><Icon name="shield" size={20} /><div><strong>Local by design</strong><span>You choose what to share.</span></div></div><button className="settings-link" disabled={!ready} onClick={() => setSettingsOpen(true)}><Icon name="settings" />Settings<Icon name="chevron" size={14} /></button><div className="connection"><span className={`connection-dot ${connection}`} /><span>{connection === 'connected' ? demo ? 'Browser demo' : 'Backend connected' : connection === 'loading' ? 'Connecting…' : 'Backend disconnected'}</span><span className="version">v0.1</span></div></div>
      </aside>
      <main className="main"><header className="topbar"><div className="breadcrumb">Your space<span>/</span><strong>{selected?.title ?? 'New conversation'}</strong></div><span className="privacy-badge"><Icon name="shield" size={14} />{demo ? 'Simulated conversation' : 'Private workspace'}</span></header>
        {demo && <div className="demo-banner">Demo mode<span>Messages and tool activity are simulated. No files or providers are accessed.</span></div>}
        {state.error && <div className="error-banner" role="alert"><span>{state.error}</span><button onClick={() => store.reconnect()}><Icon name="refresh" size={14} />Reconnect</button><button className="icon-button" onClick={store.clearError} aria-label="Dismiss error"><Icon name="close" size={16} /></button></div>}
        {connection === 'loading' && <div className="loading-banner" role="status"><span className="spinner" />Connecting to your workspace…</div>}
        {connection === 'disconnected' && !state.error && <div className="error-banner" role="alert">Your backend is disconnected.<button onClick={store.reconnect}>Reconnect</button></div>}
        <div className="conversation" ref={scrollRef} onScroll={() => { const el = scrollRef.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
          <div className="conversation-inner">
          {!selected?.messages.length && <section className="welcome"><div className="welcome-symbol"><Icon name="spark" size={38} /></div><span className="eyebrow">ROOM FOR YOUR NEXT IDEA</span><h1>Where shall we begin?</h1><p>A thoughtful partner for your everyday work.<br />Bring a question, an idea, or a blank page.</p><div className="suggestions">{suggestions.map(s => <button key={s.title} disabled={!ready} onClick={() => { setDraft(s.text); inputRef.current?.focus(); }}><Icon name={s.icon} size={21} /><span>{s.title}</span><Icon name="chevron" size={15} /></button>)}</div></section>}
          {!!selected?.messages.length && <div className="conversation-date">YOUR CONVERSATION<span /></div>}
          {selected?.messages.map(message => <article className={`message ${message.role}`} key={message.id}><div className={`avatar ${message.role}`}>{message.role === 'assistant' ? <Icon name="spark" size={19} /> : message.role === 'tool' ? <Icon name="terminal" size={17} /> : 'Y'}</div><div className="message-body"><div className="message-meta"><strong>{message.role === 'assistant' ? 'Your Bot' : message.role === 'tool' ? 'Tool activity' : 'You'}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><MessageContent content={message.content} /></div></article>)}
          {tasks.filter(task => task.text).map(task => <article className="message assistant" key={task.id}><div className="avatar assistant"><Icon name="spark" size={19} /></div><div className="message-body"><div className="message-meta"><strong>Your Bot</strong>{task.running && <span className="streaming-label">Writing…</span>}</div><MessageContent content={task.text} />{task.running && <span className="cursor" />}</div></article>)}
          {tasks.slice(-5).map(task => <div className="activity" key={`activity-${task.id}`}><div className="activity-status" role="status">{task.running ? <span className="spinner" /> : <Icon name={task.status === 'Failed' ? 'close' : 'spark'} size={14} />}<span>{task.status}</span>{task.running && <button className="stop-link" onClick={() => void store.command({ type: 'task.cancel', taskId: task.id })}>Stop task</button>}</div>{task.output.length > 0 && <details><summary><Icon name="terminal" size={14} />Tool activity · {task.output.length} updates</summary><div className="tool-output">{task.output.map((output, index) => <div className={`output-line ${output.stream}`} key={index}><span>{output.stream}</span><pre>{output.text}</pre></div>)}</div></details>}</div>)}
          </div>
        </div>
        <div className="composer-area"><div className="composer-inner"><div className="agent-bar"><div className="agent-select"><span className="agent-dot" /><select aria-label="Agent" value={agent?.id ?? ''} disabled={!ready || busy || sending} onChange={e => { const next = snapshot.agents.find(a => a.id === e.target.value); if (next) void changeAgent(next); }}>{!agent && <option value="">No agents available</option>}{snapshot.agents.map(a => <option key={a.id} value={a.id} disabled={!a.available}>{a.name}{!a.available ? ' · unavailable' : ''}</option>)}</select></div><span className="agent-divider" /><select className="model-select" aria-label="Model" value={selected?.modelId ?? agent?.models[0]?.id ?? ''} disabled={!ready || busy || sending || !selected || !agent} onChange={e => { if (agent) void changeAgent(agent, e.target.value); }}>{!agent?.models.length && <option value="">Default model</option>}{agent?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select><button className="icon-button refresh-models" aria-label="Refresh models" disabled={!ready || state.pendingCommands > 0} onClick={() => void store.command({ type: 'models.refresh', agentId: agent?.id })}><Icon name="refresh" size={15} /></button></div>
          {agent?.limitation && <p className="agent-limitation">{agent.limitation}</p>}
          {ready && !availableAgents.length && <p className="agent-limitation">No agents are available. Configure a provider in Settings, then refresh models.</p>}
          <form className={`composer ${busy ? 'working' : ''}`} onSubmit={e => { e.preventDefault(); void send(); }}><textarea aria-label="Message" ref={inputRef} rows={2} maxLength={262144} placeholder={ready ? 'Ask anything, or think out loud…' : 'Connect your backend to start a conversation…'} value={draft} disabled={!ready || sending || !agent?.available} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} /><div className="composer-footer"><span><Icon name="shield" size={13} />Permission before action</span>{busy ? <button type="button" className="send-button stop" aria-label="Stop response" onClick={() => activeTasks.forEach(task => void store.command({ type: 'task.cancel', taskId: task.id }))}><Icon name="stop" size={17} /></button> : <button className="send-button" aria-label="Send message" disabled={!draft.trim() || !ready || sending || !agent?.available}>{sending ? <span className="spinner" /> : <Icon name="arrow" size={19} />}</button>}</div></form>
          <p className="composer-note">{demo ? 'An interactive preview of your local assistant.' : 'Your Bot can make mistakes. Review important results.'}<span>Enter to send · Shift + Enter for a new line</span></p>
        </div></div>
      </main>
    </div>
    {permission ? <PermissionDialog key={permission.id} request={permission} sessionTitle={snapshot.sessions.find(s => s.id === permission.sessionId)?.title ?? permission.sessionId} store={store} /> : settingsOpen ? <SettingsDialog settings={snapshot.settings} store={store} onClose={() => setSettingsOpen(false)} /> : deleteId ? <Modal title="Delete conversation?" onClose={() => setDeleteId(undefined)}><p>This removes “{snapshot.sessions.find(s => s.id === deleteId)?.title}” and its message history. Any running task will be cancelled.</p><div className="modal-actions"><button className="button secondary" onClick={() => setDeleteId(undefined)}>Keep conversation</button><button className="button danger" onClick={async () => { const result = await store.command({ type: 'session.delete', sessionId: deleteId }); if (result?.ok) setDeleteId(undefined); }}>Delete conversation</button></div></Modal> : null}
  </>;
}
