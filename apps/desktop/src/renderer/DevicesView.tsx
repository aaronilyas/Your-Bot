import { useState } from 'react';
import type { PairingOffer } from '@your-bot/contracts';
import type { DesktopState, DesktopStore } from './store';
import { Badge, Icon, Modal, PageHeader } from './ui';
import { formatTime } from './format';

async function copyText(text: string, field: HTMLInputElement | null): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* Fall back to selection copy. */ }
  try { field?.select(); return document.execCommand('copy'); } catch { return false; }
}

function PairingDialog({ offer, onClose }: { offer: PairingOffer; onClose: () => void }) {
  const [copied, setCopied] = useState<boolean>();
  let field: HTMLInputElement | null = null;
  return <Modal title="Pair a device" onClose={onClose}>
    <p>On the other device, enter this one-time pairing code. It works once and expires at <strong>{formatTime(offer.expiresAt)}</strong>.</p>
    <label>Pairing code<input readOnly ref={element => { field = element; }} value={offer.code} spellCheck={false} onFocus={event => event.currentTarget.select()} /></label>
    <div className="row-actions"><button className="button primary" onClick={async () => setCopied(await copyText(offer.code, field))}><Icon name="copy" size={14} />Copy code</button>{copied === true && <span role="status" className="help">Copied</span>}{copied === false && <span role="status" className="help">Select the code and copy it manually.</span>}</div>
    <p className="help">Host fingerprint (SHA-256): <code>{offer.hostFingerprint}</code></p>
    {offer.urls.length > 0 && <p className="help">Reachable at: {offer.urls.map(url => <code key={url}>{url}</code>)}</p>}
    <p className="help">Anyone with this code can pair until it expires or is used. The code is not stored; close this window and generate a new one if in doubt.</p>
    <div className="modal-actions"><button className="button secondary" onClick={onClose}>Done</button></div>
  </Modal>;
}

export function DevicesView({ state, store, demo }: { state: DesktopState; store: DesktopStore; demo: boolean }) {
  const { snapshot } = state;
  const [name, setName] = useState('');
  const [offer, setOffer] = useState<PairingOffer>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function pair() {
    setBusy(true); setError(undefined);
    const result = await store.command({ type: 'device.pair.start', ...(name.trim() ? { name: name.trim() } : {}) });
    setBusy(false);
    if (result?.ok && result.pairing) { setOffer(result.pairing); setName(''); }
    else if (result && !result.ok) setError(result.error.code === 'NOT_SUPPORTED' ? 'This host does not support pairing devices.' : result.error.message);
    else if (result?.ok) setError('The host did not return a pairing code.');
  }
  return <div className="page">
    <PageHeader title="Devices" caption={`Other devices that may answer approvals for ${snapshot.host.name || 'this host'}. Paired devices cannot change settings or trust levels.`} />
    {demo && <p className="empty-note">Simulated: no real device can pair in the browser demonstration.</p>}
    <section className="form-section"><h3>Pair a device</h3>
      <div className="inline-fields"><label>Device name (optional)<input value={name} maxLength={256} onChange={event => setName(event.target.value)} /></label><button className="button primary" disabled={busy} onClick={() => void pair()}>Pair a device</button></div>
      {error && <p className="inline-error" role="alert">{error}</p>}</section>
    <section><h3 className="section-title">Paired devices</h3>
      {!snapshot.devices.length && <p className="empty-note">No devices are paired.</p>}
      <ul className="row-list" aria-label="Devices">{snapshot.devices.map(device => <li key={device.id}><div><strong>{device.name}</strong> {device.revokedAt ? <Badge tone="bad">revoked</Badge> : <Badge tone="good">active</Badge>}<p className="subject">{device.capabilities.join(', ')}</p><span className="help">Paired {formatTime(device.pairedAt)} · last seen {formatTime(device.lastSeenAt)}</span></div>
        {!device.revokedAt && <button className="button danger" aria-label={`Revoke ${device.name}`} onClick={async () => { const r = await store.command({ type: 'device.revoke', deviceId: device.id }); if (r && !r.ok) setError(r.error.message); }}>Revoke</button>}</li>)}</ul></section>
    {offer && <PairingDialog offer={offer} onClose={() => setOffer(undefined)} />}
  </div>;
}
