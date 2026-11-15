import { useEffect, useState } from 'react';
import type { DesktopState, DesktopStore } from './store';
import { Badge, Icon, PageHeader } from './ui';
import { botName, describeScope, formatTime, requestSubject } from './format';

const PAGE = 50;

export function PermissionsView({ state, store, onReview }: { state: DesktopState; store: DesktopStore; onReview: (requestId: string) => void }) {
  const { snapshot, audit, auditComplete } = state;
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  useEffect(() => { void store.command({ type: 'audit.list', limit: PAGE }); }, [store]);
  async function revoke(grantId: string) {
    setError(undefined);
    const result = await store.command({ type: 'grant.revoke', grantId });
    if (!result?.ok) setError(result && !result.ok ? result.error.message : 'Could not revoke the grant.');
  }
  async function older() {
    const last = audit.at(-1);
    if (!last) return;
    setLoading(true);
    await store.command({ type: 'audit.list', limit: PAGE, beforeId: last.id });
    setLoading(false);
  }
  const entries = filter ? audit.filter(entry => entry.botId === filter) : audit;
  return <div className="page">
    <PageHeader title="Permissions" caption="Approvals waiting for you, standing grants you have given bots, and a record of every decision." />
    {error && <p className="inline-error" role="alert">{error}</p>}
    <section aria-labelledby="pending-heading"><h3 id="pending-heading" className="section-title">Waiting for approval</h3>
      {!snapshot.pendingPermissions.length && <p className="empty-note">Nothing is waiting for you.</p>}
      <ul className="row-list">{snapshot.pendingPermissions.map(request => <li key={request.id}><div><strong>{request.capability}</strong> <span className="help">{botName(snapshot.bots, request.botId)}{request.routineRunId ? ' · routine run' : ''}</span><p className="subject">{requestSubject(request)}</p></div>
        <button className="button primary" aria-label={`Review ${request.capability} request`} onClick={() => onReview(request.id)}>Review</button></li>)}</ul></section>
    <section aria-labelledby="grants-heading"><h3 id="grants-heading" className="section-title">Standing grants</h3>
      {!snapshot.grants.length && <p className="empty-note">No standing grants. Choose “Always allow…” in an approval to create one.</p>}
      <ul className="row-list">{snapshot.grants.map(grant => <li key={grant.id} aria-label={`Grant ${grant.id}`}><div><strong>{botName(snapshot.bots, grant.botId)}</strong> <Badge>{grant.capability}</Badge><p className="subject">{describeScope(grant.scope)}</p><span className="help">Created {formatTime(grant.createdAt)} by {grant.createdBy}{grant.expiresAt ? ` · expires ${formatTime(grant.expiresAt)}` : ' · no expiry'}</span></div>
        <button className="button danger" aria-label={`Revoke ${botName(snapshot.bots, grant.botId)} ${grant.capability} grant`} onClick={() => void revoke(grant.id)}>Revoke</button></li>)}</ul></section>
    <section aria-labelledby="audit-heading"><div className="section-row"><h3 id="audit-heading" className="section-title">Audit log</h3>
      <label className="inline-select">Bot<select value={filter} onChange={event => setFilter(event.target.value)}><option value="">All bots</option>{snapshot.bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label></div>
      {!entries.length && <p className="empty-note">No recorded decisions yet.</p>}
      <ul className="row-list audit" aria-label="Audit log">{entries.map(entry => <li key={entry.id}><div><div className="audit-head"><Badge tone={entry.outcome === 'allow' ? 'good' : 'bad'}>{entry.outcome}</Badge><Badge tone={entry.via === 'standing' ? 'info' : 'neutral'}>{entry.via}</Badge><strong>{entry.capability}</strong><span className="help">{botName(snapshot.bots, entry.botId)}</span></div>
        <p className="subject">{entry.subject}</p><span className="help">{formatTime(entry.at)}{entry.decidedBy ? ` · ${entry.decidedBy}` : ''}{entry.grantId ? ` · grant ${entry.grantId.slice(0, 8)}` : ''}{entry.routineRunId ? ' · routine run' : ''}</span></div></li>)}</ul>
      {!auditComplete && audit.length > 0 && <button className="button secondary" disabled={loading} onClick={() => void older()}><Icon name="refresh" size={14} />Load older entries</button>}</section>
  </div>;
}
