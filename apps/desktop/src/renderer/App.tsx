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
import { BotAvatar } from './avatar';
import { useAppearance } from './appearance';
import { SeasonArt } from './SeasonArt';
import { describeSchedule, requestSubject, shortTime } from './format';
export interface AppProps { transport: DesktopTransport; demo?: boolean; }
type View = 'chat' | 'bots' | 'routines' | 'permissions' | 'notifications' | 'devices';
const VIEW_TITLES: Record<Exclude<View, 'chat'>, string> = { bots: 'Bots', routines: 'Routines', permissions: 'Permissions', notifications: 'Notifications', devices: 'Devices' };
const NAV: { view: Exclude<View, 'chat'>; icon: IconName }[] = [{ view: 'bots', icon: 'bot' }, { view: 'routines', icon: 'clock' }, { view: 'permissions', icon: 'key' }, { view: 'notifications', icon: 'bell' }, { view: 'devices', icon: 'device' }];
function MessageContent({ content }: { content: string }) {
  const pieces = content.split(/(```[\s\S]*?```)/g);
  return <div className="message-content">{pieces.map((piece, index) => piece.startsWith('```') ? <pre key={index}><code>{piece.slice(3, -3).replace(/^[\w+-]*\n/, '')}</code></pre> : <span key={index}>{piece}</span>)}</div>;
}
const suggestions = [{ title: 'Think something through', text: 'Help me turn a rough idea into a clear plan.', icon: 'spark' as const }, { title: 'Explore my workspace', text: 'Read my workspace overview and help me find a useful next step.', icon: 'terminal' as const }, { title: 'Make a first draft', text: 'Help me draft a concise project update.', icon: 'chat' as const }];
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const oneLine = (text: string) => text.replace(/```[\s\S]*?```/g, '[code]').replace(/\s+/g, ' ').trim();
export function App({ transport, demo = false }: AppProps) {
  const store = useMemo(() => new DesktopStore(transport), [transport]);
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const appearance = useAppearance(transport);
  useEffect(() => store.start(), [store]);
  const { snapshot, selectedSessionId, connection } = state;
  const selected: SessionV2 | undefined = snapshot.sessions.find(s => s.id === selectedSessionId);
  const [view, setView] = useState<View>('chat');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(true);
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
  const assistantName = selectedBot?.name ?? 'Your Bot';
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
  /** Opening a bot from the roster continues its most recent conversation, or starts its first one. */
  function openBot(bot: Bot, sessions: SessionV2[]) {
    const latest = sessions[0];
    if (latest) openSession(latest.id); else void createBotSession(bot);
  }
  const matches = (session: SessionV2) => session.title.toLowerCase().includes(search.toLowerCase());
  const byRecent = (a: SessionV2, b: SessionV2) => b.updatedAt.localeCompare(a.updatedAt);
  const sessionRow = (session: SessionV2) => <div className={`session-row ${session.id === selectedSessionId && view === 'chat' ? 'selected' : ''}`} key={session.id}><button className="session-link" aria-current={session.id === selectedSessionId ? 'page' : undefined} onClick={() => openSession(session.id)} disabled={!ready}><span className="session-title">{session.title || 'Untitled conversation'}</span>{snapshot.activeTasks.some(task => task.sessionId === session.id) && <span className="tiny-dot" aria-label="Task running" />}</button><button className="delete-session icon-button" aria-label={`Delete ${session.title}`} disabled={!ready} onClick={() => setDeleteId(session.id)}><Icon name="trash" size={14} /></button></div>;
  const botIds = new Set(snapshot.bots.map(bot => bot.id));
  const ungrouped = snapshot.sessions.filter(session => !session.botId || !botIds.has(session.botId));
  const badges: Record<Exclude<View, 'chat'>, number> = { bots: 0, routines: 0, permissions: pending.length, notifications: unread, devices: 0 };
  const botRoutines = selectedBot ? snapshot.routines.filter(routine => routine.botId === selectedBot.id) : [];
  const botApprovals = selectedBot ? pending.filter(request => request.botId === selectedBot.id) : pending.filter(request => request.sessionId === selectedSessionId);
  const showDetails = view === 'chat' && detailsOpen && Boolean(selected);
  const headerTitle = view === 'chat'
    ? <>{selectedBot ? <BotAvatar id={selectedBot.id} name={selectedBot.name} size="sm" /> : <span className="app-mark small"><Icon name="spark" size={14} /></span>}<strong>{selectedBot?.name ?? (selected ? 'Conversation' : 'New conversation')}</strong>{selected && <span className="header-sub">{selected.title || 'Untitled conversation'}</span>}</>
    : <strong>{VIEW_TITLES[view]}</strong>;
  return <>
    <div className="app-shell" inert={modalOpen}>
      <aside className="sidebar">
        <div className="sidebar-top"><a className="brand" href="#" onClick={e => { e.preventDefault(); setView('chat'); }} aria-label="Your Bot"><span className="app-mark"><Icon name="spark" size={16} /></span><span className="brand-name">Your Bot</span></a>
          <button className="icon-button round" aria-label="New conversation" title="New conversation" disabled={!ready || (!agent && !snapshot.bots.length) || sending} onClick={() => void createConversation()}><Icon name="plus" size={18} /></button></div>
        <label className="search"><Icon name="search" size={15} /><input aria-label="Search conversations" placeholder="Search" value={search} onChange={e => setSearch(e.target.value)} /></label>
        <nav className="roster" aria-label="Conversations">{snapshot.bots.map(bot => {
          const all = snapshot.sessions.filter(session => session.botId === bot.id).sort(byRecent);
          const sessions = all.filter(matches);
          if (search && !sessions.length && !bot.name.toLowerCase().includes(search.toLowerCase())) return null;
          const latest = all[0];
          const last = latest?.messages.at(-1);
          const preview = last ? oneLine(last.content) : all.length ? `${all.length} conversation${all.length === 1 ? '' : 's'}` : 'No conversations yet';
          const active = selectedBot?.id === bot.id && view === 'chat';
          const running = snapshot.activeTasks.some(task => all.some(session => session.id === task.sessionId));
          const waiting = pending.some(request => request.botId === bot.id);
          return <div className={`bot-group ${active ? 'active' : ''}`} key={bot.id} role="group" aria-label={`Bot ${bot.name}`}>
            <div className="bot-row"><button className="bot-open" disabled={!ready} onClick={() => openBot(bot, all)} aria-label={`Open ${bot.name}`}><span className="avatar-wrap"><BotAvatar id={bot.id} name={bot.name} />{(running || waiting) && <span className={`status-pip ${waiting ? 'waiting' : 'working'}`} />}</span>
              <span className="bot-text"><span className="bot-line"><span className="bot-group-name">{bot.name}</span><time>{shortTime(latest?.updatedAt)}</time></span><span className="bot-preview">{bot.profile === 'trusted' && <Badge tone="warn">trusted</Badge>}<span>{waiting ? 'Approval required' : running ? 'Working…' : preview}</span></span></span></button>
              <button className="icon-button" aria-label={`New session in ${bot.name}`} title={`New conversation with ${bot.name}`} disabled={!ready || sending} onClick={() => void createBotSession(bot)}><Icon name="plus" size={14} /></button></div>
            {sessions.length > 0 && <div className="bot-sessions">{sessions.map(sessionRow)}</div>}</div>;
        })}
          {ungrouped.some(matches) && <div className="bot-group" role="group" aria-label="Other conversations">{snapshot.bots.length > 0 && <div className="group-label">Other</div>}<div className="bot-sessions flat">{ungrouped.filter(matches).sort(byRecent).map(sessionRow)}</div></div>}
          {!snapshot.sessions.length && !snapshot.bots.length && <p className="sidebar-empty">No chats yet</p>}{search && snapshot.sessions.length > 0 && !snapshot.sessions.some(matches) && !snapshot.bots.some(bot => bot.name.toLowerCase().includes(search.toLowerCase())) && <p className="sidebar-empty">No matching conversations.</p>}
        </nav>
        <div className="sidebar-bottom">
          <nav className="nav-links" aria-label="Sections">{NAV.map(item => <button key={item.view} className={`nav-link ${view === item.view ? 'active' : ''}`} aria-current={view === item.view ? 'page' : undefined} onClick={() => setView(item.view)}><span className="nav-icon"><Icon name={item.icon} size={15} /></span><span>{VIEW_TITLES[item.view]}</span>{badges[item.view] > 0 && <span className="nav-badge" aria-label={`${badges[item.view]} waiting`}>{badges[item.view]}</span>}</button>)}
            <button className="nav-link" disabled={!ready} onClick={() => setSettingsOpen(true)}><span className="nav-icon"><Icon name="settings" size={15} /></span><span>Settings</span></button></nav>
          <div className="connection"><span className={`connection-dot ${connection}`} /><span>{connection === 'connected' ? demo ? 'Browser demo' : 'Backend connected' : connection === 'loading' ? 'Connecting…' : 'Backend disconnected'}</span><span className="version">v{__APP_VERSION__}</span></div></div>
      </aside>
      <main className="main">{appearance.showArt && <SeasonArt look={appearance.look} />}
        <header className="topbar"><div className="header-title">{headerTitle}</div><div className="header-actions"><span className="privacy-badge"><Icon name="shield" size={13} />{demo ? 'Simulated' : snapshot.host.name || 'Private workspace'}</span>
          {view === 'chat' && selected && <button className="icon-button" aria-label={detailsOpen ? 'Hide details' : 'Show details'} title={detailsOpen ? 'Hide details' : 'Show details'} aria-expanded={detailsOpen} onClick={() => setDetailsOpen(open => !open)}><Icon name={detailsOpen ? 'collapse' : 'expand'} size={17} /></button>}</div></header>
        {demo && <div className="demo-banner"><strong>Demo mode</strong><span>Everything here is simulated: bots, approvals, grants, routines, devices and replies. No files, providers, processes or devices are touched.</span></div>}
        {state.error && <div className="error-banner" role="alert"><span>{state.error}</span><button onClick={() => store.reconnect()}><Icon name="refresh" size={14} />Reconnect</button><button className="icon-button" onClick={store.clearError} aria-label="Dismiss error"><Icon name="close" size={16} /></button></div>}
        {connection === 'loading' && <div className="loading-banner" role="status"><span className="spinner" />Connecting to your workspace…</div>}
        {connection === 'disconnected' && !state.error && <div className="error-banner" role="alert">Your backend is disconnected.<button onClick={store.reconnect}>Reconnect</button></div>}
        {view === 'bots' && <div className="view-scroll"><BotsView state={state} store={store} onOpenSession={openSession} /></div>}
        {view === 'routines' && <div className="view-scroll"><RoutinesView state={state} store={store} onReview={review} onOpenSession={openSession} /></div>}
        {view === 'permissions' && <div className="view-scroll"><PermissionsView state={state} store={store} onReview={review} /></div>}
        {view === 'notifications' && <div className="view-scroll"><NotificationsView state={state} store={store} onReview={review} onOpenRoutines={() => setView('routines')} /></div>}
        {view === 'devices' && <div className="view-scroll"><DevicesView state={state} store={store} demo={demo} /></div>}
        {view === 'chat' && <div className="chat-layout"><div className="chat-column">
        <div className="conversation" role="log" aria-label="Messages" ref={scrollRef} onScroll={() => { const el = scrollRef.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
          <div className="conversation-inner">
          {!selected?.messages.length && <section className="welcome">{selectedBot ? <BotAvatar id={selectedBot.id} name={selectedBot.name} size="xl" /> : <span className="app-mark large"><Icon name="spark" size={30} /></span>}<h1>Where shall we begin?</h1><p>{selectedBot ? `Ask ${selectedBot.name} a question, hand over a task, or think out loud.` : 'Bring a question, an idea, or a blank page.'}</p>
            <div className="suggestions-label">Suggestions</div><div className="suggestions">{suggestions.map(s => <button key={s.title} disabled={!ready} onClick={() => { setDraft(s.text); inputRef.current?.focus(); }}><span className="suggestion-icon"><Icon name={s.icon} size={18} /></span><span className="suggestion-text"><strong>{s.title}</strong><span>{s.text}</span></span></button>)}</div></section>}
          {!!selected?.summary && <div className="summary-note" role="note"><strong>Earlier in this conversation</strong><p>{selected.summary}</p></div>}
          {selected?.messages.map(message => <article className={`message ${message.role}`} key={message.id} aria-label={message.role === 'assistant' ? assistantName : message.role === 'tool' ? 'Tool activity' : 'You'}>{message.role === 'tool' && <div className="message-meta"><Icon name="terminal" size={13} />Tool activity</div>}<div className="bubble"><MessageContent content={message.content} /></div><time className="message-time" dateTime={message.createdAt}>{clock(message.createdAt)}</time></article>)}
          {tasks.filter(task => task.text).map(task => <article className="message assistant" key={task.id} aria-label={assistantName}><div className="bubble"><MessageContent content={task.text} />{task.running && <span className="cursor" />}</div>{task.running && <span className="message-time streaming-label">Writing…</span>}</article>)}
          {tasks.slice(-5).map(task => <div className="activity" key={`activity-${task.id}`}><div className="activity-status" role="status">{task.running ? <span className="spinner" /> : <Icon name={task.status === 'Failed' ? 'close' : 'check'} size={13} />}<span>{task.status}</span>{task.running && <button className="stop-link" onClick={() => void store.command({ type: 'task.cancel', taskId: task.id })}>Stop task</button>}</div>{task.output.length > 0 && <details><summary><Icon name="terminal" size={13} />Tool activity · {task.output.length} updates</summary><div className="tool-output">{task.output.map((output, index) => <div className={`output-line ${output.stream}`} key={index}><span>{output.stream}</span><pre>{output.text}</pre></div>)}</div></details>}</div>)}
          </div>
        </div>
        <div className="composer-area"><div className="composer-inner">
          {agent?.limitation && <p className="agent-limitation">{agent.limitation}</p>}
          {ready && !availableAgents.length && <p className="agent-limitation">No agents are available. Configure a provider in Settings, then refresh models.</p>}
          <form className={`composer ${busy ? 'working' : ''}`} onSubmit={e => { e.preventDefault(); void send(); }}><textarea aria-label="Message" ref={inputRef} rows={1} maxLength={262144} placeholder={ready ? `Message ${assistantName}` : 'Connect your backend to start a conversation…'} value={draft} disabled={!ready || sending || !agent?.available} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
            <div className="composer-footer"><div className="agent-bar"><select aria-label="Agent" value={agent?.id ?? ''} disabled={!ready || busy || sending} onChange={e => { const next = snapshot.agents.find(a => a.id === e.target.value); if (next) void changeAgent(next); }}>{!agent && <option value="">No agents available</option>}{snapshot.agents.map(a => <option key={a.id} value={a.id} disabled={!a.available}>{a.name}{!a.available ? ' · unavailable' : ''}</option>)}</select><select className="model-select" aria-label="Model" value={selected?.modelId ?? agent?.models[0]?.id ?? ''} disabled={!ready || busy || sending || !selected || !agent} onChange={e => { if (agent) void changeAgent(agent, e.target.value); }}>{!agent?.models.length && <option value="">Default model</option>}{agent?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select>{selectedBot?.profile === 'trusted' && <Badge tone="warn">trusted</Badge>}<button type="button" className="icon-button refresh-models" aria-label="Refresh models" disabled={!ready || state.pendingCommands > 0} onClick={() => void store.command({ type: 'models.refresh', agentId: agent?.id })}><Icon name="refresh" size={14} /></button></div>
              {busy ? <button type="button" className="send-button stop" aria-label="Stop response" onClick={() => activeTasks.forEach(task => void store.command({ type: 'task.cancel', taskId: task.id }))}><Icon name="stop" size={15} /></button> : <button className="send-button" aria-label="Send message" disabled={!draft.trim() || !ready || sending || !agent?.available}>{sending ? <span className="spinner" /> : <Icon name="arrow" size={17} />}</button>}</div></form>
          <p className="composer-note"><span><Icon name="shield" size={12} />{demo ? 'An interactive preview of your local assistant.' : 'Permission before action. Review important results.'}</span><span className="keys">Enter to send · Shift + Enter for a new line</span></p>
        </div></div></div>
        {showDetails && <aside className="details" aria-label="Details">
          {selectedBot ? <section className="details-card"><BotAvatar id={selectedBot.id} name={selectedBot.name} size="lg" /><h2>{selectedBot.name}</h2><div className="details-badges"><Badge tone={selectedBot.profile === 'trusted' ? 'warn' : 'good'}>{selectedBot.profile}</Badge>{selectedBot.memoryEnabled && <Badge>memory</Badge>}</div>
              <dl><dt>Agent</dt><dd title={`${snapshot.agents.find(a => a.id === selectedBot.agentId)?.name ?? selectedBot.agentId}${selectedBot.modelId ? ` · ${selectedBot.modelId}` : ''}`}>{snapshot.agents.find(a => a.id === selectedBot.agentId)?.name ?? selectedBot.agentId}{selectedBot.modelId ? ` · ${selectedBot.modelId}` : ''}</dd><dt>Workspace</dt><dd className="mono" title={selectedBot.workspace}>{selectedBot.workspace ?? 'None'}</dd></dl>
              <button className="button secondary" onClick={() => setView('bots')}><Icon name="edit" size={13} />Manage bots</button></section>
            : <section className="details-card"><span className="app-mark large"><Icon name="spark" size={26} /></span><h2>{agent?.name ?? 'Your Bot'}</h2><p className="help">This conversation does not belong to a bot.</p></section>}
          {botApprovals.length > 0 && <section className="details-section"><div className="details-head"><h3>Waiting on you</h3></div><ul className="details-list">{botApprovals.map(request => <li key={request.id}><Icon name="key" size={14} /><span><strong>{request.capability}</strong><span className="mono">{requestSubject(request)}</span></span><button className="button primary small" aria-label={`Review ${request.capability} request`} onClick={() => review(request.id)}>Review</button></li>)}</ul></section>}
          {selectedBot && <section className="details-section"><div className="details-head"><h3>Routines</h3><button className="icon-button" aria-label={`New routine for ${selectedBot.name}`} title="New routine" onClick={() => setView('routines')}><Icon name="plus" size={15} /></button></div>
            {botRoutines.length ? <ul className="details-list">{botRoutines.map(routine => <li key={routine.id}><span className={`routine-clock ${routine.enabled ? 'on' : 'off'}`}><Icon name="clock" size={15} /></span><span><strong>{routine.name}</strong><span>{routine.enabled ? describeSchedule(routine.schedule) : 'Paused'}</span></span></li>)}</ul> : <p className="help">Routines are prompts {selectedBot.name} runs on a schedule.</p>}</section>}
        </aside>}
        </div>}
      </main>
    </div>
    {permission ? <ApprovalDialog key={permission.id} request={permission} bot={snapshot.bots.find(bot => bot.id === permission.botId)} sessionTitle={snapshot.sessions.find(s => s.id === permission.sessionId)?.title ?? permission.sessionId}
        run={snapshot.routineRuns.find(run => run.id === permission.routineRunId)} routine={snapshot.routines.find(routine => routine.id === snapshot.routineRuns.find(run => run.id === permission.routineRunId)?.routineId)} store={store} onClose={() => dismiss(permission.id)} />
      : settingsOpen ? <SettingsDialog settings={snapshot.settings} store={store} appearance={appearance} onClose={() => setSettingsOpen(false)} /> : deleteId ? <Modal title="Delete conversation?" onClose={() => setDeleteId(undefined)}><p>This removes “{snapshot.sessions.find(s => s.id === deleteId)?.title}” and its message history. Any running task will be cancelled.</p><div className="modal-actions"><button className="button secondary" onClick={() => setDeleteId(undefined)}>Keep conversation</button><button className="button danger" onClick={async () => { const result = await store.command({ type: 'session.delete', sessionId: deleteId }); if (result?.ok) setDeleteId(undefined); }}>Delete conversation</button></div></Modal> : null}
  </>;
}
