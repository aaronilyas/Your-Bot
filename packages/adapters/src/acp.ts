import { isAbsolute } from 'node:path';
import type { AgentAdapter, AgentInfo, AgentRunContext, ModelInfo, ProviderConfig } from '@your-bot/contracts';
import { modelSelector } from './acp-models.js';
import type { ContainedHarness, ContainmentLauncher } from './containment.js';
import { AdapterError, normalizeAdapterError, positiveInteger, record } from './errors.js';
import { abortable, RunManager, throwIfAborted } from './lifecycle.js';
import { InvalidParams, MethodNotFound, StdioRpc } from './rpc.js';
import { parseToolInvocation } from './tools.js';

export interface AcpAdapterOptions {
  /** Trusted host injection; without it, ACP fails closed and no process is spawned. */
  launcher?: ContainmentLauncher;
  timeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxMessageBytes?: number;
  maxOutputBytes?: number;
  maxToolCalls?: number;
}

const STOP_REASONS = new Set(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']);

export class AcpAdapter implements AgentAdapter {
  readonly id: string;
  private readonly config: ProviderConfig;
  private readonly launcher?: ContainmentLauncher;
  private readonly runs: RunManager;
  private readonly shutdownMs: number;
  private readonly maxMessageBytes: number;
  private readonly maxOutputBytes: number;
  private readonly maxToolCalls: number;
  private models: ModelInfo[];

  constructor(config: ProviderConfig, options: AcpAdapterOptions = {}) {
    if (config.kind !== 'acp') throw new AdapterError('INVALID_CONFIG', 'ACP adapter requires an ACP provider.');
    this.config = { ...config, args: config.args ? [...config.args] : undefined };
    this.id = config.id;
    this.launcher = options.launcher;
    this.runs = new RunManager(positiveInteger(options.timeoutMs ?? 120_000, 'timeoutMs'));
    this.shutdownMs = positiveInteger(options.shutdownTimeoutMs ?? 5_000, 'shutdownTimeoutMs');
    this.maxMessageBytes = positiveInteger(options.maxMessageBytes ?? 1_048_576, 'maxMessageBytes');
    this.maxOutputBytes = positiveInteger(options.maxOutputBytes ?? 16_777_216, 'maxOutputBytes');
    this.maxToolCalls = positiveInteger(options.maxToolCalls ?? 64, 'maxToolCalls');
    this.models = config.modelId ? [{ id: config.modelId, name: config.modelId }] : [];
  }

  async getInfo(): Promise<AgentInfo> {
    this.runs.assertOpen();
    const limitation = !this.config.enabled ? 'Provider is disabled.' : !this.launcher ? 'ACP requires an enforced OS containment launcher.' : !this.config.command ? 'ACP command is missing.' : undefined;
    return {
      id: this.id, name: this.config.name, kind: 'acp', available: !limitation,
      models: this.models.map(model => ({ ...model })),
      ...(limitation ? { limitation } : {}),
    };
  }

  private async terminate(harness: ContainedHarness): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new AdapterError('CONTAINMENT_FAILURE', 'Containment launcher did not terminate the harness.')), this.shutdownMs);
    try { await abortable(harness.terminate(), controller.signal); }
    catch { throw new AdapterError('CONTAINMENT_FAILURE', 'Containment launcher could not confirm complete harness termination.'); }
    finally { clearTimeout(timer); }
  }

  async run(context: AgentRunContext): Promise<void> {
    if (!this.config.enabled) throw new AdapterError('DISABLED', 'Provider is disabled.');
    if (!this.launcher) throw new AdapterError('CONTAINMENT_UNAVAILABLE', 'ACP requires an enforced OS containment launcher.');
    if (!this.config.command) throw new AdapterError('INVALID_CONFIG', 'ACP command is missing.');
    const scope = this.runs.begin(context.taskId, context.signal);
    let harness: ContainedHarness | undefined;
    let rpc: StdioRpc | undefined;
    let sessionId: string | undefined;
    let activeTurn = false;
    let toolCalls = 0;
    const toolIds = new Set<string>();
    const onAbort = () => {
      if (sessionId && rpc) {
        try { rpc.notify('session/cancel', { sessionId }); } catch { /* transport may have failed */ }
      }
    };
    try {
      throwIfAborted(scope.signal);
      const launch = this.launcher.launch({ command: this.config.command, args: [...(this.config.args ?? [])], signal: scope.signal });
      try { harness = await abortable(launch, scope.signal); }
      catch (error) {
        // If a buggy launcher resolves after abort, still retire its unclaimed handle.
        void launch.then(late => this.terminate(late)).catch(() => {});
        throw error;
      }
      if (!isAbsolute(harness.cwd)) throw new AdapterError('CONTAINMENT_FAILURE', 'Containment launcher returned an invalid sandbox directory.');
      scope.signal.addEventListener('abort', onAbort, { once: true });
      const request = async (method: string, raw: unknown): Promise<unknown> => {
        if (method !== 'session/request_permission' && method !== '_your_bot/execute_tool') throw new MethodNotFound();
        let params: Record<string, unknown>;
        try { params = record(raw); } catch { throw new InvalidParams(); }
        if (!sessionId || params.sessionId !== sessionId) throw new InvalidParams();
        if (method === 'session/request_permission' && scope.signal.aborted) return { outcome: { outcome: 'cancelled' } };
        if (!activeTurn) throw new InvalidParams();
        if (++toolCalls > this.maxToolCalls) throw new AdapterError('TOOL_LIMIT', 'Harness exceeded the tool call limit.');
        if (method === '_your_bot/execute_tool') {
          throwIfAborted(scope.signal);
          if (typeof params.toolCallId !== 'string' || toolIds.has(params.toolCallId)) throw new InvalidParams();
          const invocation = parseToolInvocation('execute_tool', params.arguments, params.toolCallId);
          toolIds.add(params.toolCallId);
          context.emit({ type: 'status', status: `Executing tool ${invocation.kind}` });
          return abortable(context.executeTool(invocation), scope.signal);
        }
        // Standard ACP tool calls execute IN the harness. Authorization alone cannot
        // make them safe: only a trusted containment-specific enforcement plan can.
        const cancelled = { outcome: { outcome: 'cancelled' } };
        if (scope.signal.aborted) return cancelled;
        let call: Record<string, unknown>;
        try { call = record(params.toolCall); } catch { throw new InvalidParams(); }
        if (typeof call.toolCallId !== 'string' || !Array.isArray(params.options)) throw new InvalidParams();
        const options = params.options.map(item => record(item));
        if (options.some(option => typeof option.optionId !== 'string' || typeof option.kind !== 'string')) throw new InvalidParams();
        const reject = options.find(option => option.kind === 'reject_once');
        const allow = options.find(option => option.kind === 'allow_once');
        // Never choose allow_always/reject_always: frozen core grants are once/task.
        try {
          const plan = harness?.preparePermission
            ? await abortable(harness.preparePermission(call, scope.signal), scope.signal) : undefined;
          if (plan && allow) {
            const decision = await abortable(context.requestPermission(plan.request), scope.signal);
            throwIfAborted(scope.signal);
            if (decision.outcome === 'allow' && await abortable(plan.allowOnce(scope.signal), scope.signal)) {
              throwIfAborted(scope.signal);
              return { outcome: { outcome: 'selected', optionId: allow.optionId } };
            }
          }
        } catch {
          if (scope.signal.aborted) return cancelled;
          // Fail closed on mapper, authorization, or OS enforcement errors.
        }
        if (scope.signal.aborted || !reject) return cancelled;
        return { outcome: { outcome: 'selected', optionId: reject.optionId } };
      };
      rpc = new StdioRpc(harness.process, this.maxMessageBytes, this.maxOutputBytes, (method, raw) => {
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
          // ACP tool updates report harness execution; they are never executed a second time.
          context.emit({ type: 'status', status: `Harness tool ${typeof update.status === 'string' ? update.status : 'pending'}` });
        } else if (update.sessionUpdate === 'plan') context.emit({ type: 'status', status: 'Harness is planning' });
        // Thought chunks, multimodal content, and unknown extensions are not surfaced.
      }, request, error => scope.abort(error));
      const initialized = record(await abortable(rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false,
          _meta: { 'your-bot/execute-tool': true } },
        clientInfo: { name: 'your-bot', version: '0.1.0' },
      }), scope.signal));
      if (initialized.protocolVersion !== 1) throw new AdapterError('ACP_VERSION', 'Harness does not support ACP protocol version 1.');
      const created = record(await abortable(rpc.request('session/new', { cwd: harness.cwd, mcpServers: [] }), scope.signal));
      if (typeof created.sessionId !== 'string' || !created.sessionId) throw new AdapterError('INVALID_RESPONSE', 'Harness returned an invalid session ID.');
      sessionId = created.sessionId;
      const selector = modelSelector(created.configOptions);
      if (selector) this.models = selector.models;
      const model = context.session.modelId ?? this.config.modelId;
      if (model) {
        if (!selector || !selector.models.some(item => item.id === model)) {
          throw new AdapterError('MODEL_UNAVAILABLE', 'Harness did not advertise the requested model.');
        }
        if (selector.current !== model) {
          const changed = record(await abortable(rpc.request('session/set_config_option', { sessionId, configId: selector.id, value: model }), scope.signal));
          const confirmed = modelSelector(changed.configOptions);
          if (!confirmed || confirmed.current !== model) throw new AdapterError('MODEL_UNAVAILABLE', 'Harness did not confirm the requested model.');
          this.models = confirmed.models;
        }
      }
      const history = context.session.messages;
      const prompt = history.length === 1 && history[0].role === 'user'
        ? history[0].content
        : `Conversation transcript (role labels are context):\n${history.map(message => `${message.role}: ${message.content}`).join('\n\n')}\n\nRespond to the latest user message.`;
      activeTurn = true;
      const completed = record(await abortable(rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }), scope.signal));
      activeTurn = false;
      throwIfAborted(scope.signal);
      if (typeof completed.stopReason !== 'string' || !STOP_REASONS.has(completed.stopReason)) throw new AdapterError('INVALID_RESPONSE', 'Harness returned an invalid stop reason.');
      if (completed.stopReason === 'cancelled') throw new AdapterError('CANCELLED', 'Agent task was cancelled.');
      if (completed.stopReason !== 'end_turn') throw new AdapterError('INCOMPLETE_COMPLETION', 'Harness could not complete the response.');
    } catch (error) { throw normalizeAdapterError(error, scope.signal); }
    finally {
      activeTurn = false;
      scope.signal.removeEventListener('abort', onAbort);
      // Revoke pending host permission/tool waits even after a successful prompt.
      scope.abort(new AdapterError('CLOSED', 'Harness turn has ended.'));
      try {
        // Keep transport error handlers until teardown finishes (avoids unhandled EPIPE).
        if (harness) await this.terminate(harness);
      } finally { rpc?.dispose(); scope.finish(); }
    }
  }

  cancel(taskId: string): Promise<void> { return this.runs.cancel(taskId); }
  close(): Promise<void> { return this.runs.close(); }
}
