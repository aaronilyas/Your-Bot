import { useEffect, useState, type FormEvent } from 'react';
import type { Bot, MemoryEntry } from '@your-bot/contracts';
import type { DesktopState, DesktopStore } from './store';
import { Badge, Icon, Modal, PageHeader } from './ui';
import { blankBotForm, blankMcp, botInputFromForm, botPatchFromForm, browserPreset, formFromBot, validateBotForm, type BotForm, type KeyValueRow, type McpForm } from './botForm';
import { formatTime } from './format';

export const TRUSTED_WARNING = 'A trusted bot runs the installed agent program uncontained, with your user’s file rights and network access. The agent’s file, terminal and permission requests still go through approvals, but the agent process itself is not sandboxed. Only use trusted bots with agents and workspaces you trust.';

function RowsEditor({ label, rows, onChange, keyPlaceholder, valuePlaceholder }: { label: string; rows: KeyValueRow[]; onChange: (rows: KeyValueRow[]) => void; keyPlaceholder: string; valuePlaceholder: string }) {
  return <div className="kv-editor"><span className="field-label">{label}</span>
    {rows.map((row, index) => <div className="kv-row" key={index}>
      <input aria-label={`${label} name ${index + 1}`} placeholder={keyPlaceholder} value={row.key} readOnly={row.stored} onChange={event => onChange(rows.map((r, i) => i === index ? { ...r, key: event.target.value } : r))} />
      <input aria-label={`${label} value ${index + 1}`} type="password" autoComplete="off" placeholder={row.stored ? 'Stored secret — leave blank to keep' : valuePlaceholder} value={row.value} onChange={event => onChange(rows.map((r, i) => i === index ? { ...r, value: event.target.value } : r))} />
      <button type="button" className="icon-button" aria-label={`Remove ${label} ${row.key || index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}><Icon name="trash" size={14} /></button></div>)}
    <button type="button" className="button text" onClick={() => onChange([...rows, { key: '', value: '', stored: false }])}><Icon name="plus" size={14} />Add {label.toLowerCase()}</button></div>;
}

function McpEditor({ server, onChange, onRemove }: { server: McpForm; onChange: (server: McpForm) => void; onRemove: () => void }) {
  const set = (values: Partial<McpForm>) => onChange({ ...server, ...values });
  return <fieldset className="mcp-server"><legend>{server.name || server.id}{server.preset ? ' · preset' : ''}</legend>
    <div className="inline-fields">
      <label>Name<input value={server.name} onChange={event => set({ name: event.target.value })} /></label>
      <label>Server id<input value={server.id} readOnly={!server.isNew} spellCheck={false} onChange={event => set({ id: event.target.value })} /></label>
      <label className="toggle"><input type="checkbox" checked={server.enabled} onChange={event => set({ enabled: event.target.checked })} />Enabled</label>
      <button type="button" className="icon-button" aria-label={`Remove MCP server ${server.name || server.id}`} onClick={onRemove}><Icon name="trash" /></button></div>
    {server.preset === 'browser'
      ? <p className="help">Browser automation preset: the host supplies a pinned browser MCP server. Each browser action is still approved or granted per tool call.</p>
      : <>
        <label>Transport<select value={server.transport} onChange={event => set({ transport: event.target.value as McpForm['transport'] })}><option value="stdio">Local command (stdio)</option><option value="http">HTTP URL</option></select></label>
        {server.transport === 'stdio'
          ? <><label>Command<input value={server.command} spellCheck={false} placeholder="npx" onChange={event => set({ command: event.target.value })} /></label>
            <label>Arguments (one per line)<textarea rows={2} value={server.args} spellCheck={false} onChange={event => set({ args: event.target.value })} /></label>
            <label>Working folder (optional)<input value={server.cwd} spellCheck={false} placeholder="/absolute/path" onChange={event => set({ cwd: event.target.value })} /></label>
            <RowsEditor label="Environment" rows={server.env} keyPlaceholder="NAME" valuePlaceholder="Secret value" onChange={env => set({ env })} /></>
          : <><label>URL<input value={server.url} spellCheck={false} placeholder="https://example.test/mcp" onChange={event => set({ url: event.target.value })} /></label>
            <RowsEditor label="Headers" rows={server.headers} keyPlaceholder="Header-Name" valuePlaceholder="Secret value" onChange={headers => set({ headers })} /></>}
      </>}
  </fieldset>;
}

export function BotEditor({ bot, state, store, onClose }: { bot?: Bot; state: DesktopState; store: DesktopStore; onClose: (saved?: Bot) => void }) {
  const { snapshot } = state;
  const firstAgent = snapshot.agents.find(agent => agent.available) ?? snapshot.agents[0];
  const [form, setForm] = useState<BotForm>(() => bot ? formFromBot(bot) : blankBotForm(firstAgent?.id ?? '', firstAgent?.models[0]?.id ?? ''));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const set = (values: Partial<BotForm>) => setForm(current => ({ ...current, ...values }));
  const agent = snapshot.agents.find(candidate => candidate.id === form.agentId);
  const known = new Set(snapshot.skills.map(skill => skill.id));
  async function browse() {
    const path = await store.chooseDirectory();
    if (path) set({ workspace: path });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const problem = validateBotForm(form);
    if (problem) { setError(problem); return; }
    setSaving(true); setError(undefined);
    if (!bot) {
      const result = await store.command({ type: 'bot.create', bot: botInputFromForm(form) });
      setSaving(false);
      if (result?.ok) onClose(result.bot); else setError(result && !result.ok ? result.error.message : 'Could not save the bot. Reconnect and try again.');
      return;
    }
    const patch = botPatchFromForm(bot, form);
    if (!Object.keys(patch).length) { setSaving(false); onClose(); return; }
    const result = await store.command({ type: 'bot.update', botId: bot.id, patch });
    setSaving(false);
    if (result?.ok) onClose(result.bot); else setError(result && !result.ok ? result.error.message : 'Could not save the bot. Reconnect and try again.');
  }
  return <Modal title={bot ? `Edit bot: ${bot.name}` : 'New bot'} onClose={() => onClose()} wide>
    <form className="bot-form" onSubmit={event => void save(event)}>
      <label>Name<input value={form.name} maxLength={256} onChange={event => set({ name: event.target.value })} /></label>
      <label>Instructions<textarea rows={4} value={form.instructions} placeholder="Standing instructions for this bot" onChange={event => set({ instructions: event.target.value })} /></label>
      <div className="inline-fields">
        <label>Agent<select value={form.agentId} onChange={event => set({ agentId: event.target.value, modelId: snapshot.agents.find(a => a.id === event.target.value)?.models[0]?.id ?? '' })}>{!agent && <option value={form.agentId}>{form.agentId || 'Choose an agent'}</option>}{snapshot.agents.map(a => <option key={a.id} value={a.id} disabled={!a.available && a.id !== form.agentId}>{a.name}{a.available ? '' : ' · unavailable'}</option>)}</select></label>
        <label>Model<select value={form.modelId} onChange={event => set({ modelId: event.target.value })}><option value="">Default model</option>{agent?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}{form.modelId && !agent?.models.some(model => model.id === form.modelId) && <option value={form.modelId}>{form.modelId}</option>}</select></label></div>
      <div className="workspace-field"><label>Workspace folder<input value={form.workspace} readOnly={store.canChooseDirectory} placeholder="No workspace" spellCheck={false} onChange={event => set({ workspace: event.target.value })} /></label>
        {store.canChooseDirectory && <button type="button" className="button secondary" onClick={() => void browse()}>Browse…</button>}
        {form.workspace && <button type="button" className="button secondary" onClick={() => set({ workspace: '' })}>Clear</button>}</div>
      <fieldset className="radio-group"><legend>Execution profile</legend>
        <label className="choice"><input type="radio" name="profile" checked={form.profile === 'strict'} onChange={() => set({ profile: 'strict', understood: false })} /><span><strong>Strict</strong> — the agent runs contained; every file and tool request is approved by you. Recommended.</span></label>
        <label className="choice"><input type="radio" name="profile" checked={form.profile === 'trusted'} onChange={() => set({ profile: 'trusted' })} /><span><strong>Trusted</strong> — runs an installed agent on your computer, uncontained. Requires a workspace.</span></label></fieldset>
      {form.profile === 'trusted' && <div className="warning" role="alert"><strong>Trusted bots run uncontained</strong><p>{TRUSTED_WARNING}</p>
        <label className="choice"><input type="checkbox" checked={form.understood} onChange={event => set({ understood: event.target.checked })} />I understand and want this bot to run uncontained</label></div>}
      <section className="form-section"><h3>MCP servers</h3>
        {form.mcp.map((server, index) => <McpEditor key={index} server={server} onChange={next => set({ mcp: form.mcp.map((s, i) => i === index ? next : s) })} onRemove={() => set({ mcp: form.mcp.filter((_, i) => i !== index) })} />)}
        {!form.mcp.length && <p className="help">No MCP servers. MCP tools are only available to trusted bots, and every call is approved or granted.</p>}
        <div className="row-actions"><button type="button" className="button secondary" onClick={() => set({ mcp: [...form.mcp, blankMcp(form.mcp)] })}><Icon name="plus" size={14} />Add MCP server</button>
          <button type="button" className="button secondary" disabled={form.mcp.some(server => server.preset === 'browser')} onClick={() => set({ mcp: [...form.mcp, browserPreset()] })}>Add browser automation</button></div></section>
      <section className="form-section"><h3>Skills</h3>
        {snapshot.skills.map(skill => <label className="choice" key={skill.id}><input type="checkbox" disabled={Boolean(skill.error)} checked={form.skills.includes(skill.id)} onChange={event => set({ skills: event.target.checked ? [...form.skills, skill.id] : form.skills.filter(id => id !== skill.id) })} /><span><strong>{skill.name}</strong> <Badge>{skill.source}</Badge><br /><span className="help">{skill.error ? `Unavailable: ${skill.error}` : skill.description}</span></span></label>)}
        {form.skills.filter(id => !known.has(id)).map(id => <label className="choice" key={id}><input type="checkbox" checked onChange={() => set({ skills: form.skills.filter(s => s !== id) })} /><span><strong>{id}</strong> <Badge tone="warn">not found</Badge></span></label>)}
        {!snapshot.skills.length && !form.skills.length && <p className="help">No skills found. Add folders with a SKILL.md to the global skills folder or to a workspace’s .your-bot/skills.</p>}
        <button type="button" className="button text" onClick={() => void store.command({ type: 'skills.refresh' })}><Icon name="refresh" size={14} />Refresh skills</button></section>
      <section className="form-section"><h3>Continuity</h3>
        <label className="choice"><input type="checkbox" checked={form.memoryEnabled} onChange={event => set({ memoryEnabled: event.target.checked })} />Remember things across conversations (memory)</label>
        <label className="choice"><input type="checkbox" checked={form.compact} onChange={event => set({ compact: event.target.checked })} />Compact long conversations into a summary</label>
        {form.compact && <div className="inline-fields"><label>Compact above (messages)<input type="number" min={2} value={form.maxMessages} onChange={event => set({ maxMessages: event.target.value })} /></label><label>Keep recent (messages)<input type="number" min={0} value={form.keepRecent} onChange={event => set({ keepRecent: event.target.value })} /></label></div>}</section>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={saving} onClick={() => onClose()}>Cancel</button><button className="button primary" disabled={saving}>{saving ? 'Saving…' : bot ? 'Save bot' : 'Create bot'}</button></div>
    </form></Modal>;
}

export function MemoryPanel({ bot, state, store, onClose }: { bot: Bot; state: DesktopState; store: DesktopStore; onClose: () => void }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const entries: MemoryEntry[] | undefined = state.memory[bot.id];
  useEffect(() => { void store.command({ type: 'memory.list', botId: bot.id }); }, [store, bot.id]);
  async function add(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    const result = await store.command({ type: 'memory.add', botId: bot.id, content: draft.trim() });
    if (result?.ok) { setDraft(''); setError(undefined); } else setError(result && !result.ok ? result.error.message : 'Could not add the memory.');
  }
  return <Modal title={`Memory: ${bot.name}`} onClose={onClose}>
    {!bot.memoryEnabled && <p className="help">Memory is turned off for this bot. Entries are kept but not shown to the agent.</p>}
    <ul className="memory-list" aria-label="Memory entries">{entries?.map(entry => <li key={entry.id}><div><p>{entry.content}</p><span className="help">{entry.source === 'agent' ? 'Saved by the agent' : 'Added by you'} · {formatTime(entry.createdAt)}</span></div>
      <button className="icon-button" aria-label={`Delete memory ${entry.content.slice(0, 40)}`} onClick={() => void store.command({ type: 'memory.delete', botId: bot.id, memoryId: entry.id })}><Icon name="trash" size={15} /></button></li>)}
      {entries && !entries.length && <li className="empty">Nothing remembered yet.</li>}{!entries && <li className="empty">Loading…</li>}</ul>
    <form onSubmit={event => void add(event)}><label>Add a memory<textarea rows={2} value={draft} maxLength={65536} onChange={event => setDraft(event.target.value)} /></label>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Close</button><button className="button primary" disabled={!draft.trim()}>Add memory</button></div></form>
  </Modal>;
}

export function BotsView({ state, store, onOpenSession }: { state: DesktopState; store: DesktopStore; onOpenSession: (sessionId?: string) => void }) {
  const { snapshot } = state;
  const [editing, setEditing] = useState<Bot | 'new'>();
  const [memoryBot, setMemoryBot] = useState<Bot>();
  const [deleting, setDeleting] = useState<Bot>();
  const agentName = (id: string) => snapshot.agents.find(agent => agent.id === id)?.name ?? id;
  async function startSession(bot: Bot) {
    const result = await store.command({ type: 'bot.session.create', botId: bot.id });
    if (result?.ok) onOpenSession(result.sessionId);
  }
  return <div className="page">
    <PageHeader title="Bots" caption="Each bot has its own instructions, agent, workspace, tools and memory. Conversations belong to a bot." actions={<button className="button primary" onClick={() => setEditing('new')}><Icon name="plus" size={14} />New bot</button>} />
    {!snapshot.bots.length && <p className="empty-note">No bots yet. Create one to get started.</p>}
    <div className="card-list">{snapshot.bots.map(bot => <article className="card" key={bot.id} aria-label={`Bot ${bot.name}`}>
      <div className="card-head"><h3>{bot.name}</h3><Badge tone={bot.profile === 'trusted' ? 'warn' : 'good'}>{bot.profile}</Badge></div>
      <p className="card-meta">{agentName(bot.agentId)}{bot.modelId ? ` · ${bot.modelId}` : ''}</p>
      {bot.workspace && <p className="card-meta"><code>{bot.workspace}</code></p>}
      <p className="card-meta">{bot.mcpServers.length} MCP server{bot.mcpServers.length === 1 ? '' : 's'} · {bot.skills.length} skill{bot.skills.length === 1 ? '' : 's'} · memory {bot.memoryEnabled ? 'on' : 'off'}{bot.compaction ? ' · compaction on' : ''}</p>
      {bot.instructions && <p className="card-text">{bot.instructions.slice(0, 160)}{bot.instructions.length > 160 ? '…' : ''}</p>}
      <div className="row-actions"><button className="button primary" onClick={() => void startSession(bot)}>Start session</button><button className="button secondary" aria-label={`Edit ${bot.name}`} onClick={() => setEditing(bot)}><Icon name="edit" size={14} />Edit</button><button className="button secondary" aria-label={`Memory for ${bot.name}`} onClick={() => setMemoryBot(bot)}><Icon name="brain" size={14} />Memory</button><button className="button secondary" aria-label={`Delete ${bot.name}`} onClick={() => setDeleting(bot)}><Icon name="trash" size={14} /></button></div>
    </article>)}</div>
    {editing && <BotEditor bot={editing === 'new' ? undefined : editing} state={state} store={store} onClose={() => setEditing(undefined)} />}
    {memoryBot && <MemoryPanel bot={snapshot.bots.find(b => b.id === memoryBot.id) ?? memoryBot} state={state} store={store} onClose={() => setMemoryBot(undefined)} />}
    {deleting && <Modal title="Delete bot?" onClose={() => setDeleting(undefined)}><p>This removes “{deleting.name}”, its conversations, memory, standing grants and routines. Running tasks are cancelled.</p>
      <div className="modal-actions"><button className="button secondary" onClick={() => setDeleting(undefined)}>Keep bot</button><button className="button danger" onClick={async () => { const result = await store.command({ type: 'bot.delete', botId: deleting.id }); if (result?.ok) setDeleting(undefined); }}>Delete bot</button></div></Modal>}
  </div>;
}
