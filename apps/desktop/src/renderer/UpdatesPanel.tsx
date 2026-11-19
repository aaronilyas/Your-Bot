import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReleaseSummary, UpdateCheckResult, UpdateInstallResult, UpdateProgress, UpdateStatus, UpdatesApi } from '../shared/ipc';
import { Badge, Icon } from './ui';

const megabytes = (bytes: number) => `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;
const day = (iso: string) => { const time = Date.parse(iso); return Number.isFinite(time) ? new Date(time).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : ''; };
const failure = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

function progressText(progress: UpdateProgress): string {
  switch (progress.phase) {
    case 'downloading': return progress.total ? `Downloading ${megabytes(progress.received ?? 0)} of ${megabytes(progress.total)}…` : 'Downloading…';
    case 'verifying': return 'Verifying the download…';
    case 'installing': return 'Installing…';
    case 'restarting': return 'Restarting Your Bot…';
  }
}

/** Settings → Updates: update to the newest release, or install any other published version (including older ones). */
export function UpdatesPanel({ api, runningTasks = 0 }: { api: UpdatesApi; runningTasks?: number }) {
  const [status, setStatus] = useState<UpdateStatus>();
  const [check, setCheck] = useState<UpdateCheckResult>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  const [chosen, setChosen] = useState('');
  const [confirming, setConfirming] = useState<string>();
  const [installing, setInstalling] = useState<string>();
  const [progress, setProgress] = useState<UpdateProgress>();
  const [outcome, setOutcome] = useState<UpdateInstallResult>();
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => api.onProgress(value => { if (alive.current) setProgress(value); }), [api]);

  const refresh = useCallback(async (force: boolean) => {
    setChecking(true); setError(undefined);
    try { const result = await api.check(force); if (alive.current) { setCheck(result); setStatus(result); } }
    catch (reason) { if (alive.current) setError(failure(reason, 'Could not check for updates.')); }
    if (alive.current) setChecking(false);
  }, [api]);
  useEffect(() => {
    void api.status().then(value => { if (alive.current) setStatus(value); }).catch(() => {});
    void refresh(false);
  }, [api, refresh]);

  const current = status?.currentVersion;
  const install = status?.install;
  const releases = check?.releases ?? [];
  const latest = releases.find(release => release.tag === check?.latest);
  const others = releases.filter(release => release.relation !== 'current');
  const selected = others.find(release => release.tag === chosen) ?? others.find(release => release.relation === 'older') ?? others[0];
  const busy = !!installing;

  async function apply(release: ReleaseSummary) {
    setConfirming(undefined); setOutcome(undefined); setCopied(false); setProgress(undefined); setInstalling(release.tag);
    try {
      const result = await api.install(release.tag);
      if (!alive.current) return;
      setOutcome(result);
      if (!result.ok) setProgress(undefined);
    } catch (reason) { if (alive.current) { setOutcome({ ok: false, message: failure(reason, 'The update failed.') }); setProgress(undefined); } }
    if (alive.current) setInstalling(undefined);
  }
  async function toggleAuto(enabled: boolean) {
    setStatus(value => value && { ...value, autoCheck: enabled });
    const saved = await api.setAutoCheck(enabled).catch(() => false);
    if (!saved && alive.current) { setStatus(value => value && { ...value, autoCheck: !enabled }); setError('Could not save the preference.'); }
  }
  async function copy(command: string) {
    try { await navigator.clipboard.writeText(command); if (alive.current) setCopied(true); } catch { /* The command is shown for manual copying. */ }
  }
  const canInstall = install?.canInstall === true;
  /** Install button, or a link to the release page when this computer cannot install that release in-app. */
  const action = (release: ReleaseSummary, label: string, primary = false) => canInstall && release.installable
    ? <button type="button" className={`button ${primary ? 'primary' : 'secondary'}`} disabled={busy} onClick={() => release.relation === 'older' ? setConfirming(release.tag) : void apply(release)}><Icon name="download" size={14} />{installing === release.tag ? 'Installing…' : label}</button>
    : <button type="button" className="button secondary" onClick={() => void api.openRelease(release.tag)}><Icon name="download" size={14} />Download page</button>;

  return <div className="settings-panel updates-panel">
    <h3 className="settings-group-title">Version</h3>
    <div className="settings-group">
      <div className="settings-row"><span><strong>Your Bot {current ?? __APP_VERSION__}</strong><span className="help">{install ? `Installed as ${install.label}.` : 'Reading install details…'}</span></span>
        <button type="button" className="button secondary" disabled={checking || busy} onClick={() => void refresh(true)}><Icon name="refresh" size={14} />{checking ? 'Checking…' : 'Check for updates'}</button></div>
      <div className="settings-row update-status" role="status">
        {checking && !check ? <span className="help">Checking for updates…</span>
          : check?.error ? <span className="inline-error">{check.error}</span>
          : check && latest && check.updateAvailable ? <span><strong>Version {latest.version} is available</strong><span className="help">{latest.publishedAt && `Released ${day(latest.publishedAt)}.`}</span></span>
          : check && latest ? <span><strong>You’re up to date</strong><span className="help">{latest.relation === 'older' ? `You are running a newer build than the latest release (${latest.version}).` : `${latest.version} is the latest release.`}</span></span>
          : check ? <span className="help">No releases have been published yet.</span> : null}
        {check && latest && check.updateAvailable && <div className="agent-actions">{action(latest, `Update to ${latest.version}`, true)}<button type="button" className="button text" onClick={() => void api.openRelease(latest.tag)}>Release notes</button></div>}
      </div>
      {check && latest && check.updateAvailable && latest.notes && <details className="update-notes"><summary>What’s new in {latest.version}</summary><pre>{latest.notes}</pre></details>}
      {status && <label className="settings-row"><span><strong>Check automatically</strong><span className="help">Looks for a new release on GitHub when Your Bot starts. Nothing about you, your bots or your conversations is sent.</span></span><input type="checkbox" role="switch" className="switch" checked={status.autoCheck} onChange={event => void toggleAuto(event.target.checked)} /></label>}
    </div>
    {install && !install.canInstall && <p className="warning-inline" role="note">{install.reason ?? 'This copy of Your Bot cannot update itself.'} Use <strong>Download page</strong> to get another version.</p>}
    {runningTasks > 0 && canInstall && <p className="warning-inline" role="note">A task is running. Installing another version restarts Your Bot and stops it.</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {progress && <div className="update-progress" role="status"><span>{progressText(progress)}</span>{progress.phase === 'downloading' && progress.total ? <progress max={progress.total} value={progress.received ?? 0} /> : <progress />}</div>}
    {outcome && <div role="status" className={`agent-note ${outcome.ok ? 'good' : 'bad'}`}>{outcome.message}
      {outcome.command && <div className="update-command"><code>{outcome.command}</code><button type="button" className="button secondary small" onClick={() => void copy(outcome.command!)}><Icon name={copied ? 'check' : 'copy'} size={13} />{copied ? 'Copied' : 'Copy'}</button></div>}
      {outcome.output && <details><summary>Output</summary><pre className="agent-output">{outcome.output}</pre></details>}</div>}

    <h3 className="settings-group-title updates-other-title">Other versions</h3>
    <div className="settings-group">
      {others.length === 0 ? <div className="settings-row"><span className="help">{check ? 'No other published versions.' : 'Versions appear after checking for updates.'}</span></div>
        : <><label className="settings-row"><span><strong>Version</strong><span className="help">Go back to an earlier release if a new one causes problems, or try a newer one.</span></span>
          <select aria-label="Version to install" value={selected?.tag ?? ''} disabled={busy} onChange={event => { setChosen(event.target.value); setConfirming(undefined); }}>
            {others.map(release => <option key={release.tag} value={release.tag}>{release.version}{release.prerelease ? ' (pre-release)' : ''}{release.relation === 'older' ? ' · older' : ' · newer'}{release.publishedAt ? ` · ${day(release.publishedAt)}` : ''}</option>)}
          </select></label>
          {selected && <div className="settings-row"><span className="help">{selected.prerelease && <Badge tone="warn">Pre-release</Badge>} {selected.installable ? `${selected.name}` : `No installer for this computer in ${selected.version}.`}</span>
            <div className="agent-actions">{action(selected, selected.relation === 'older' ? `Revert to ${selected.version}` : `Install ${selected.version}`)}</div></div>}</>}
    </div>
    {selected && confirming === selected.tag && <div className="warning-inline update-confirm" role="alertdialog" aria-label={`Revert to ${selected.version}?`}>
      <p><strong>Revert to {selected.version}?</strong> Your Bot will restart on the older version. Your bots, conversations and settings stay where they are, but an older version may not understand data saved by a newer one. You can update again at any time.</p>
      <div className="agent-actions"><button type="button" className="button secondary" onClick={() => setConfirming(undefined)}>Cancel</button><button type="button" className="button danger" onClick={() => void apply(selected)}>Revert to {selected.version}</button></div>
    </div>}
    <p className="help">Releases come from the project’s GitHub page. Each download is checked against the release’s published SHA-256 checksums before it is installed.</p>
  </div>;
}
