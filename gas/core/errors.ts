export type ErrorCode =
  | 'unauthenticated' | 'permission-denied' | 'invalid-argument' | 'not-found'
  | 'failed-precondition' | 'aborted' | 'already-exists' | 'resource-exhausted' | 'internal' | 'unavailable';

/** functions の HttpsError と同じ形（code, message, details）。Web へはそのまま返される。 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }
}
