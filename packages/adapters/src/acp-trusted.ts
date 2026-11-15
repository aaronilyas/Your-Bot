import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type {
  AgentRunContext, AgentRunContextV2, ChatMessage, JsonValue, ModelInfo, SessionV2,
} from '@your-bot/contracts';
import { modelSelector, sessionModels } from './acp-models.js';
import { AdapterError, normalizeAdapterError, record } from './errors.js';
import type { HostedAgent, HostLauncher } from './host-launcher.js';
import { abortable, RunManager, type RunScope, throwIfAborted } from './lifecycle.js';
import { ClientRpcError, InvalidParams, MethodNotFound, StdioRpc } from './rpc.js';
import { parseToolInvocation } from './tools.js';

const STOP_REASONS = new Set(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']);
const HOST_METHODS = new Set([
  'fs/read_text_file', 'fs/write_text_file', 'terminal/create', 'terminal/output',
  'terminal/wait_for_exit', 'terminal/kill', 'terminal/release',
]);

export interface TrustedAcpDeps {
  enabled: boolean;
  command: string;
  args: readonly string[];
  envPassthrough: readonly string[];
  host: HostLauncher;
  runs: RunManager;
  shutdownMs: number;
  maxMessageBytes: number;
  maxOutputBytes: number;
  maxToolCalls: number;
  modelId?: string;
  getModels(): ModelInfo[];
  setModels(models: ModelInfo[]): void;
}

interface ContinuityState { acpSessionId: string; cwd: string; instructionsHash: string; }

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asTrusted(context: AgentRunContext | AgentRunContextV2): AgentRunContextV2 {
  const candidate = context as AgentRunContextV2;
  if (candidate.profile !== 'trusted') throw new AdapterError('PROFILE_UNSUPPORTED', 'Host-launched ACP refuses a strict run.');
  if (typeof candidate.workspace !== 'string' || !candidate.workspace || !isAbsolute(candidate.workspace)) {
    throw new AdapterError('INVALID_CONFIG', 'Trusted ACP requires an absolute workspace.');
  }
  if (!candidate.state || typeof candidate.state.get !== 'function' || typeof candidate.state.set !== 'function') {
    throw new AdapterError('INVALID_CONFIG', 'Trusted ACP requires adapter state.');
  }
  if (candidate.instructions !== undefined && typeof candidate.instructions !== 'string') {
    throw new AdapterError('INVALID_CONFIG', 'Trusted ACP instructions must be a string.');
  }
  return candidate;
}

function instructionsHash(instructions: string | undefined): string {
  return createHash('sha256').update(instructions ?? '', 'utf8').digest('hex');
}

function readContinuity(value: JsonValue | undefined): ContinuityState | undefined {
  const stored = asObject(value);
  if (!stored) return undefined;
  const { acpSessionId, cwd, instructionsHash: hash } = stored;
  if (typeof acpSessionId !== 'string' || !acpSessionId || typeof cwd !== 'string' || !cwd || typeof hash !== 'string') return undefined;
  return { acpSessionId, cwd, instructionsHash: hash };
}

function rejectionCode(error: unknown): string {
  const code = asObject(error)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'HOST_FAILURE';
}

function optionalCount(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new InvalidParams();
  return value;
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new InvalidParams();
  return value as string[];
}

function envList(value: unknown): { name: string; value: string }[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new InvalidParams();
  return value.map(item => {
    const row = asObject(item);
    if (!row || typeof row.name !== 'string' || typeof row.value !== 'string') throw new InvalidParams();
    return { name: row.name, value: row.value };
  });
}

function transcript(session: SessionV2): string {
  const history = session.messages;
  const body = history.length === 1 && history[0].role === 'user'
    ? history[0].content
    : `Conversation transcript (role labels are context):\n${history.map(message => `${message.role}: ${message.content}`).join('\n\n')}\n\nRespond to the latest user message.`;
  return session.summary ? `Earlier conversation summary:\n${session.summary}\n\n${body}` : body;
}

function newestUser(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return messages[index].content;
  }
  return messages.length > 0 ? messages[messages.length - 1].content : 'Continue.';
}

function supports(capabilities: unknown, path: readonly string[]): boolean {
  let current = asObject(capabilities);
  for (const key of path) {
    if (!current) return false;
    const next = current[key];
    if (key === path[path.length - 1]) return path[path.length - 1] === 'systemPrompt' ? !!asObject(next) : next === true;
    current = asObject(next);
  }
  return false;
}

async function terminateAgent(agent: HostedAgent, shutdownMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new AdapterError('HARNESS_EXIT', 'Host agent process tree did not terminate.', true)), shutdownMs);
  try { await abortable(agent.terminate(), controller.signal); }
  catch { throw new AdapterError('HARNESS_EXIT', 'Host agent process tree did not terminate.', true); }
  finally { clearTimeout(timer); }
}

async function selectModel(rpc: StdioRpc, scope: RunScope, sessionId: string, result: Record<string, unknown>, requested: string | undefined, setModels: (models: ModelInfo[]) => void): Promise<void> {
  const selector = modelSelector(result.configOptions);
  // Agents without a model configOption may report session models instead (Grok Build).
  const listed = selector ? undefined : sessionModels(result.models);
  if (selector) setModels(selector.models);
  else if (listed) setModels(listed.models);
  if (!requested) return;
  if (listed) {
    if (!listed.models.some(item => item.id === requested)) throw new AdapterError('MODEL_UNAVAILABLE', 'Harness did not advertise the requested model.');
    if (listed.current === requested) return;
    // set_model has no standard confirmation payload; a JSON-RPC error means it was not applied.
    await abortable(rpc.request('session/set_model', { sessionId, modelId: requested }), scope.signal);
    return;
  }
  if (!selector || !selector.models.some(item => item.id === requested)) throw new AdapterError('MODEL_UNAVAILABLE', 'Harness did not advertise the requested model.');
  if (selector.current === requested) return;
  const changed = record(await abortable(rpc.request('session/set_config_option', { sessionId, configId: selector.id, value: requested }), scope.signal));
  const confirmed = modelSelector(changed.configOptions);
  if (!confirmed || confirmed.current !== requested) throw new AdapterError('MODEL_UNAVAILABLE', 'Harness did not confirm the requested model.');
  setModels(confirmed.models);
}

/** Trusted profile: uncontained agent CLI, with fs/terminal/permission mediated by core. */
export async function runTrustedAcp(deps: TrustedAcpDeps, input: AgentRunContext | AgentRunContextV2): Promise<void> {
  if (!deps.enabled) throw new AdapterError('DISABLED', 'Provider is disabled.');
  if (!deps.command) throw new AdapterError('INVALID_CONFIG', 'ACP command is missing.');
  const context = asTrusted(input);
  const scope = deps.runs.begin(context.taskId, context.signal);
  let agent: HostedAgent | undefined;
  let rpc: StdioRpc | undefined;
  let sessionId: string | undefined;
  let activeTurn = false;
  let acceptHost = false;
  let toolCalls = 0;
  const toolIds = new Set<string>();
  const onAbort = () => {
    if (sessionId && rpc) {
      try { rpc.notify('session/cancel', { sessionId }); } catch { /* transport may have failed */ }
    }
  };
  const requireSession = (params: Record<string, unknown>) => {
    if (!sessionId || params.sessionId !== sessionId || !acceptHost) throw new InvalidParams();
  };
  const callHost = async <T>(operation: Promise<T>): Promise<T> => {
    try { return await scope.excludeTimeout(abortable(operation, scope.signal)); }
    catch (error) {
      if (scope.signal.aborted || (error instanceof AdapterError && error.code === 'CANCELLED')) {
        throw new ClientRpcError('Client request failed', { code: 'CANCELLED' });
      }
      throw new ClientRpcError('Client request failed', { code: rejectionCode(error) });
    }
  };
  try {
    throwIfAborted(scope.signal);
    const launch = deps.host.launch({
      command: deps.command, args: [...deps.args], cwd: context.workspace!,
      envPassthrough: deps.envPassthrough, signal: scope.signal,
    });
    try { agent = await abortable(launch, scope.signal); }
    catch (error) {
      void launch.then(late => terminateAgent(late, deps.shutdownMs)).catch(() => {});
      throw error;
    }
    scope.signal.addEventListener('abort', onAbort, { once: true });
    const request = async (method: string, raw: unknown): Promise<unknown> => {
      let params: Record<string, unknown>;
      try { params = record(raw); } catch { throw new InvalidParams(); }
      if (method === '_your_bot/execute_tool' || method === 'session/request_permission') {
        requireSession(params);
        if (!activeTurn) throw new InvalidParams();
        if (scope.signal.aborted && method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } };
        if (++toolCalls > deps.maxToolCalls) throw new AdapterError('TOOL_LIMIT', 'Harness exceeded the tool call limit.');
        if (method === '_your_bot/execute_tool') {
          throwIfAborted(scope.signal);
          if (typeof params.toolCallId !== 'string' || toolIds.has(params.toolCallId)) throw new InvalidParams();
          const invocation = parseToolInvocation('execute_tool', params.arguments, params.toolCallId);
          toolIds.add(params.toolCallId);
          context.emit({ type: 'status', status: `Executing tool ${invocation.kind}` });
          return abortable(context.executeTool(invocation), scope.signal);
        }
        let call: Record<string, unknown>;
        try { call = record(params.toolCall); } catch { throw new InvalidParams(); }
        if (typeof call.toolCallId !== 'string' || !Array.isArray(params.options)) throw new InvalidParams();
        const options = params.options.map(item => record(item));
        if (options.some(option => typeof option.optionId !== 'string' || typeof option.kind !== 'string')) throw new InvalidParams();
        const allow = options.find(option => option.kind === 'allow_once');
        const reject = options.find(option => option.kind === 'reject_once');
        const title = typeof call.title === 'string' && call.title ? call.title : 'Agent tool';
        try {
          const decision = await scope.excludeTimeout(abortable(context.requestPermission({
            capability: 'tool.execute',
            reason: title,
            agentTool: {
              toolCallId: call.toolCallId,
              title,
              ...(typeof call.kind === 'string' ? { kind: call.kind } : {}),
            },
            ...(context.bot?.id ? { botId: context.bot.id } : {}),
          }), scope.signal));
          throwIfAborted(scope.signal);
          if (decision.outcome === 'allow' && allow) return { outcome: { outcome: 'selected', optionId: allow.optionId } };
        } catch (error) {
          if (scope.signal.aborted) return { outcome: { outcome: 'cancelled' } };
          if (error instanceof AdapterError && error.code === 'TOOL_LIMIT') throw error;
        }
        if (scope.signal.aborted || !reject) return { outcome: { outcome: 'cancelled' } };
        return { outcome: { outcome: 'selected', optionId: reject.optionId } };
      }
      if (!context.host || !HOST_METHODS.has(method)) throw new MethodNotFound();
      requireSession(params);
      if (method === 'fs/read_text_file') {
        if (typeof params.path !== 'string') throw new InvalidParams();
        const line = optionalCount(params.line);
        const limit = optionalCount(params.limit);
        const read = await callHost(context.host.readTextFile({ path: params.path, ...(line !== undefined ? { line } : {}), ...(limit !== undefined ? { limit } : {}) }));
        if (!read || typeof read.content !== 'string') throw new ClientRpcError('Client request failed', { code: 'HOST_FAILURE' });
        return { content: read.content };
      }
      if (method === 'fs/write_text_file') {
        if (typeof params.path !== 'string' || typeof params.content !== 'string') throw new InvalidParams();
        await callHost(context.host.writeTextFile({ path: params.path, content: params.content }));
        return null;
      }
      if (method === 'terminal/create') {
        if (typeof params.command !== 'string' || !params.command) throw new InvalidParams();
        const args = stringList(params.args);
        const env = envList(params.env);
        const cwd = params.cwd === undefined || params.cwd === null ? undefined : params.cwd;
        if (cwd !== undefined && typeof cwd !== 'string') throw new InvalidParams();
        const outputByteLimit = optionalCount(params.outputByteLimit);
        const created = await callHost(context.host.createTerminal({
          command: params.command,
          ...(args ? { args } : {}),
          ...(env ? { env } : {}),
          ...(cwd ? { cwd } : {}),
          ...(outputByteLimit !== undefined ? { outputByteLimit } : {}),
        }));
        if (!created || typeof created.terminalId !== 'string' || !created.terminalId) throw new ClientRpcError('Client request failed', { code: 'HOST_FAILURE' });
        return { terminalId: created.terminalId };
      }
      if (typeof params.terminalId !== 'string' || !params.terminalId) throw new InvalidParams();
      if (method === 'terminal/output') {
        const output = await callHost(context.host.terminalOutput(params.terminalId));
        if (!output || typeof output.output !== 'string' || typeof output.truncated !== 'boolean') throw new ClientRpcError('Client request failed', { code: 'HOST_FAILURE' });
        const status = output.exitStatus;
        if (status && status.exitCode !== null && typeof status.exitCode !== 'number') throw new ClientRpcError('Client request failed', { code: 'HOST_FAILURE' });
        if (status && status.signal !== null && typeof status.signal !== 'string') throw new ClientRpcError('Client request failed', { code: 'HOST_FAILURE' });
        return { output: output.output, truncated: output.truncated, ...(status ? { exitStatus: { exitCode: status.exitCode, signal: status.signal } } : {}) };
      }
      if (method === 'terminal/wait_for_exit') {
        const status = await callHost(context.host.waitForTerminalExit(params.terminalId));
        if (!status || (status.exitCode !== null && typeof status.exitCode !== 'number') || (status.signal !== null && typeof status.signal !== 'string')) {
          throw new ClientRpcError('Client request failed', { code: 'HOST_FAILURE' });
        }
        return { exitCode: status.exitCode, signal: status.signal };
      }
      if (method === 'terminal/kill') { await callHost(context.host.killTerminal(params.terminalId)); return null; }
      await callHost(context.host.releaseTerminal(params.terminalId));
      return null;
    };
    rpc = new StdioRpc(agent.process, deps.maxMessageBytes, deps.maxOutputBytes, (method, raw) => {
      if (method !== 'session/update' || scope.signal.aborted || !activeTurn) return;
      const params = record(raw);
      if (params.sessionId !== sessionId) throw new AdapterError('INVALID_RESPONSE', 'Harness update referenced the wrong session.');
      const update = record(params.update);
      if (update.sessionUpdate === 'agent_message_chunk') {
        const content = record(update.content);
        if (content.type === 'text') {
          if (typeof content.text !== 'string') throw new AdapterError('INVALID_RESPONSE', 'Harness returned invalid text content.');
          context.emit({ type: 'text', text: content.text });
        }
      } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        if (update.status !== undefined && typeof update.status !== 'string') throw new AdapterError('INVALID_RESPONSE', 'Harness returned invalid tool status.');
        context.emit({ type: 'status', status: `Harness tool ${typeof update.status === 'string' ? update.status : 'pending'}` });
      } else if (update.sessionUpdate === 'plan') context.emit({ type: 'status', status: 'Harness is planning' });
    }, request, error => scope.abort(error));
    const initialized = record(await abortable(rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: !!context.host, writeTextFile: !!context.host },
        terminal: !!context.host,
        _meta: { 'your-bot/execute-tool': true },
      },
      clientInfo: { name: 'your-bot', version: '0.1.0' },
    }), scope.signal));
    if (initialized.protocolVersion !== 1) throw new AdapterError('ACP_VERSION', 'Harness does not support ACP protocol version 1.');
    const capabilities = initialized.agentCapabilities;
    const httpMcp = supports(capabilities, ['mcpCapabilities', 'http']);
    const canLoad = supports(capabilities, ['loadSession']);
    const systemPrompt = supports(capabilities, ['sessionCapabilities', 'systemPrompt']);
    const servers = !context.mcp ? [] : httpMcp ? [{
      type: 'http', name: context.mcp.name, url: context.mcp.url,
      headers: context.mcp.headers.map(header => ({ name: header.name, value: header.value })),
    }] : (context.emit({ type: 'status', status: 'Agent does not advertise HTTP MCP; omitting MCP servers.' }), []);
    const hash = instructionsHash(context.instructions);
    const stored = readContinuity(await abortable(context.state.get(), scope.signal));
    const sameWorkspace = stored?.cwd === context.workspace;
    const instructions = context.instructions ?? '';
    let loaded = false;
    let sessionResult: Record<string, unknown> = {};
    if (canLoad && stored && sameWorkspace) {
      sessionId = stored.acpSessionId;
      acceptHost = true;
      try {
        const result = record(await abortable(rpc.request('session/load', {
          sessionId, cwd: context.workspace, mcpServers: servers,
          ...(systemPrompt && instructions && stored.instructionsHash !== hash
            ? { systemPrompt: { mode: 'append', content: [{ type: 'text', text: instructions }] } } : {}),
        }), scope.signal));
        loaded = true;
        sessionResult = result;
      } catch (error) {
        sessionId = undefined;
        acceptHost = false;
        if (scope.signal.aborted) throw error;
        if (!(error instanceof AdapterError) || (error.code !== 'ACP_RPC_ERROR' && error.code !== 'INVALID_RESPONSE')) throw error;
      }
    }
    const deliverInPrompt = !systemPrompt && instructions.length > 0 && (!loaded || stored?.instructionsHash !== hash);
    const deliverInSystem = systemPrompt && instructions.length > 0 && !loaded;
    if (!loaded) {
      const created = record(await abortable(rpc.request('session/new', {
        cwd: context.workspace, mcpServers: servers,
        ...(deliverInSystem ? { systemPrompt: { mode: 'append', content: [{ type: 'text', text: instructions }] } } : {}),
      }), scope.signal));
      if (typeof created.sessionId !== 'string' || !created.sessionId) throw new AdapterError('INVALID_RESPONSE', 'Harness returned an invalid session ID.');
      sessionId = created.sessionId;
      acceptHost = true;
      sessionResult = created;
    }
    await selectModel(rpc, scope, sessionId!, sessionResult, context.session.modelId ?? deps.modelId, deps.setModels);
    const appliedHash = deliverInPrompt ? (loaded ? stored?.instructionsHash ?? '' : '') : hash;
    await abortable(context.state.set({ acpSessionId: sessionId!, cwd: context.workspace!, instructionsHash: appliedHash }), scope.signal);
    const body = loaded ? newestUser(context.session.messages) : transcript(context.session);
    const prompt = deliverInPrompt ? `Standing instructions:\n${instructions}\n\n${body}` : body;
    activeTurn = true;
    const completed = record(await abortable(rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }), scope.signal));
    activeTurn = false;
    throwIfAborted(scope.signal);
    if (deliverInPrompt) {
      await abortable(context.state.set({ acpSessionId: sessionId!, cwd: context.workspace!, instructionsHash: hash }), scope.signal);
    }
    if (typeof completed.stopReason !== 'string' || !STOP_REASONS.has(completed.stopReason)) throw new AdapterError('INVALID_RESPONSE', 'Harness returned an invalid stop reason.');
    if (completed.stopReason === 'cancelled') throw new AdapterError('CANCELLED', 'Agent task was cancelled.');
    if (completed.stopReason !== 'end_turn') throw new AdapterError('INCOMPLETE_COMPLETION', 'Harness could not complete the response.');
  } catch (error) { throw normalizeAdapterError(error, scope.signal); }
  finally {
    activeTurn = false;
    acceptHost = false;
    scope.signal.removeEventListener('abort', onAbort);
    scope.abort(new AdapterError('CLOSED', 'Harness turn has ended.'));
    try { if (agent) await terminateAgent(agent, deps.shutdownMs); }
    finally { rpc?.dispose(); scope.finish(); }
  }
}
