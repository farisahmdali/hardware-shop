export const ErrorCodes = {
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  STALE_RECORD: 'STALE_RECORD',
  BUSINESS_RULE: 'BUSINESS_RULE',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  SETUP_REQUIRED: 'SETUP_REQUIRED',
  UNKNOWN_COMMAND: 'UNKNOWN_COMMAND',
  BACKUP_INVALID: 'BACKUP_INVALID',
  IO: 'IO',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/** An expected, user-presentable failure. Anything else is reported as INTERNAL. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  toPayload(): ErrorPayload {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: ErrorPayload };
