import type { DesktopState, DesktopStore } from './store';
import { Badge, Icon, PageHeader } from './ui';
import { botName, formatTime } from './format';

export function NotificationsView({ state, store, onReview, onOpenRoutines }: { state: DesktopState; store: DesktopStore; onReview: (requestId: string) => void; onOpenRoutines: () => void }) {
  const { snapshot } = state;
  const unread = snapshot.notifications.filter(n => !n.acknowledgedAt);
  return <div className="page">
    <PageHeader title="Notifications" caption="Things that need you: approvals, routine problems and new devices." actions={unread.length > 1 ? <button className="button secondary" onClick={async () => { for (const n of unread) await store.command({ type: 'notification.ack', notificationId: n.id }); }}><Icon name="check" size={14} />Acknowledge all</button> : undefined} />
    {!snapshot.notifications.length && <p className="empty-note">You’re all caught up.</p>}
    <ul className="row-list" aria-label="Notifications">{snapshot.notifications.map(n => {
      const pending = n.requestId ? snapshot.pendingPermissions.some(p => p.id === n.requestId) : false;
      return <li key={n.id} className={n.acknowledgedAt ? 'read' : 'unread'} aria-label={`${n.acknowledgedAt ? '' : 'Unread: '}${n.title}`}>
        <div><div className="audit-head"><strong>{n.title}</strong><Badge tone={n.kind === 'approval.required' ? 'warn' : n.kind.startsWith('routine') ? 'bad' : 'info'}>{n.kind}</Badge></div>
          <p className="subject">{n.body}</p><span className="help">{formatTime(n.createdAt)}{n.botId ? ` · ${botName(snapshot.bots, n.botId)}` : ''}</span></div>
        <div className="row-actions">
          {pending && <button className="button primary" onClick={() => onReview(n.requestId!)}>Review approval</button>}
          {n.routineRunId && !pending && <button className="button secondary" onClick={onOpenRoutines}>View routines</button>}
          {!n.acknowledgedAt && <button className="button secondary" aria-label={`Acknowledge ${n.title}`} onClick={() => void store.command({ type: 'notification.ack', notificationId: n.id })}>Acknowledge</button>}
        </div></li>;
    })}</ul>
  </div>;
}
