import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AgentInfo, Bot, SessionV2 } from '@your-bot/contracts';
import { DesktopStore, type DesktopTransport } from './store';
import { Badge, Icon, Modal, type IconName } from './ui';
import { ApprovalDialog } from './ApprovalDialog';
import { SettingsDialog } from './SettingsDialog';
import { BotsView } from './BotsView';
import { PermissionsView } from './PermissionsView';
import { RoutinesView } from './RoutinesView';
import { NotificationsView } from './NotificationsView';
import { DevicesView } from './DevicesView';
export interface AppProps { transport: DesktopTransport; demo?: boolean; }
type View = 'chat' | 'bots' | 'routines' | 'permissions' | 'notifications' | 'devices';
const VIEW_TITLES: Record<Exclude<View, 'chat'>, string> = { bots: 'Bots', routines: 'Routines', permissions: 'Permissions', notifications: 'Notifications', devices: 'Devices' };
const NAV: { view: Exclude<View, 'chat'>; icon: IconName }[] = [{ view: 'bots', icon: 'bot' }, { view: 'routines', icon: 'clock' }, { view: 'permissions', icon: 'key' }, { view: 'notifications', icon: 'bell' }, { view: 'devices', icon: 'device' }];
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
  const selected: SessionV2 | undefined = snapshot.sessions.find(s => s.id === selectedSessionId);
  const [view, setView] = useState<View>('chat');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string>();
  const [search, setSearch] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [newAgentId, setNewAgentId] = useState('');
  const [focusedRequest, setFocusedRequest] = useState<string>();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const draftKey = selectedSessionId ?? 'new';
  const draft = drafts[draftKey] ?? '';
  const setDraft = (value: string) => setDrafts(current => ({ ...current, [draftKey]: value }));
  const availableAgents = snapshot.agents.filter(a => a.available);
  const agent = snapshot.agents.find(a => a.id === selected?.agentId) ?? snapshot.agents.find(a => a.id === newAgentId && a.available) ?? availableAgents[0];
  const tasks = Object.values(state.tasks).filter(task => task.sessionId === selectedSessionId);
  const activeTasks = snapshot.activeTasks.filter(task => task.sessionId === selectedSessionId);
  const busy = activeTasks.length > 0;
  const ready = connection === 'connected';
  const pending = snapshot.pendingPermissions;
  const permission = pending.find(request => request.id === focusedRequest) ?? pending.find(request => !dismissed.has(request.id));
  const modalOpen = Boolean(permission || settingsOpen || deleteId);
  const unread = snapshot.notifications.filter(n => !n.acknowledgedAt).length;
  const selectedBot: Bot | undefined = snapshot.bots.find(bot => bot.id === selected?.botId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { follow.current = true; }, [selectedSessionId]);
  useEffect(() => { if (follow.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [selected?.messages.length, tasks.map(task => task.text).join(''), selectedSessionId]);
  const review = (requestId: string) => { setDismissed(current => { const next = new Set(current); next.delete(requestId); return next; }); setFocusedRequest(requestId); };
  const dismiss = (requestId: string) => { setFocusedRequest(undefined); setDismissed(current => new Set(current).add(requestId)); };
  /** Sessions belong to a bot: prefer the current bot (or one that uses the chosen agent); without bots fall back to v1 session.create. */
  async function newSession(): Promise<string | undefined> {
    const bot = selectedBot ?? snapshot.bots.find(candidate => candidate.agentId === agent?.id) ?? snapshot.bots[0];
    const result = bot ? await store.command({ type: 'bot.session.create', botId: bot.id })
      : agent ? await store.command({ type: 'session.create', agentId: agent.id, modelId: agent.models[0]?.id }) : undefined;
    return result?.ok ? result.sessionId : undefined;
  }
  async function createConversation() {
    if (!ready || sending || (!agent && !snapshot.bots.length)) return;
    setSending(true); setView('chat');
    await newSession();
    setSending(false); inputRef.current?.focus();
  }
  async function createBotSession(bot: Bot) {
    if (!ready || sending) return;
    setSending(true); setView('chat');
    await store.command({ type: 'bot.session.create', botId: bot.id });
    setSending(false); inputRef.current?.focus();
  }
  async function send() {
    if (!draft.trim() || !ready || busy || sending || !agent?.available) return;
    setSending(true);
    let id = selectedSessionId;
    if (!id) id = await newSession();
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
  function openSession(id?: string) {
    setView('chat');
    if (id) void store.selectSession(id);
  }
  const matches = (session: SessionV2) => session.title.toLowerCase().includes(search.toLowerCase());
  const sessionRow = (session: SessionV2) => <div className={`session-row ${session.id === selectedSessionId && view === 'chat' ? 'selected' : ''}`} key={session.id}><button className="session-link" aria-current={session.id === selectedSessionId ? 'page' : undefined} onClick={() => { setView('chat'); void store.selectSession(session.id); }} disabled={!ready}><Icon name="chat" size={16} /><span>{session.title || 'Untitled conversation'}</span>{snapshot.activeTasks.some(task => task.sessionId === session.id) && <span className="tiny-dot" aria-label="Task running" />}</button><button className="delete-session icon-button" aria-label={`Delete ${session.title}`} disabled={!ready} onClick={() => setDeleteId(session.id)}><Icon name="trash" size={14} /></button></div>;
  const botIds = new Set(snapshot.bots.map(bot => bot.id));
  const ungrouped = snapshot.sessions.filter(session => !session.botId || !botIds.has(session.botId));
  const breadcrumb = view === 'chat' ? <>{selectedBot ? <><span className="crumb-bot">{selectedBot.name}</span><span>/</span></> : null}<strong>{selected?.title ?? 'New conversation'}</strong></> : <strong>{VIEW_TITLES[view]}</strong>;
  const badges: Record<Exclude<View, 'chat'>, number> = { bots: 0, routines: 0, permissions: pending.length, notifications: unread, devices: 0 };
  return <>
    <div className="app-shell" inert={modalOpen}>
      <aside className="sidebar"><a className="brand" href="#" onClick={e => { e.preventDefault(); setView('chat'); }} aria-label="Your Bot"><span className="brand-icon"><Icon name="spark" size={24} /></span><span>Your Bot<span className="brand-caption">A little help. All yours.</span></span></a>
        <button className="new-chat" disabled={!ready || (!agent && !snapshot.bots.length) || sending} onClick={() => void createConversation()}><Icon name="plus" />New conversation<span className="shortcut">＋</span></button>
        <nav className="nav-links" aria-label="Sections">{NAV.map(item => <button key={item.view} className={`nav-link ${view === item.view ? 'active' : ''}`} aria-current={view === item.view ? 'page' : undefined} onClick={() => setView(item.view)}><Icon name={item.icon} size={16} /><span>{VIEW_TITLES[item.view]}</span>{badges[item.view] > 0 && <span className="nav-badge" aria-label={`${badges[item.view]} waiting`}>{badges[item.view]}</span>}</button>)}</nav>
        <div className="search"><Icon name="search" size={16} /><input aria-label="Search conversations" placeholder="Find a conversation" value={search} onChange={e => setSearch(e.target.value)} /></div>
        <div className="section-label">YOUR CONVERSATIONS<span>{snapshot.sessions.length.toString().padStart(2, '0')}</span></div>
        <nav className="sessions" aria-label="Conversations">{snapshot.bots.map(bot => {
          const sessions = snapshot.sessions.filter(session => session.botId === bot.id && matches(session));
          if (search && !sessions.length) return null;
          return <div className="bot-group" key={bot.id} role="group" aria-label={`Bot ${bot.name}`}><div className="bot-group-head"><Icon name="bot" size={13} /><span className="bot-group-name">{bot.name}</span>{bot.profile === 'trusted' && <Badge tone="warn">trusted</Badge>}<button className="icon-button" aria-label={`New session in ${bot.name}`} disabled={!ready || sending} onClick={() => void createBotSession(bot)}><Icon name="plus" size={14} /></button></div>{sessions.map(sessionRow)}</div>;
        })}
          {ungrouped.some(matches) && <div className="bot-group" role="group" aria-label="Other conversations">{snapshot.bots.length > 0 && <div className="bot-group-head"><span className="bot-group-name">Other</span></div>}{ungrouped.filter(matches).map(sessionRow)}</div>}
          {!snapshot.sessions.length && <p className="sidebar-empty">Your conversations will feel at home here.</p>}{snapshot.sessions.length > 0 && !snapshot.sessions.some(matches) && <p className="sidebar-empty">No matching conversations.</p>}
        </nav>
        <div className="sidebar-bottom"><div className="local-card"><Icon name="shield" size={20} /><div><strong>Local by design</strong><span>You choose what to share.</span></div></div><button className="settings-link" disabled={!ready} onClick={() => setSettingsOpen(true)}><Icon name="settings" />Settings<Icon name="chevron" size={14} /></button><div className="connection"><span className={`connection-dot ${connection}`} /><span>{connection === 'connected' ? demo ? 'Browser demo' : 'Backend connected' : connection === 'loading' ? 'Connecting…' : 'Backend disconnected'}</span><span className="version">v{__APP_VERSION__}</span></div></div>
      </aside>
      <main className="main"><header className="topbar"><div className="breadcrumb">Your space<span>/</span>{breadcrumb}</div><span className="privacy-badge"><Icon name="shield" size={14} />{demo ? 'Simulated conversation' : snapshot.host.name || 'Private workspace'}</span></header>
        {demo && <div className="demo-banner">Demo mode<span>Everything here is simulated: bots, approvals, grants, routines, devices and replies. No files, providers, processes or devices are touched.</span></div>}
        {state.error && <div className="error-banner" role="alert"><span>{state.error}</span><button onClick={() => store.reconnect()}><Icon name="refresh" size={14} />Reconnect</button><button className="icon-button" onClick={store.clearError} aria-label="Dismiss error"><Icon name="close" size={16} /></button></div>}
        {connection === 'loading' && <div className="loading-banner" role="status"><span className="spinner" />Connecting to your workspace…</div>}
        {connection === 'disconnected' && !state.error && <div className="error-banner" role="alert">Your backend is disconnected.<button onClick={store.reconnect}>Reconnect</button></div>}
        {view === 'bots' && <div className="view-scroll"><BotsView state={state} store={store} onOpenSession={openSession} /></div>}
        {view === 'routines' && <div className="view-scroll"><RoutinesView state={state} store={store} onReview={review} onOpenSession={openSession} /></div>}
        {view === 'permissions' && <div className="view-scroll"><PermissionsView state={state} store={store} onReview={review} /></div>}
        {view === 'notifications' && <div className="view-scroll"><NotificationsView state={state} store={store} onReview={review} onOpenRoutines={() => setView('routines')} /></div>}
        {view === 'devices' && <div className="view-scroll"><DevicesView state={state} store={store} demo={demo} /></div>}
        {view === 'chat' && <>
        <div className="conversation" ref={scrollRef} onScroll={() => { const el = scrollRef.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
          <div className="conversation-inner">
          {!selected?.messages.length && <section className="welcome"><div className="welcome-symbol"><Icon name="spark" size={38} /></div><span className="eyebrow">ROOM FOR YOUR NEXT IDEA</span><h1>Where shall we begin?</h1><p>A thoughtful partner for your everyday work.<br />Bring a question, an idea, or a blank page.</p><div className="suggestions">{suggestions.map(s => <button key={s.title} disabled={!ready} onClick={() => { setDraft(s.text); inputRef.current?.focus(); }}><Icon name={s.icon} size={21} /><span>{s.title}</span><Icon name="chevron" size={15} /></button>)}</div></section>}
          {!!selected?.summary && <div className="summary-note" role="note"><strong>Earlier in this conversation</strong><p>{selected.summary}</p></div>}
          {!!selected?.messages.length && <div className="conversation-date">YOUR CONVERSATION<span /></div>}
          {selected?.messages.map(message => <article className={`message ${message.role}`} key={message.id}><div className={`avatar ${message.role}`}>{message.role === 'assistant' ? <Icon name="spark" size={19} /> : message.role === 'tool' ? <Icon name="terminal" size={17} /> : 'Y'}</div><div className="message-body"><div className="message-meta"><strong>{message.role === 'assistant' ? selectedBot?.name ?? 'Your Bot' : message.role === 'tool' ? 'Tool activity' : 'You'}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><MessageContent content={message.content} /></div></article>)}
          {tasks.filter(task => task.text).map(task => <article className="message assistant" key={task.id}><div className="avatar assistant"><Icon name="spark" size={19} /></div><div className="message-body"><div className="message-meta"><strong>{selectedBot?.name ?? 'Your Bot'}</strong>{task.running && <span className="streaming-label">Writing…</span>}</div><MessageContent content={task.text} />{task.running && <span className="cursor" />}</div></article>)}
          {tasks.slice(-5).map(task => <div className="activity" key={`activity-${task.id}`}><div className="activity-status" role="status">{task.running ? <span className="spinner" /> : <Icon name={task.status === 'Failed' ? 'close' : 'spark'} size={14} />}<span>{task.status}</span>{task.running && <button className="stop-link" onClick={() => void store.command({ type: 'task.cancel', taskId: task.id })}>Stop task</button>}</div>{task.output.length > 0 && <details><summary><Icon name="terminal" size={14} />Tool activity · {task.output.length} updates</summary><div className="tool-output">{task.output.map((output, index) => <div className={`output-line ${output.stream}`} key={index}><span>{output.stream}</span><pre>{output.text}</pre></div>)}</div></details>}</div>)}
          </div>
        </div>
        <div className="composer-area"><div className="composer-inner"><div className="agent-bar"><div className="agent-select"><span className="agent-dot" /><select aria-label="Agent" value={agent?.id ?? ''} disabled={!ready || busy || sending} onChange={e => { const next = snapshot.agents.find(a => a.id === e.target.value); if (next) void changeAgent(next); }}>{!agent && <option value="">No agents available</option>}{snapshot.agents.map(a => <option key={a.id} value={a.id} disabled={!a.available}>{a.name}{!a.available ? ' · unavailable' : ''}</option>)}</select></div><span className="agent-divider" /><select className="model-select" aria-label="Model" value={selected?.modelId ?? agent?.models[0]?.id ?? ''} disabled={!ready || busy || sending || !selected || !agent} onChange={e => { if (agent) void changeAgent(agent, e.target.value); }}>{!agent?.models.length && <option value="">Default model</option>}{agent?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select>{selectedBot?.profile === 'trusted' && <Badge tone="warn">trusted</Badge>}<button className="icon-button refresh-models" aria-label="Refresh models" disabled={!ready || state.pendingCommands > 0} onClick={() => void store.command({ type: 'models.refresh', agentId: agent?.id })}><Icon name="refresh" size={15} /></button></div>
          {agent?.limitation && <p className="agent-limitation">{agent.limitation}</p>}
          {ready && !availableAgents.length && <p className="agent-limitation">No agents are available. Configure a provider in Settings, then refresh models.</p>}
          <form className={`composer ${busy ? 'working' : ''}`} onSubmit={e => { e.preventDefault(); void send(); }}><textarea aria-label="Message" ref={inputRef} rows={2} maxLength={262144} placeholder={ready ? 'Ask anything, or think out loud…' : 'Connect your backend to start a conversation…'} value={draft} disabled={!ready || sending || !agent?.available} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} /><div className="composer-footer"><span><Icon name="shield" size={13} />Permission before action</span>{busy ? <button type="button" className="send-button stop" aria-label="Stop response" onClick={() => activeTasks.forEach(task => void store.command({ type: 'task.cancel', taskId: task.id }))}><Icon name="stop" size={17} /></button> : <button className="send-button" aria-label="Send message" disabled={!draft.trim() || !ready || sending || !agent?.available}>{sending ? <span className="spinner" /> : <Icon name="arrow" size={19} />}</button>}</div></form>
          <p className="composer-note">{demo ? 'An interactive preview of your local assistant.' : 'Your Bot can make mistakes. Review important results.'}<span>Enter to send · Shift + Enter for a new line</span></p>
        </div></div></>}
      </main>
    </div>
    {permission ? <ApprovalDialog key={permission.id} request={permission} bot={snapshot.bots.find(bot => bot.id === permission.botId)} sessionTitle={snapshot.sessions.find(s => s.id === permission.sessionId)?.title ?? permission.sessionId}
        run={snapshot.routineRuns.find(run => run.id === permission.routineRunId)} routine={snapshot.routines.find(routine => routine.id === snapshot.routineRuns.find(run => run.id === permission.routineRunId)?.routineId)} store={store} onClose={() => dismiss(permission.id)} />
      : settingsOpen ? <SettingsDialog settings={snapshot.settings} store={store} onClose={() => setSettingsOpen(false)} /> : deleteId ? <Modal title="Delete conversation?" onClose={() => setDeleteId(undefined)}><p>This removes “{snapshot.sessions.find(s => s.id === deleteId)?.title}” and its message history. Any running task will be cancelled.</p><div className="modal-actions"><button className="button secondary" onClick={() => setDeleteId(undefined)}>Keep conversation</button><button className="button danger" onClick={async () => { const result = await store.command({ type: 'session.delete', sessionId: deleteId }); if (result?.ok) setDeleteId(undefined); }}>Delete conversation</button></div></Modal> : null}
  </>;
}
