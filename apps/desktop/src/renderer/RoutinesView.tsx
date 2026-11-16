import { useEffect, useState, type FormEvent } from 'react';
import type { MissedRunPolicy, Routine, RoutineInput, RoutineRun, RoutineSchedule } from '@your-bot/contracts';
import type { DesktopState, DesktopStore } from './store';
import { Badge, Icon, Modal, PageHeader } from './ui';
import { botName, describeSchedule, formatTime } from './format';

export interface RoutineForm {
  botId: string; name: string; prompt: string;
  scheduleKind: RoutineSchedule['kind']; everyMinutes: string; expression: string; timezone: string; at: string;
  missedRunPolicy: MissedRunPolicy; maxCatchUp: string; sessionMode: 'new' | 'reuse'; enabled: boolean;
}
const localZone = (): string => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } };
/** `<input type=datetime-local>` value for an ISO instant, in local time. */
const toLocalInput = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
export function formFromRoutine(routine: Routine | undefined, botId: string): RoutineForm {
  const s = routine?.schedule;
  return {
    botId: routine?.botId ?? botId, name: routine?.name ?? '', prompt: routine?.prompt ?? '',
    scheduleKind: s?.kind ?? 'interval', everyMinutes: String(s?.kind === 'interval' ? s.everyMinutes : 60),
    expression: s?.kind === 'cron' ? s.expression : '0 9 * * 1-5', timezone: s?.kind === 'cron' ? s.timezone ?? '' : localZone(), at: s?.kind === 'once' ? toLocalInput(s.at) : '',
    missedRunPolicy: routine?.missedRunPolicy ?? 'skip', maxCatchUp: String(routine?.maxCatchUp ?? 3), sessionMode: routine?.sessionMode ?? 'new', enabled: routine?.enabled ?? true,
  };
}
export function scheduleFromForm(form: RoutineForm): RoutineSchedule | string {
  if (form.scheduleKind === 'interval') {
    const minutes = Number(form.everyMinutes);
    return Number.isInteger(minutes) && minutes >= 1 && minutes <= 525600 ? { kind: 'interval', everyMinutes: minutes } : 'Enter a whole number of minutes between 1 and 525600.';
  }
  if (form.scheduleKind === 'cron') {
    if (form.expression.trim().split(/\s+/).length !== 5) return 'A cron expression has five fields: minute hour day-of-month month day-of-week.';
    return { kind: 'cron', expression: form.expression.trim().split(/\s+/).join(' '), ...(form.timezone.trim() ? { timezone: form.timezone.trim() } : {}) };
  }
  const at = new Date(form.at);
  return form.at && !Number.isNaN(at.getTime()) ? { kind: 'once', at: at.toISOString() } : 'Choose the date and time to run once.';
}
export function routineInputFromForm(form: RoutineForm): RoutineInput | string {
  if (!form.botId) return 'Choose a bot.';
  if (!form.name.trim()) return 'Give the routine a name.';
  if (!form.prompt.trim()) return 'Write the prompt the bot should run.';
  const schedule = scheduleFromForm(form);
  if (typeof schedule === 'string') return schedule;
  let maxCatchUp: number | undefined;
  if (form.missedRunPolicy === 'runAll') {
    maxCatchUp = Number(form.maxCatchUp);
    if (!Number.isInteger(maxCatchUp) || maxCatchUp < 1 || maxCatchUp > 1000) return 'Catch-up runs must be between 1 and 1000.';
  }
  return { botId: form.botId, name: form.name.trim(), prompt: form.prompt, schedule, missedRunPolicy: form.missedRunPolicy, ...(maxCatchUp !== undefined ? { maxCatchUp } : {}), enabled: form.enabled, sessionMode: form.sessionMode };
}
function patchFromForm(routine: Routine, input: RoutineInput): Partial<RoutineInput> {
  const patch: Partial<RoutineInput> = {};
  for (const key of ['botId', 'name', 'prompt', 'missedRunPolicy', 'enabled', 'sessionMode'] as const) if (input[key] !== routine[key]) (patch as Record<string, unknown>)[key] = input[key];
  if (JSON.stringify(input.schedule) !== JSON.stringify(routine.schedule)) patch.schedule = input.schedule;
  if (input.maxCatchUp !== undefined && input.maxCatchUp !== routine.maxCatchUp) patch.maxCatchUp = input.maxCatchUp;
  return patch;
}

function RoutineEditor({ routine, state, store, onClose }: { routine?: Routine; state: DesktopState; store: DesktopStore; onClose: () => void }) {
  const [form, setForm] = useState(() => formFromRoutine(routine, state.snapshot.bots[0]?.id ?? ''));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const set = (values: Partial<RoutineForm>) => setForm(current => ({ ...current, ...values }));
  async function save(event: FormEvent) {
    event.preventDefault();
    const input = routineInputFromForm(form);
    if (typeof input === 'string') { setError(input); return; }
    setSaving(true); setError(undefined);
    let result;
    if (routine) {
      const patch = patchFromForm(routine, input);
      if (!Object.keys(patch).length) { setSaving(false); onClose(); return; }
      result = await store.command({ type: 'routine.update', routineId: routine.id, patch });
    } else result = await store.command({ type: 'routine.create', routine: input });
    setSaving(false);
    if (result?.ok) onClose(); else setError(result && !result.ok ? result.error.message : 'Could not save the routine. Reconnect and try again.');
  }
  return <Modal title={routine ? `Edit routine: ${routine.name}` : 'New routine'} onClose={onClose} wide>
    <form className="bot-form" onSubmit={event => void save(event)}>
      <div className="inline-fields"><label>Name<input value={form.name} maxLength={256} onChange={event => set({ name: event.target.value })} /></label>
        <label>Bot<select value={form.botId} onChange={event => set({ botId: event.target.value })}>{!form.botId && <option value="">Choose a bot</option>}{state.snapshot.bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label></div>
      <label>Prompt<textarea rows={4} value={form.prompt} placeholder="What should the bot do each time?" onChange={event => set({ prompt: event.target.value })} /></label>
      <div className="inline-fields"><label>Schedule<select value={form.scheduleKind} onChange={event => set({ scheduleKind: event.target.value as RoutineForm['scheduleKind'] })}><option value="interval">Every N minutes</option><option value="cron">Cron</option><option value="once">Once</option></select></label>
        {form.scheduleKind === 'interval' && <label>Every (minutes)<input type="number" min={1} value={form.everyMinutes} onChange={event => set({ everyMinutes: event.target.value })} /></label>}
        {form.scheduleKind === 'cron' && <><label>Cron expression<input value={form.expression} spellCheck={false} onChange={event => set({ expression: event.target.value })} /></label><label>Timezone<input value={form.timezone} spellCheck={false} placeholder="Host local time" onChange={event => set({ timezone: event.target.value })} /></label></>}
        {form.scheduleKind === 'once' && <label>Run at<input type="datetime-local" value={form.at} onChange={event => set({ at: event.target.value })} /></label>}</div>
      <div className="inline-fields"><label>If runs were missed<select value={form.missedRunPolicy} onChange={event => set({ missedRunPolicy: event.target.value as MissedRunPolicy })}><option value="skip">Skip them</option><option value="runOnce">Run once to catch up</option><option value="runAll">Run every missed occurrence</option></select></label>
        {form.missedRunPolicy === 'runAll' && <label>At most (catch-up runs)<input type="number" min={1} max={1000} value={form.maxCatchUp} onChange={event => set({ maxCatchUp: event.target.value })} /></label>}
        <label>Conversation<select value={form.sessionMode} onChange={event => set({ sessionMode: event.target.value as 'new' | 'reuse' })}><option value="new">New session each run</option><option value="reuse">Continue one session</option></select></label></div>
      <label className="choice"><input type="checkbox" checked={form.enabled} onChange={event => set({ enabled: event.target.checked })} />Enabled</label>
      <p className="help">Routines run unattended. A run that needs approval waits, indefinitely, until you decide — or until a standing grant covers it.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={saving} onClick={onClose}>Cancel</button><button className="button primary" disabled={saving}>{saving ? 'Saving…' : routine ? 'Save routine' : 'Create routine'}</button></div>
    </form></Modal>;
}

const tone = (status: RoutineRun['status']): 'good' | 'warn' | 'bad' | 'info' | 'neutral' => status === 'completed' ? 'good' : status === 'blocked' ? 'warn' : status === 'failed' || status === 'interrupted' ? 'bad' : status === 'running' || status === 'queued' ? 'info' : 'neutral';

function RunsList({ routine, state, store, onReview, onOpenSession }: { routine: Routine; state: DesktopState; store: DesktopStore; onReview: (requestId: string) => void; onOpenSession: (sessionId: string) => void }) {
  useEffect(() => { void store.command({ type: 'routine.runs', routineId: routine.id, limit: 20 }); }, [store, routine.id]);
  const runs = state.snapshot.routineRuns.filter(run => run.routineId === routine.id);
  const pending = state.snapshot.pendingPermissions;
  return <div className="runs"><ul className="row-list" aria-label={`Runs of ${routine.name}`}>{runs.map(run => {
    const waiting = (run.blockedOn ?? []).filter(id => pending.some(request => request.id === id));
    return <li key={run.id}><div><div className="audit-head"><Badge tone={tone(run.status)}>{run.status}</Badge><span className="help">{run.trigger} · scheduled {formatTime(run.scheduledFor)}</span></div>
      {run.finishedAt && <span className="help">Finished {formatTime(run.finishedAt)}</span>}{run.error && <p className="subject">{run.error.message}</p>}</div>
      <div className="row-actions">{run.status === 'blocked' && waiting.map(id => <button key={id} className="button primary" onClick={() => onReview(id)}>Review approval</button>)}
        {run.status === 'blocked' && !waiting.length && <span className="help">Waiting for approval</span>}
        {run.sessionId && state.snapshot.sessions.some(session => session.id === run.sessionId) && <button className="button secondary" onClick={() => onOpenSession(run.sessionId!)}>Open conversation</button>}</div></li>;
  })}{!runs.length && <li className="empty">No runs yet.</li>}</ul></div>;
}

export function RoutinesView({ state, store, onReview, onOpenSession }: { state: DesktopState; store: DesktopStore; onReview: (requestId: string) => void; onOpenSession: (sessionId: string) => void }) {
  const { snapshot } = state;
  const [editing, setEditing] = useState<Routine | 'new'>();
  const [open, setOpen] = useState<string>();
  const [deleting, setDeleting] = useState<Routine>();
  const [error, setError] = useState<string>();
  async function run(routineId: string, action: Parameters<DesktopStore['command']>[0]) {
    setError(undefined);
    const result = await store.command(action);
    if (result && !result.ok) setError(result.error.message);
    return result;
  }
  return <div className="page">
    <PageHeader title="Routines" caption="Prompts a bot runs on a schedule, without you present." actions={<button className="button primary" disabled={!snapshot.bots.length} onClick={() => setEditing('new')}><Icon name="plus" size={14} />New routine</button>} />
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!snapshot.routines.length && <p className="empty-note">{snapshot.bots.length ? 'No routines yet.' : 'Create a bot first, then schedule routines for it.'}</p>}
    <div className="card-list">{snapshot.routines.map(routine => <article className="card" key={routine.id} aria-label={`Routine ${routine.name}`}>
      <div className="card-head"><h3>{routine.name}</h3><Badge tone={routine.enabled ? 'good' : 'neutral'}>{routine.enabled ? 'enabled' : 'paused'}</Badge></div>
      <p className="card-meta">{botName(snapshot.bots, routine.botId)} · {describeSchedule(routine.schedule)}</p>
      <p className="card-meta">Next {formatTime(routine.nextRunAt)} · last {formatTime(routine.lastRunAt)} · missed runs: {routine.missedRunPolicy}{routine.missedRunPolicy === 'runAll' && routine.maxCatchUp ? ` (max ${routine.maxCatchUp})` : ''} · {routine.sessionMode === 'new' ? 'new session each run' : 'one session'}</p>
      <p className="card-text">{routine.prompt.slice(0, 140)}{routine.prompt.length > 140 ? '…' : ''}</p>
      <div className="row-actions"><button className="button primary" aria-label={`Run ${routine.name} now`} onClick={() => void run(routine.id, { type: 'routine.runNow', routineId: routine.id })}><Icon name="play" size={14} />Run now</button>
        <button className="button secondary" onClick={() => void run(routine.id, { type: 'routine.update', routineId: routine.id, patch: { enabled: !routine.enabled } })}>{routine.enabled ? 'Pause' : 'Resume'}</button>
        <button className="button secondary" aria-label={`Edit ${routine.name}`} onClick={() => setEditing(routine)}><Icon name="edit" size={14} />Edit</button>
        <button className="button secondary" aria-expanded={open === routine.id} onClick={() => setOpen(open === routine.id ? undefined : routine.id)}>{open === routine.id ? 'Hide runs' : 'Runs'}</button>
        <button className="button secondary" aria-label={`Delete ${routine.name}`} onClick={() => setDeleting(routine)}><Icon name="trash" size={14} /></button></div>
      {open === routine.id && <RunsList routine={routine} state={state} store={store} onReview={onReview} onOpenSession={onOpenSession} />}
    </article>)}</div>
    {editing && <RoutineEditor routine={editing === 'new' ? undefined : editing} state={state} store={store} onClose={() => setEditing(undefined)} />}
    {deleting && <Modal title="Delete routine?" onClose={() => setDeleting(undefined)}><p>“{deleting.name}” and its run history will be removed. A run in progress is cancelled.</p>
      <div className="modal-actions"><button className="button secondary" onClick={() => setDeleting(undefined)}>Keep routine</button><button className="button danger" onClick={async () => { const result = await run(deleting.id, { type: 'routine.delete', routineId: deleting.id }); if (result?.ok) setDeleting(undefined); }}>Delete routine</button></div></Modal>}
  </div>;
}
