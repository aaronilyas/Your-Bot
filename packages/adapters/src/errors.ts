import type { StructuredError } from '@your-bot/contracts';

/** Safe to expose to the gateway: never includes upstream bodies, stderr or credentials. */
export class AdapterError extends Error implements StructuredError {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = 'AdapterError';
  }
}

export function normalizeAdapterError(error: unknown, signal?: AbortSignal): AdapterError {
  if (signal?.aborted) {
    return signal.reason instanceof AdapterError
      ? signal.reason
      : new AdapterError('CANCELLED', 'Agent task was cancelled.');
  }
  if (error instanceof AdapterError) return error;
  return new AdapterError('ADAPTER_FAILURE', 'Agent operation failed.', true);
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AdapterError('INVALID_RESPONSE', 'Provider returned an invalid response.');
  }
  return value as Record<string, unknown>;
}

export function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AdapterError('INVALID_CONFIG', `${name} must be a positive integer.`);
  }
  return value;
}
