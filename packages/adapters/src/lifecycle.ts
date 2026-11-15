import { AdapterError } from './errors.js';

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof AdapterError
      ? signal.reason : new AdapterError('CANCELLED', 'Agent task was cancelled.');
  }
}

/** Stop waiting even when a host callback does not cooperate with cancellation. */
export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The promise may already have been created by the caller. Always observe its
    // rejection while returning immediately for an uncooperative operation.
    void operation.catch(() => {});
    throwIfAborted(signal);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof AdapterError
      ? signal.reason : new AdapterError('CANCELLED', 'Agent task was cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

export interface RunScope {
  signal: AbortSignal;
  abort(reason: AdapterError): void;
  done: Promise<void>;
  finish(): void;
  /** Pause the run deadline while `operation` is pending. */
  excludeTimeout<T>(operation: Promise<T>): Promise<T>;
}

export class RunManager {
  private closed = false;
  private readonly active = new Map<string, RunScope>();

  constructor(private readonly timeoutMs: number) {}

  assertOpen(): void {
    if (this.closed) throw new AdapterError('CLOSED', 'Adapter is closed.');
  }

  begin(taskId: string, parent?: AbortSignal): RunScope {
    this.assertOpen();
    if (this.active.has(taskId)) throw new AdapterError('TASK_ACTIVE', 'Task is already running.');
    const controller = new AbortController();
    let finishDone!: () => void;
    const done = new Promise<void>(resolve => { finishDone = resolve; });
    const onAbort = () => controller.abort(new AdapterError('CANCELLED', 'Agent task was cancelled.'));
    parent?.addEventListener('abort', onAbort, { once: true });
    if (parent?.aborted) onAbort();
    const timeout = () => controller.abort(new AdapterError('TIMEOUT', 'Agent operation timed out.', true));
    let remaining = this.timeoutMs;
    let deadline = Date.now() + remaining;
    let pauseDepth = 0;
    let timer = setTimeout(timeout, remaining);
    timer.unref();
    const arm = (ms: number) => {
      remaining = ms;
      deadline = Date.now() + ms;
      clearTimeout(timer);
      if (ms <= 0) { timeout(); return; }
      timer = setTimeout(timeout, ms);
      timer.unref();
    };
    let finished = false;
    const scope: RunScope = {
      signal: controller.signal,
      abort: reason => controller.abort(reason),
      done,
      /**
       * Approvals and host filesystem/terminal calls may wait for a person.
       * That wait does not consume the run deadline; cancellation still does.
       */
      excludeTimeout: <T>(operation: Promise<T>): Promise<T> => {
        if (finished || controller.signal.aborted) return operation;
        pauseDepth += 1;
        if (pauseDepth === 1) {
          clearTimeout(timer);
          remaining = Math.max(0, deadline - Date.now());
        }
        let resumed = false;
        const resume = () => {
          if (resumed) return;
          resumed = true;
          pauseDepth = Math.max(0, pauseDepth - 1);
          if (pauseDepth === 0 && !finished && !controller.signal.aborted) arm(remaining);
        };
        return operation.finally(resume);
      },
      finish: () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        parent?.removeEventListener('abort', onAbort);
        this.active.delete(taskId);
        finishDone();
      },
    };
    this.active.set(taskId, scope);
    return scope;
  }

  async cancel(taskId: string): Promise<void> {
    const scope = this.active.get(taskId);
    scope?.abort(new AdapterError('CANCELLED', 'Agent task was cancelled.'));
    await scope?.done;
  }

  async close(): Promise<void> {
    this.closed = true;
    const scopes = [...this.active.values()];
    for (const scope of scopes) scope.abort(new AdapterError('CANCELLED', 'Agent task was cancelled.'));
    await Promise.all(scopes.map(scope => scope.done));
  }
}
