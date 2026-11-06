/**
 * Typed API errors. Throw these from services; `withOrgAuth` maps them to the
 * standard envelope. Messages must be safe to show: no tokens, no message
 * content, no other tenant's identifiers, no stack traces.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) => new ApiError(400, "BAD_REQUEST", message, details);
export const unauthorized = () => new ApiError(401, "UNAUTHORIZED", "Sign in to continue.");
export const forbidden = (message = "Your role does not permit this action.") => new ApiError(403, "FORBIDDEN", message);
/** Also used for cross-tenant ids: another org's record is indistinguishable from a missing one. */
export const notFound = (what = "Resource") => new ApiError(404, "NOT_FOUND", `${what} not found.`);
export const conflict = (message: string) => new ApiError(409, "CONFLICT", message);
export const limitReached = (message: string) => new ApiError(403, "PLAN_LIMIT_REACHED", message);
export const rateLimited = (retryAfterSeconds: number) =>
  new ApiError(429, "RATE_LIMITED", "Too many requests. Try again shortly.", { retryAfterSeconds });
export const unavailable = (message: string) => new ApiError(503, "UNAVAILABLE", message);

export function toErrorMessage(error: unknown, fallback = "Operation failed"): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return fallback;
}
