import { useState, type FormEvent } from 'react';
import type { AppSettingsV2, ProviderConfigV2 } from '@your-bot/contracts';
import type { DesktopStore } from './store';
import { Icon, Modal } from './ui';
import { AgentsPanel } from './AgentsPanel';
import { UpdatesPanel } from './UpdatesPanel';
import { SEASON_LABELS, lookFor, type Appearance } from './appearance';
import type { ColorMode, ThemeChoice } from '../shared/appearance';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export type SettingsTab = 'general' | 'providers' | 'updates';
type Tab = SettingsTab;
const TABS: { id: Tab; label: string; icon: 'palette' | 'terminal' | 'download' }[] = [{ id: 'general', label: 'General', icon: 'palette' }, { id: 'providers', label: 'Providers', icon: 'terminal' }, { id: 'updates', label: 'Updates', icon: 'download' }];

/** Appearance applies and saves immediately, like the rest of the system settings it sits beside. */
function GeneralSettings({ appearance }: { appearance: Appearance }) {
  const { prefs, update } = appearance;
  const current = SEASON_LABELS[lookFor('seasonal')];
  return <div className="settings-panel"><h3 className="settings-group-title">Appearance</h3><div className="settings-group">
    <label className="settings-row"><span><strong>Color mode</strong><span className="help">Light, dark, or match your system.</span></span><select value={prefs.colorMode} onChange={e => update({ colorMode: e.target.value as ColorMode })}><option value="system">Follow system</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
    <label className="settings-row"><span><strong>Theme</strong><span className="help">Seasonal colors change with the calendar.</span></span><select value={prefs.theme} onChange={e => update({ theme: e.target.value as ThemeChoice })}><option value="seasonal">Seasonal · now {current}</option><option value="spring">Spring</option><option value="summer">Summer</option><option value="autumn">Fall</option><option value="winter">Winter</option><option value="classic">Classic</option></select></label>
    <label className="settings-row"><span><strong>Background art</strong><span className="help">{prefs.theme === 'classic' ? 'Classic has no background art. Pick a seasonal theme to see it.' : 'Seasonal illustrations, like fall leaves or a snowman, drawn faintly behind the conversation. They never cover text or controls.'}</span></span><input type="checkbox" role="switch" className="switch" checked={prefs.backgroundArt} onChange={e => update({ backgroundArt: e.target.checked })} /></label>
  </div></div>;
}

export function SettingsDialog({ settings, store, appearance, onClose, initialTab = 'general' }: { settings: AppSettingsV2; store: DesktopStore; appearance: Appearance; onClose: () => void; initialTab?: SettingsTab }) {
  const tabs = TABS.filter(item => item.id !== 'updates' || store.updates);
  const [tab, setTab] = useState<Tab>(() => tabs.some(item => item.id === initialTab) ? initialTab : 'general');
  const [providers, setProviders] = useState<ProviderConfigV2[]>(() => structuredClone(settings.providers).map(({ apiKey: _secret, ...provider }) => provider));
  const [newKeys, setNewKeys] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  /** Text being typed into list fields; parsed on every change but displayed verbatim so newlines and commas survive. */
  const [typed, setTyped] = useState<Record<string, string>>({});
  /** After a connect, bring just the linked providers into the local copy (keys stripped); unsaved edits to other providers survive, so Save cannot overwrite the new link. */
  const adopt = (ids: string[]) => { const latest = store.getState().snapshot.settings.providers; setProviders(current => { let next = current; for (const id of ids) { const fresh = latest.find(provider => provider.id === id); if (!fresh) continue; const { apiKey: _secret, ...clean } = structuredClone(fresh); next = next.some(provider => provider.id === id) ? next.map(provider => provider.id === id ? clean : provider) : [...next, clean]; } return next; }); };
  const patch = (id: string, values: Partial<ProviderConfigV2>) => setProviders(current => current.map(provider => provider.id === id ? { ...provider, ...values } : provider));
  async function save(event: FormEvent) {
    event.preventDefault(); setError(undefined);
    for (const provider of providers) {
      if (!provider.name.trim()) { setError('Give each provider a name.'); return; }
      if (provider.kind === 'acp' && provider.enabled && provider.launch === 'host') {
        if (!provider.command?.trim()) { setError(`Enter the command that starts ${provider.name}.`); return; }
        if (provider.envPassthrough?.some(name => !ENV_NAME.test(name))) { setError('Environment pass-through entries must be variable names.'); return; }
      } else if (provider.kind === 'acp' && provider.enabled && (!['/usr/bin/node', '/usr/bin/python3'].includes(provider.command ?? '') || provider.args?.length !== 1 || !provider.args[0].startsWith('/') || !/\.(mjs|py)$/.test(provider.args[0]))) {
        setError('ACP needs a supported system runtime and one absolute .mjs or .py harness script.'); return;
      }
      if (provider.kind !== 'acp' && provider.enabled) {
        try { const url = new URL(provider.endpoint ?? ''); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(); }
        catch { setError(`Enter an HTTP or HTTPS endpoint without embedded credentials for ${provider.name}.`); return; }
      }
    }
    setSaving(true);
    const result = await store.command({ type: 'settings.update', settings: { providers: providers.map(provider => newKeys[provider.id] ? { ...provider, apiKey: newKeys[provider.id] } : provider) } });
    if (result?.ok) { await store.command({ type: 'models.refresh' }); onClose(); }
    else setError(result && !result.ok ? result.error.message : 'Could not save settings. Reconnect and try again.');
    setSaving(false);
  }
  return <Modal title="Settings" onClose={onClose} wide><div className="settings-layout">
    <div className="settings-tabs" role="tablist" aria-label="Settings sections" aria-orientation="vertical">{tabs.map(item => <button key={item.id} role="tab" id={`settings-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`settings-panel-${item.id}`} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}><Icon name={item.icon} size={15} />{item.label}</button>)}</div>
    <div className="settings-content" role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`}>
    {tab === 'general' ? <GeneralSettings appearance={appearance} /> : tab === 'updates' && store.updates ? <UpdatesPanel api={store.updates} runningTasks={store.getState().snapshot.activeTasks.length} /> : <>{store.providers && <AgentsPanel api={store.providers} store={store} onLinked={adopt} />}<h3 className="settings-group-title">Manual setup</h3><p className="help">Connect your local models or an OpenAI-compatible endpoint. Requests run through your backend.</p>
    <form onSubmit={event => void save(event)}><div className="provider-list">{providers.map((provider, index) => <fieldset className="provider" key={provider.id} disabled={saving}><legend>Provider {index + 1}</legend><div className="provider-top"><label>Name<input value={provider.name} onChange={e => patch(provider.id, { name: e.target.value })} /></label><label className="toggle"><input type="checkbox" checked={provider.enabled} onChange={e => patch(provider.id, { enabled: e.target.checked })} />Enabled</label><button type="button" className="icon-button" aria-label={`Remove ${provider.name}`} onClick={() => setProviders(current => current.filter(p => p.id !== provider.id))}><Icon name="trash" /></button></div>
      <div className="provider-grid"><label>Provider type<select value={provider.kind} onChange={e => { const kind = e.target.value as ProviderConfigV2['kind']; patch(provider.id, { kind, launch: undefined, envPassthrough: undefined, ...(kind === 'acp' ? { command: '/usr/bin/node', args: [''] } : { endpoint: kind === 'lmstudio' ? 'http://127.0.0.1:1234/v1' : 'http://127.0.0.1:8080/v1' }) }); }}><option value="acp">ACP agent</option><option value="lmstudio">LM Studio</option><option value="llamacpp">llama.cpp</option><option value="openai-compatible">OpenAI compatible</option></select></label><label>Model ID (optional)<input value={provider.modelId ?? ''} placeholder="Discovered automatically" onChange={e => patch(provider.id, { modelId: e.target.value || undefined })} /></label></div>
      {provider.kind === 'acp' ? <>
        <label>Launch mode<select value={provider.launch ?? 'contained'} onChange={e => e.target.value === 'host' ? patch(provider.id, { launch: 'host', command: '', args: [] }) : patch(provider.id, { launch: undefined, envPassthrough: undefined, command: '/usr/bin/node', args: [''] })}><option value="contained">Contained (strict bots)</option><option value="host">Installed agent on this computer (trusted bots)</option></select></label>
        {provider.launch === 'host'
          ? <><label>Agent command<input value={provider.command ?? ''} spellCheck={false} placeholder="grok" onChange={e => patch(provider.id, { command: e.target.value })} /></label><label>Arguments (one per line)<textarea rows={2} spellCheck={false} value={typed[`${provider.id}:args`] ?? (provider.args ?? []).join('\n')} onChange={e => { setTyped(current => ({ ...current, [`${provider.id}:args`]: e.target.value })); patch(provider.id, { args: e.target.value.split('\n').map(line => line.trim()).filter(Boolean) }); }} /></label><label>Environment variables to pass through (names, comma separated)<input value={typed[`${provider.id}:env`] ?? (provider.envPassthrough ?? []).join(', ')} spellCheck={false} placeholder="ANTHROPIC_API_KEY" onChange={e => { setTyped(current => ({ ...current, [`${provider.id}:env`]: e.target.value })); patch(provider.id, { envPassthrough: e.target.value.split(',').map(name => name.trim()).filter(Boolean) }); }} /></label>
            <p className="warning-inline" role="note">Host-launched agents run uncontained with your user’s rights and network. Only bots set to the trusted profile can use them; their file, terminal and permission requests still go through approvals.</p></>
          : <><label>Harness runtime<select value={provider.command ?? '/usr/bin/node'} onChange={e => patch(provider.id, { command: e.target.value })}><option value="/usr/bin/node">System Node.js</option><option value="/usr/bin/python3">System Python</option></select></label><label>Harness script<input value={provider.args?.[0] ?? ''} placeholder="/absolute/path/agent.mjs" onChange={e => patch(provider.id, { args: [e.target.value] })} /></label><p className="help">Linux isolation is required. This launch policy supports one script, denies network and native terminal/file tools, and routes Your Bot tools through approvals.</p></>}
      </> : <><label>Endpoint<input type="url" placeholder="http://127.0.0.1:1234/v1" value={provider.endpoint ?? ''} onChange={e => patch(provider.id, { endpoint: e.target.value })} /></label><label>API key (optional)<input type="password" autoComplete="off" value={newKeys[provider.id] ?? ''} placeholder="Leave blank to preserve the stored key" onChange={e => setNewKeys(current => ({ ...current, [provider.id]: e.target.value }))} /></label><label className="toggle"><input type="checkbox" checked={provider.apiKey === ''} onChange={e => patch(provider.id, { apiKey: e.target.checked ? '' : undefined })} />Remove stored API key</label></>}
    </fieldset>)}</div>
    <button type="button" className="button text" disabled={saving || providers.length >= 128} onClick={() => setProviders(current => [...current, { id: crypto.randomUUID(), name: 'Local provider', kind: 'openai-compatible', endpoint: 'http://127.0.0.1:8080/v1', enabled: true }])}><Icon name="plus" />Add provider</button>
    <p className="help">Credentials stay in the private local store. Stored keys are never sent back to this interface.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="button secondary" disabled={saving} onClick={onClose}>Cancel</button><button className="button primary" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button></div>
    </form></>}</div></div></Modal>;
}
