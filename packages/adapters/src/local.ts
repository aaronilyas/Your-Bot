import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentInfo, AgentRunContext, ModelInfo, ProviderConfig } from '@your-bot/contracts';
import { AdapterError, normalizeAdapterError, positiveInteger, record } from './errors.js';
import { abortable, RunManager, throwIfAborted } from './lifecycle.js';
import { parseSse } from './sse.js';
import { parseToolInvocation, TOOL_DEFINITION } from './tools.js';

export interface LocalAdapterOptions {
  timeoutMs?: number;
  discoveryTimeoutMs?: number;
  maxToolRounds?: number;
  maxToolCallsPerRound?: number;
  maxResponseBytes?: number;
  /** For host networking policy or deterministic transport tests; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string }; }
interface WireMessage { role: string; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; }
interface Round { content: string; calls: ToolCall[]; }

export class OpenAICompatibleAdapter implements AgentAdapter {
  readonly id: string;
  private readonly config: ProviderConfig;
  private readonly base: URL;
  private readonly runs: RunManager;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly rounds: number;
  private readonly callsPerRound: number;
  private readonly maxBytes: number;
  private readonly discoveryTimeoutMs: number;

  constructor(config: ProviderConfig, options: LocalAdapterOptions = {}) {
    if (config.kind === 'acp') throw new AdapterError('INVALID_CONFIG', 'Local adapter requires an HTTP provider.');
    this.config = { ...config };
    this.id = config.id;
    const endpoint = config.endpoint ?? (config.kind === 'lmstudio' ? 'http://127.0.0.1:1234/v1' : config.kind === 'llamacpp' ? 'http://127.0.0.1:8080/v1' : undefined);
    try {
      if (!endpoint) throw new Error();
      this.base = new URL(endpoint);
      if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash) throw new Error();
      if (this.base.pathname === '/') this.base.pathname = '/v1';
      this.base.pathname = this.base.pathname.replace(/\/+$/, '') + '/';
    } catch { throw new AdapterError('INVALID_CONFIG', 'Provider endpoint must be an HTTP(S) API base URL without credentials, query or fragment.'); }
    this.runs = new RunManager(positiveInteger(options.timeoutMs ?? 120_000, 'timeoutMs'));
    this.rounds = positiveInteger(options.maxToolRounds ?? 8, 'maxToolRounds');
    this.callsPerRound = positiveInteger(options.maxToolCallsPerRound ?? 16, 'maxToolCallsPerRound');
    this.maxBytes = positiveInteger(options.maxResponseBytes ?? 16_777_216, 'maxResponseBytes');
    this.discoveryTimeoutMs = positiveInteger(options.discoveryTimeoutMs ?? 5000, 'discoveryTimeoutMs');
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  private async request(path: string, signal: AbortSignal, body?: unknown): Promise<Response> {
    throwIfAborted(signal);
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.base), {
        method: body === undefined ? 'GET' : 'POST', signal,
        redirect: 'error', // Never forward credentials to another endpoint.
        headers: {
          Accept: body === undefined ? 'application/json' : 'text/event-stream, application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throwIfAborted(signal);
      throw new AdapterError('NETWORK_ERROR', 'Could not connect to the model provider.', true);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new AdapterError(`HTTP_${response.status}`, `Model provider returned HTTP ${response.status}.`, response.status === 429 || response.status >= 500);
    }
    return response;
  }

  private async json(response: Response, signal: AbortSignal): Promise<unknown> {
    if (!response.body) throw new AdapterError('INVALID_RESPONSE', 'Provider returned an empty body.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const onAbort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      while (true) {
        throwIfAborted(signal);
        const result = await reader.read();
        throwIfAborted(signal);
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > this.maxBytes) throw new AdapterError('RESPONSE_LIMIT', 'Provider response exceeded the size limit.');
        chunks.push(result.value);
      }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
      catch { throw new AdapterError('INVALID_RESPONSE', 'Provider returned invalid JSON.'); }
    } finally {
      signal.removeEventListener('abort', onAbort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  private async discover(signal: AbortSignal): Promise<ModelInfo[]> {
    const value = record(await this.json(await this.request('models', signal), signal));
    if (!Array.isArray(value.data)) throw new AdapterError('INVALID_RESPONSE', 'Provider returned an invalid model list.');
    const ids = new Set<string>();
    return value.data.map(item => {
      const model = record(item);
      if (typeof model.id !== 'string' || !model.id || ids.has(model.id)) throw new AdapterError('INVALID_RESPONSE', 'Provider returned an invalid model list.');
      ids.add(model.id);
      return { id: model.id, name: typeof model.name === 'string' ? model.name : model.id };
    });
  }

  async getInfo(): Promise<AgentInfo> {
    this.runs.assertOpen();
    const info: AgentInfo = { id: this.id, name: this.config.name, kind: 'local', models: [], available: false };
    if (!this.config.enabled) return { ...info, limitation: 'Provider is disabled.' };
    const deadline = AbortSignal.timeout(this.discoveryTimeoutMs);
    const scope = this.runs.begin(`discovery:${randomUUID()}`, deadline);
    try {
      const models = await this.discover(scope.signal);
      return { ...info, models, available: models.length > 0, ...(models.length ? {} : { limitation: 'Provider has no loaded models.' }) };
    } catch (error) { return { ...info, limitation: deadline.aborted ? 'Model discovery timed out.' : normalizeAdapterError(error, scope.signal).message }; }
    finally { scope.finish(); }
  }

  private async round(model: string, messages: WireMessage[], context: AgentRunContext, signal: AbortSignal): Promise<Round> {
    const response = await this.request('chat/completions', signal, {
      model, messages, stream: true, tools: [TOOL_DEFINITION], tool_choice: 'auto',
    });
    let content = '';
    const calls = new Map<number, ToolCall>();
    let finished = false;
    let sawChoice = false;
    const consume = (raw: unknown, streaming: boolean) => {
      const value = record(raw);
      if (value.error !== undefined) throw new AdapterError('PROVIDER_ERROR', 'Model provider reported an error.');
      if (!Array.isArray(value.choices)) throw new AdapterError('INVALID_RESPONSE', 'Provider returned invalid completion choices.');
      if (!value.choices.length) return; // Usage-only chunk.
      const choice = record(value.choices.find(item => record(item).index === 0) ?? value.choices[0]);
      sawChoice = true;
      const delta = record(streaming ? choice.delta : choice.message);
      if (delta.content !== undefined && delta.content !== null) {
        if (typeof delta.content !== 'string') throw new AdapterError('INVALID_RESPONSE', 'Provider returned invalid text content.');
        content += delta.content;
        throwIfAborted(signal);
        if (delta.content) context.emit({ type: 'text', text: delta.content });
      }
      if (delta.tool_calls !== undefined) {
        if (!Array.isArray(delta.tool_calls)) throw new AdapterError('INVALID_TOOL_CALL', 'Provider returned invalid tool calls.');
        delta.tool_calls.forEach((item, position) => {
          const fragment = record(item);
          const index = streaming ? fragment.index : position;
          if (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= this.callsPerRound) throw new AdapterError('TOOL_LIMIT', 'Provider exceeded the tool call limit.');
          const call = calls.get(Number(index)) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (fragment.type !== undefined && fragment.type !== 'function') throw new AdapterError('INVALID_TOOL_CALL', 'Provider requested an unsupported tool type.');
          if (fragment.id !== undefined) {
            if (typeof fragment.id !== 'string') throw new AdapterError('INVALID_TOOL_CALL', 'Provider returned an invalid tool ID.');
            call.id += fragment.id;
          }
          if (fragment.function !== undefined) {
            const fn = record(fragment.function);
            for (const field of ['name', 'arguments'] as const) {
              if (fn[field] !== undefined) {
                if (typeof fn[field] !== 'string') throw new AdapterError('INVALID_TOOL_CALL', 'Provider returned an invalid tool function.');
                call.function[field] += fn[field];
              }
            }
          }
          calls.set(Number(index), call);
        });
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (!['stop', 'tool_calls'].includes(String(choice.finish_reason))) throw new AdapterError('INCOMPLETE_COMPLETION', 'Provider could not complete the response.', true);
        finished = true;
      }
    };
    if (response.headers.get('content-type')?.split(';')[0].trim() === 'text/event-stream') {
      if (!response.body) throw new AdapterError('INVALID_RESPONSE', 'Provider returned an empty stream.');
      for await (const data of parseSse(response.body, signal, Math.min(1_048_576, this.maxBytes), this.maxBytes)) {
        if (data.trim() === '[DONE]') { finished = true; break; }
        let value: unknown;
        try { value = JSON.parse(data) as unknown; } catch { throw new AdapterError('INVALID_RESPONSE', 'Provider returned invalid SSE JSON.'); }
        consume(value, true);
      }
    } else consume(await this.json(response, signal), false);
    if (!finished || !sawChoice) throw new AdapterError('TRUNCATED_STREAM', 'Provider stream ended before the completion finished.', true);
    const resultCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    const ids = new Set<string>();
    for (const call of resultCalls) {
      if (!call.id || call.id.length > 256 || ids.has(call.id)) throw new AdapterError('INVALID_TOOL_CALL', 'Provider returned invalid tool IDs.');
      ids.add(call.id);
    }
    return { content, calls: resultCalls };
  }

  async run(context: AgentRunContext): Promise<void> {
    if (!this.config.enabled) throw new AdapterError('DISABLED', 'Provider is disabled.');
    const scope = this.runs.begin(context.taskId, context.signal);
    try {
      throwIfAborted(scope.signal);
      const model = context.session.modelId ?? this.config.modelId ?? (await this.discover(scope.signal))[0]?.id;
      if (!model) throw new AdapterError('NO_MODEL', 'Provider has no loaded models.');
      // Contract v1 does not persist tool_call_id. Historical tools are plain transcript context.
      const messages: WireMessage[] = context.session.messages.map(message => ({
        role: message.role === 'tool' ? 'user' : message.role,
        content: message.role === 'tool' ? `[Prior tool result]\n${message.content}` : message.content,
      }));
      const seenIds = new Set<string>();
      for (let round = 0; ; round++) {
        const response = await this.round(model, messages, context, scope.signal);
        throwIfAborted(scope.signal);
        if (!response.calls.length) return;
        if (round >= this.rounds) throw new AdapterError('TOOL_LIMIT', 'Model exceeded the tool round limit.');
        // Validate the entire batch before executing any call.
        const invocations = response.calls.map(call => {
          if (seenIds.has(call.id)) throw new AdapterError('INVALID_TOOL_CALL', 'Provider reused a tool call ID.');
          seenIds.add(call.id);
          return parseToolInvocation(call.function.name, call.function.arguments, call.id);
        });
        messages.push({ role: 'assistant', content: response.content || null, tool_calls: response.calls });
        for (let i = 0; i < invocations.length; i++) {
          throwIfAborted(scope.signal);
          const invocation = invocations[i];
          context.emit({ type: 'status', status: `Executing tool ${invocation.kind}` });
          // executeTool itself authorizes; emitting a tool update too could execute the tool twice in a host.
          const result = await abortable(context.executeTool(invocation), scope.signal);
          throwIfAborted(scope.signal);
          const toolContent = JSON.stringify(result);
          if (Buffer.byteLength(toolContent) > this.maxBytes) throw new AdapterError('RESPONSE_LIMIT', 'Tool result exceeded the size limit.');
          messages.push({ role: 'tool', content: toolContent, tool_call_id: response.calls[i].id });
        }
      }
    } catch (error) { throw normalizeAdapterError(error, scope.signal); }
    finally { scope.finish(); }
  }

  cancel(taskId: string): Promise<void> { return this.runs.cancel(taskId); }
  close(): Promise<void> { return this.runs.close(); }
}
