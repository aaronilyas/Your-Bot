export type WorkspaceErrorCode =
  | 'OUTSIDE_WORKSPACE'
  | 'NOT_FOUND'
  | 'TERMINAL_NOT_FOUND'
  | 'LIMIT_EXCEEDED'
  | 'INVALID_REQUEST'
  | 'ABORTED'
  | 'IO_ERROR';

/** Every rejection from the workspace host is an Error carrying a `code` (StructuredError.code). */
export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  constructor(code: WorkspaceErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

export function errnoOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

/** Map a Node fs error to a WorkspaceError (WorkspaceErrors pass through). */
export function mapFsError(error: unknown, what: string): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  const errno = errnoOf(error);
  const message = `${what}: ${errno ?? (error instanceof Error ? error.message : String(error))}`;
  switch (errno) {
    case 'ENOENT': return new WorkspaceError('NOT_FOUND', message, { cause: error });
    case 'ENOTDIR': case 'EISDIR': case 'ELOOP': case 'ENAMETOOLONG': case 'EINVAL':
      return new WorkspaceError('INVALID_REQUEST', message, { cause: error });
    default: return new WorkspaceError('IO_ERROR', message, { cause: error });
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new WorkspaceError('ABORTED', 'operation aborted');
}
