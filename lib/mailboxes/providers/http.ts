/**
 * Shared HTTP plumbing for mailbox provider adapters.
 *
 * Every provider call goes through `requestJson` (REST APIs) or `postForm`
 * (OAuth token/revoke endpoints). Both enforce a timeout and translate HTTP,
 * OAuth and network failures into `ProviderError`s whose messages are short,
 * generic and safe to store or show: they never echo provider response bodies,
 * URLs, tokens, client secrets or message content.
 */
import type { z } from "zod";
import {
  CAPABILITY_KEYS,
  ProviderError,
  type CapabilityKey,
  type CapabilityResult,
  type OAuthProvider,
  type TokenSet,
} from "@/lib/mailboxes/providers/types";
import type { CapabilityStatus } from "@/lib/db/schema";

export const DEFAULT_TIMEOUT_MS = 15_000;

export interface RequestOptions {
  timeoutMs: number;
  provider: OAuthProvider;
}

/** Which OAuth operation a form POST belongs to; only used to word error messages. */
export type OAuthContext = "code_exchange" | "token_refresh" | "revoke";

export interface PostFormOptions extends RequestOptions {
  context?: OAuthContext;
}

const PROVIDER_NAMES: Record<OAuthProvider, string> = { google: "Google", microsoft: "Microsoft" };

export function providerName(provider: OAuthProvider): string {
  return PROVIDER_NAMES[provider];
}

interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
}

async function send(fetchImpl: typeof fetch, url: string, init: RequestInit, opts: RequestOptions): Promise<RawResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    // Read the body inside the timeout window: a stalled body is as bad as a stalled connect.
    const text = await response.text();
    return { status: response.status, headers: response.headers, text };
  } catch {
    const name = providerName(opts.provider);
    throw new ProviderError("network_error", timedOut ? `Request to ${name} timed out.` : `Could not reach ${name}.`, {
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }
}

function parseBody<T>(res: RawResponse, provider: OAuthProvider): T {
  // Empty 2xx bodies (e.g. Google's revoke endpoint) resolve to undefined.
  if (res.text.trim() === "") return undefined as T;
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new ProviderError("unknown", `Unexpected response from ${providerName(provider)}.`, { httpStatus: res.status });
  }
}

/**
 * GET/POST a JSON API. Resolves with the parsed body on 2xx (unvalidated — use
 * `parseResponse` with a schema), throws `ProviderError` otherwise.
 */
export async function requestJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  opts: RequestOptions,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  const res = await send(fetchImpl, url, { ...init, headers }, opts);
  if (res.status >= 200 && res.status < 300) return parseBody<T>(res, opts.provider);
  throw mapHttpError(res, opts.provider);
}

/** POST an `application/x-www-form-urlencoded` body to an OAuth endpoint. */
export async function postForm<T>(
  fetchImpl: typeof fetch,
  url: string,
  form: Record<string, string>,
  opts: PostFormOptions,
): Promise<T> {
  const res = await send(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    },
    opts,
  );
  if (res.status >= 200 && res.status < 300) return parseBody<T>(res, opts.provider);
  const oauth = parseOAuthErrorBody(res.text);
  if (oauth) {
    throw providerErrorFromOAuth(opts.provider, oauth, {
      httpStatus: res.status,
      context: opts.context,
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
    });
  }
  throw mapHttpError(res, opts.provider);
}

/** Validate a provider response against a schema; mismatches become a safe ProviderError. */
export function parseResponse<S extends z.ZodTypeAny>(schema: S, data: unknown, provider: OAuthProvider): z.infer<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new ProviderError("unknown", `Unexpected response from ${providerName(provider)}.`);
  }
  return parsed.data;
}

/* ─── Retry-After ─────────────────────────────────────────────────────── */

/** Retry-After is either delta-seconds or an HTTP date. Returns milliseconds, or null if absent/garbled. */
export function parseRetryAfter(value: string | null, nowMs: number = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/* ─── Error body parsing ──────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ErrorInfo {
  /** Lower-cased machine-readable codes/reasons gathered from Google and Graph error envelopes. */
  reasons: string[];
  /** Lower-cased provider message. Used ONLY for matching, never copied into ProviderError messages. */
  message: string;
}

function collectReasons(error: Record<string, unknown>, out: string[]): void {
  for (const key of ["code", "status", "reason"]) {
    const v = error[key];
    if (typeof v === "string") out.push(v.toLowerCase());
  }
  for (const listKey of ["errors", "details"]) {
    const list = error[listKey];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (isRecord(item) && typeof item.reason === "string") out.push(item.reason.toLowerCase());
    }
  }
  const inner = error.innerError ?? error.innererror;
  if (isRecord(inner) && typeof inner.code === "string") out.push(inner.code.toLowerCase());
}

function parseErrorInfo(text: string): ErrorInfo {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { reasons: [], message: text.slice(0, 2000).toLowerCase() };
  }
  const reasons: string[] = [];
  let message = "";
  if (isRecord(data)) {
    const err = data.error;
    if (isRecord(err)) {
      collectReasons(err, reasons);
      if (typeof err.message === "string") message = err.message.toLowerCase();
    } else if (typeof err === "string") {
      reasons.push(err.toLowerCase());
      if (typeof data.error_description === "string") message = data.error_description.toLowerCase();
    }
  }
  return { reasons, message };
}

const SCOPE_REASONS = [
  "insufficientpermissions", // Gmail
  "access_token_scope_insufficient", // Google ErrorInfo detail
  "insufficient_scope",
  "erroraccessdenied", // Graph: token lacks the needed permission
  "accessdenied",
  "authorization_requestdenied",
];
const RATE_REASONS = ["ratelimitexceeded", "userratelimitexceeded"];
const QUOTA_REASONS = ["dailylimitexceeded", "quotaexceeded"];
const SYNC_STATE_REASONS = ["syncstatenotfound", "syncstateinvalid", "resyncrequired"];
const NO_MAILBOX_REASONS = ["mailboxnotenabledforrestapi", "mailboxnotsupportedforrestapi"];

function hasAny(reasons: string[], wanted: readonly string[]): boolean {
  return reasons.some((r) => wanted.includes(r));
}

function mapHttpError(res: RawResponse, provider: OAuthProvider): ProviderError {
  const name = providerName(provider);
  const status = res.status;
  const info = parseErrorInfo(res.text);
  const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
  const wwwAuth = (res.headers.get("www-authenticate") ?? "").toLowerCase();
  const scopeProblem =
    wwwAuth.includes("insufficient_scope") ||
    hasAny(info.reasons, SCOPE_REASONS) ||
    /insufficient (authentication )?scopes?|insufficient permission|insufficient privileges/.test(info.message);
  const httpOpts = { httpStatus: status };

  if (hasAny(info.reasons, SYNC_STATE_REASONS) || status === 410) {
    return new ProviderError("history_expired", `${name} sync state expired; a resync is required.`, httpOpts);
  }
  if (hasAny(info.reasons, NO_MAILBOX_REASONS)) {
    return new ProviderError("mailbox_not_found", `${name} has no mailbox available for this account.`, httpOpts);
  }
  if (status === 429 || hasAny(info.reasons, RATE_REASONS)) {
    return new ProviderError("rate_limited", `${name} is rate limiting requests; QuikReach will retry later.`, {
      ...httpOpts,
      retryable: true,
      retryAfterMs,
    });
  }
  if (hasAny(info.reasons, QUOTA_REASONS)) {
    // Daily quota: retrying soon will not help, so the hint is whatever the provider says (often nothing).
    return new ProviderError("quota_exceeded", `${name} API quota for this mailbox is exhausted; QuikReach will retry later.`, {
      ...httpOpts,
      retryable: true,
      retryAfterMs,
    });
  }
  if (status >= 500) {
    return new ProviderError("provider_unavailable", `${name} is temporarily unavailable; QuikReach will retry.`, {
      ...httpOpts,
      retryable: true,
      retryAfterMs,
    });
  }
  switch (status) {
    case 400:
      // Gmail answers 400 failedPrecondition when the account has no Gmail service.
      if (provider === "google" && info.reasons.includes("failedprecondition")) {
        return new ProviderError("mailbox_not_found", "Gmail is not enabled for this Google account.", httpOpts);
      }
      return new ProviderError("invalid_request", `${name} rejected the request (HTTP 400).`, httpOpts);
    case 401:
      if (scopeProblem) {
        return new ProviderError("insufficient_scope", `${name} did not grant the permission this request needs.`, httpOpts);
      }
      return new ProviderError("auth_revoked", `${name} rejected the access token; the user must reconnect.`, httpOpts);
    case 403:
      if (scopeProblem) {
        return new ProviderError("insufficient_scope", `${name} did not grant the permission this request needs.`, httpOpts);
      }
      if (info.reasons.includes("domainpolicy")) {
        return new ProviderError(
          "admin_consent_required",
          `${name} organization policy blocks QuikReach; an administrator must allow it.`,
          httpOpts,
        );
      }
      return new ProviderError("unknown", `${name} refused the request (HTTP 403).`, httpOpts);
    case 404:
      return new ProviderError("mailbox_not_found", `${name} could not find the requested mailbox or item.`, httpOpts);
    default:
      if (status >= 400) return new ProviderError("invalid_request", `${name} rejected the request (HTTP ${status}).`, httpOpts);
      return new ProviderError("unknown", `Unexpected response from ${name} (HTTP ${status}).`, httpOpts);
  }
}

/* ─── OAuth errors ────────────────────────────────────────────────────── */

export interface OAuthErrorBody {
  error: string;
  errorDescription?: string;
  /** Microsoft numeric AADSTS codes, e.g. [65001]. */
  errorCodes?: number[];
  suberror?: string;
}

function parseOAuthErrorBody(text: string): OAuthErrorBody | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(data) || typeof data.error !== "string") return null;
  return {
    error: data.error,
    errorDescription: typeof data.error_description === "string" ? data.error_description : undefined,
    errorCodes: Array.isArray(data.error_codes)
      ? data.error_codes.filter((c): c is number => typeof c === "number")
      : undefined,
    suberror: typeof data.suberror === "string" ? data.suberror : undefined,
  };
}

/**
 * Map an OAuth error (token endpoint body, or the `error`/`error_description`
 * query parameters on the authorization callback) to a safe ProviderError.
 */
export function providerErrorFromOAuth(
  provider: OAuthProvider,
  body: OAuthErrorBody,
  opts: { httpStatus?: number | null; context?: OAuthContext; retryAfterMs?: number | null } = {},
): ProviderError {
  const name = providerName(provider);
  const err = body.error.toLowerCase();
  const desc = (body.errorDescription ?? "").toLowerCase();
  const sub = (body.suberror ?? "").toLowerCase();
  const codes = body.errorCodes ?? [];
  const aadsts = (code: number) => codes.includes(code) || desc.includes(`aadsts${code}`);
  const httpStatus = opts.httpStatus ?? null;

  // Admin checks come first: Microsoft wraps them in access_denied / invalid_grant too.
  if (
    aadsts(90094) || // AdminConsentRequired
    aadsts(90095) || // AdminConsentRequiredRequestAccess (admin consent workflow)
    err === "admin_policy_enforced" || // Google Workspace admin blocked the app
    /admin(istrator)? (consent|approval)|need admin/.test(desc)
  ) {
    return new ProviderError(
      "admin_consent_required",
      `${name} requires an administrator to approve QuikReach for this organization.`,
      { httpStatus },
    );
  }
  // AADSTS65004 is UserDeclinedConsent: the user said no, an admin is not required.
  if (aadsts(65004) || err === "access_denied") {
    return new ProviderError("consent_denied", `Access was declined on the ${name} consent screen.`, { httpStatus });
  }
  if (aadsts(65001) || sub === "consent_required" || err === "consent_required") {
    return new ProviderError(
      "insufficient_scope",
      `${name} has not granted the permissions QuikReach needs; the user must reconnect and approve them.`,
      { httpStatus },
    );
  }
  if (err === "invalid_client" || err === "unauthorized_client") {
    return new ProviderError("invalid_request", "OAuth client misconfigured", { httpStatus });
  }
  if (err === "invalid_grant" || err === "invalid_token" || err === "interaction_required" || err === "invalid_rapt") {
    const what =
      opts.context === "token_refresh"
        ? `${name} rejected the refresh token; the user must reconnect.`
        : opts.context === "code_exchange"
          ? `${name} rejected the authorization code; the user must start the connection again.`
          : opts.context === "revoke"
            ? `${name} reports the token is already invalid.`
            : `${name} rejected the stored credentials; the user must reconnect.`;
    return new ProviderError("auth_revoked", what, { httpStatus });
  }
  if (httpStatus === 429 || err === "slow_down") {
    return new ProviderError("rate_limited", `${name} is rate limiting requests; QuikReach will retry later.`, {
      httpStatus,
      retryable: true,
      retryAfterMs: opts.retryAfterMs ?? null,
    });
  }
  if (err === "temporarily_unavailable" || err === "server_error" || (httpStatus !== null && httpStatus >= 500)) {
    return new ProviderError("provider_unavailable", `${name} sign-in is temporarily unavailable; try again shortly.`, {
      httpStatus,
      retryable: true,
      retryAfterMs: opts.retryAfterMs ?? null,
    });
  }
  return new ProviderError("invalid_request", `${name} rejected the OAuth request.`, { httpStatus });
}

/* ─── Token responses ─────────────────────────────────────────────────── */

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Normalise a token-endpoint JSON body (Google and Microsoft share the RFC 6749 shape). */
export function parseTokenResponse(data: unknown, provider: OAuthProvider, nowMs: number = Date.now()): TokenSet {
  if (!isRecord(data) || !isNonEmptyString(data.access_token)) {
    throw new ProviderError("unknown", `Unexpected response from ${providerName(provider)}.`);
  }
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : Number(data.expires_in);
  return {
    accessToken: data.access_token,
    refreshToken: isNonEmptyString(data.refresh_token) ? data.refresh_token : null,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(nowMs + expiresIn * 1000) : null,
    // Never assume what was granted: no `scope` field means no known scopes.
    scopes: typeof data.scope === "string" ? data.scope.split(/\s+/).filter(Boolean) : [],
  };
}

/* ─── Small shared helpers ────────────────────────────────────────────── */

/** Map with at most `limit` promises in flight. Stops scheduling new work after the first rejection. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (error: unknown) {
        failed = true;
        throw error;
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}

/** Build a capability list from a map keyed by every CapabilityKey (the type enforces completeness). */
export function capabilitiesFrom(
  map: Record<CapabilityKey, { status: CapabilityStatus; detail: string }>,
): CapabilityResult[] {
  return CAPABILITY_KEYS.map((capability) => ({ capability, status: map[capability].status, detail: map[capability].detail }));
}
