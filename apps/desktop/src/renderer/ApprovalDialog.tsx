import { inertEnvironment } from '@your-bot/contracts';
import { useState } from 'react';
import type { Bot, PermissionRequestV2, Routine, RoutineRun, StandingGrantScope } from '@your-bot/contracts';
import type { DesktopStore } from './store';
import { Icon, Modal } from './ui';
import { argvOf, defaultStandingScope, standingDecision, standingKind, standingScopeError } from './standing';

const EXPIRY: { label: string; ms?: number }[] = [{ label: 'Never expires' }, { label: '1 hour', ms: 3_600_000 }, { label: '24 hours', ms: 86_400_000 }, { label: '7 days', ms: 604_800_000 }, { label: '30 days', ms: 2_592_000_000 }];

export function RequestDetails({ request, run, routine }: { request: PermissionRequestV2; run?: RoutineRun; routine?: Routine }) {
  return <>
    {request.paths?.length ? <div className="scope-list"><h3>Exact file access</h3>{request.paths.map((path, index) => <div className="scope" key={index}><span className="tag">{path.access}</span><code>{path.path}</code></div>)}</div> : null}
    {request.packages?.length ? <div className="scope-list"><h3>Packages to install</h3>{request.packages.map((name, index) => <code className="package" key={index}>{name}</code>)}</div> : null}
    {request.command && <div className="scope-list"><h3>Command</h3>
      <div className="argv" aria-label="Command arguments">{argvOf(request).map((token, index) => <code className="argv-token" key={index}>{token}</code>)}</div>
      <div className="scope"><span className="tag">cwd</span><code>{request.command.cwd}</code></div>
      {request.command.env?.length ? <div className="scope"><span className="tag">env</span><code>{request.command.env.map(entry => entry.name).join(', ')}</code></div> : null}
      {request.command.env?.some(entry => !inertEnvironment(entry)) ? <p className="help">This command sets environment variables that can change what runs, so it can only be approved for now, never always.</p> : null}</div>}
    {request.mcp && <div className="scope-list"><h3>MCP tool call</h3><div className="scope"><span className="tag">server</span><code>{request.mcp.serverId}</code></div><div className="scope"><span className="tag">tool</span><code>{request.mcp.tool}</code></div></div>}
    {request.agentTool && <div className="scope-list"><h3>Agent tool</h3><div className="scope"><span className="tag">tool</span><code>{request.agentTool.title}</code></div>{request.agentTool.kind && <div className="scope"><span className="tag">kind</span><code>{request.agentTool.kind}</code></div>}</div>}
    {request.routineRunId && <div className="scope-list"><h3>Routine run</h3><div className="scope"><span className="tag">routine</span><code>{routine?.name ?? 'Unknown routine'}</code></div><div className="scope"><span className="tag">run</span><code>{run?.id ?? request.routineRunId}{run ? ` · ${run.trigger}` : ''}</code></div></div>}
  </>;
}

function StandingPanel({ request, bot, store, onCancel }: { request: PermissionRequestV2; bot?: Bot; store: DesktopStore; onCancel: () => void }) {
  const kind = standingKind(request)!;
  const initial = defaultStandingScope(request);
  const [folder, setFolder] = useState(initial?.folder ?? '');
  const [prefix, setPrefix] = useState<string[]>(initial?.commandPrefix ?? []);
  const [mcpAll, setMcpAll] = useState(false);
  const [expiry, setExpiry] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const argv = argvOf(request);
  const scope: StandingGrantScope = kind === 'folder' ? { folder: folder.trim() }
    : kind === 'command' ? { commandPrefix: prefix }
    : kind === 'mcp' ? { mcp: mcpAll ? { serverId: request.mcp!.serverId } : { serverId: request.mcp!.serverId, tool: request.mcp!.tool } }
    : { agentToolKind: request.agentTool!.kind! };
  const problem = standingScopeError(request, scope, bot);
  async function confirm() {
    if (problem) return;
    setSending(true); setError(undefined);
    const ms = EXPIRY[expiry].ms;
    const result = await store.command({ type: 'permission.decide', decision: standingDecision(request, scope, ms ? new Date(Date.now() + ms).toISOString() : undefined) });
    if (!result?.ok) setError(result && !result.ok ? result.error.message : 'Could not send your decision. Reconnect and try again.');
    setSending(false);
  }
  return <section className="standing-panel" aria-label="Always allow">
    <h3>Always allow for {bot?.name ?? 'this bot'}</h3>
    <p className="help">This creates a standing grant: matching requests will be allowed without asking, and every one is recorded in the audit log. Revoke it any time under Permissions.</p>
    {kind === 'folder' && <label>Folder<input value={folder} spellCheck={false} onChange={event => setFolder(event.target.value)} /></label>}
    {kind === 'folder' && <p className="help">Applies to this folder and everything beneath it, for {request.capability} only.</p>}
    {kind === 'command' && <div className="prefix-editor"><span className="field-label">Command prefix (argv tokens)</span>
      {prefix.map((token, index) => <input key={index} aria-label={`Prefix token ${index + 1}`} value={token} spellCheck={false} onChange={event => setPrefix(current => current.map((item, i) => i === index ? event.target.value : item))} />)}
      <div className="row-actions"><button type="button" className="button secondary" disabled={prefix.length >= argv.length} onClick={() => setPrefix(argv.slice(0, prefix.length + 1))}>Add next token</button><button type="button" className="button secondary" disabled={prefix.length <= 1} onClick={() => setPrefix(prefix.slice(0, -1))}>Remove last token</button></div>
      <p className="help">Any command that starts with these exact tokens is allowed, with any further arguments.</p></div>}
    {kind === 'mcp' && <fieldset className="radio-group"><legend>Scope</legend>
      <label className="choice"><input type="radio" name="mcp-scope" checked={!mcpAll} onChange={() => setMcpAll(false)} />Only the “{request.mcp!.tool}” tool on {request.mcp!.serverId}</label>
      <label className="choice"><input type="radio" name="mcp-scope" checked={mcpAll} onChange={() => setMcpAll(true)} />Every tool on {request.mcp!.serverId}</label></fieldset>}
    {kind === 'tool' && <p>Every agent tool request of kind <code>{request.agentTool!.kind}</code> from this bot.</p>}
    <label>Expires<select value={expiry} onChange={event => setExpiry(Number(event.target.value))}>{EXPIRY.map((option, index) => <option key={option.label} value={index}>{option.label}</option>)}</select></label>
    {problem && <p className="inline-error" role="alert">{problem}</p>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    <div className="row-actions end"><button type="button" className="button secondary" disabled={sending} onClick={onCancel}>Back</button><button type="button" className="button primary" disabled={sending || Boolean(problem)} onClick={() => void confirm()}>Always allow</button></div>
  </section>;
}

export function ApprovalDialog({ request, bot, sessionTitle, run, routine, store, onClose }: { request: PermissionRequestV2; bot?: Bot; sessionTitle: string; run?: RoutineRun; routine?: Routine; store: DesktopStore; onClose?: () => void }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [standing, setStanding] = useState(false);
  const canStand = standingKind(request) !== undefined && defaultStandingScope(request) !== undefined;
  async function decide(outcome: 'allow' | 'deny', scope: 'once' | 'task') {
    setSending(true); setError(undefined);
    const result = await store.command({ type: 'permission.decide', decision: { requestId: request.id, outcome, scope } });
    if (!result?.ok) setError(result && !result.ok ? result.error.message : 'Could not send your decision. Reconnect and try again.');
    setSending(false);
  }
  return <Modal title="Your permission is needed" onClose={onClose}>
    <div className="permission-intro"><span className="permission-icon"><Icon name="shield" size={25} /></span><div><strong>{request.capability}</strong><p>{bot ? <span className="bot-ref">{bot.name}</span> : null}{bot ? ' · ' : ''}{sessionTitle}</p></div></div>
    <pre className="permission-reason">{request.reason}</pre>
    <RequestDetails request={request} run={run} routine={routine} />
    <p className="help">Approval applies only to this request’s operation and exact scope. Task approval expires when this task ends.</p>
    {error && <p role="alert" className="inline-error">{error}</p>}
    {standing ? <StandingPanel request={request} bot={bot} store={store} onCancel={() => setStanding(false)} /> : <div className="permission-actions">
      {canStand && <button className="button text push-left" disabled={sending} onClick={() => setStanding(true)}>Always allow…</button>}
      <button className="button secondary" disabled={sending} onClick={() => void decide('deny', 'once')}>Deny</button><button className="button secondary" disabled={sending} onClick={() => void decide('allow', 'task')}>Allow for this task</button><button className="button primary" disabled={sending} onClick={() => void decide('allow', 'once')}>Allow once</button></div>}
  </Modal>;
}
