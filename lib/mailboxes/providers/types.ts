/**
 * Contracts for mailbox provider adapters (Gmail API, Microsoft Graph).
 *
 * Adapters are capability-aware: they report what the granted access can and
 * cannot observe, and they NEVER fill gaps with guesses. A signal the provider
 * does not expose is "unavailable"; one we could not determine is "unknown".
 *
 * Adapters are pure HTTP clients: no database access, no logging of tokens or
 * message content. Persistence happens in lib/mailboxes/*.
 */
import type { CapabilityStatus, EventCategory } from "@/lib/db/schema";

export type OAuthProvider = "google" | "microsoft";

export interface TokenSet {
  accessToken: string;
  /** Providers may omit the refresh token on refresh; callers keep the old one in that case. */
  refreshToken: string | null;
  expiresAt: Date | null;
  /** Scopes actually granted (may be fewer than requested). */
  scopes: string[];
}

export interface MailboxProfile {
  emailAddress: string;
  providerAccountId: string;
  displayName: string | null;
}

export const CAPABILITY_KEYS = [
  "sent_volume",
  "bounce_detection",
  "bounce_classification",
  "reply_detection",
  "auto_reply_detection",
  "complaint_feedback",
  "unsubscribe_requests",
  "sending_limit_notices",
  "provider_api_errors",
  "inbox_placement",
  "open_tracking",
  "realtime_push",
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export interface CapabilityResult {
  capability: CapabilityKey;
  status: CapabilityStatus;
  /** Plain-language explanation shown to the customer. */
  detail: string;
}

export type ProviderErrorCode =
  | "auth_revoked" // refresh token invalid / revoked / expired — user must reconnect
  | "insufficient_scope" // granted scopes do not cover the request
  | "admin_consent_required" // tenant policy blocks user consent
  | "consent_denied" // user declined on the consent screen
  | "rate_limited" // 429 / user-rate-limit — retry later
  | "quota_exceeded" // daily quota — retry much later
  | "provider_unavailable" // 5xx / outage
  | "mailbox_not_found"
  | "history_expired" // incremental cursor too old — resync window
  | "invalid_request"
  | "network_error"
  | "unknown";

/** Error thrown by adapters. Messages are safe to show and store: no tokens, no message content. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly httpStatus: number | null;

  constructor(
    code: ProviderErrorCode,
    message: string,
    opts: { retryable?: boolean; retryAfterMs?: number | null; httpStatus?: number | null } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.httpStatus = opts.httpStatus ?? null;
  }
}

/**
 * One normalised deliverability signal derived from message METADATA (headers,
 * labels, folder). Bodies are never requested.
 */
export interface NormalizedSignal {
  /** Provider message id. Combined with category for idempotent ingestion. */
  providerMessageRef: string;
  category: EventCategory;
  occurredAt: Date;
  /**
   * Counterparty address (bounced recipient, replier). Used transiently by
   * ingestion to derive recipient_domain + a keyed hash; NEVER persisted raw.
   */
  counterpartyAddress: string | null;
  confidence: "high" | "medium" | "low";
  /** What the classification was based on, e.g. "header:Auto-Submitted=auto-replied". */
  classificationBasis: string;
  /** SMTP enhanced status code when observable from metadata, else null. */
  diagnosticCode: string | null;
  /** Minimal, non-content metadata (e.g. { recipientCount: 3 }). No subjects, no bodies. */
  metadata: Record<string, unknown>;
}

export interface SyncPage {
  signals: NormalizedSignal[];
  messagesExamined: number;
  /** Opaque cursor to persist (Gmail historyId / Graph deltaLinks). */
  nextCursor: Record<string, string>;
  /** True when maxMessages was hit and another page should be fetched soon. */
  hasMore: boolean;
}

export interface ScopeExplanation {
  scope: string;
  why: string;
}

export interface MailboxProviderAdapter {
  readonly provider: OAuthProvider;
  readonly displayName: string;
  /** Least-privilege scopes requested at consent time. */
  readonly scopes: readonly string[];
  /** Shown on the connect screen before redirecting to the provider. */
  readonly scopeExplanations: readonly ScopeExplanation[];
  /** Whether client id/secret are configured in this deployment. */
  isConfigured(): boolean;
  buildAuthorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string; loginHint?: string }): string;
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<TokenSet>;
  refreshAccessToken(refreshToken: string): Promise<TokenSet>;
  fetchProfile(accessToken: string): Promise<MailboxProfile>;
  /** Probe what this connection can actually observe. Must return an entry for EVERY CapabilityKey. */
  validateCapabilities(accessToken: string, grantedScopes: string[]): Promise<CapabilityResult[]>;
  /**
   * Fetch new metadata since the cursor (or since `since` on first sync) and
   * classify it. Bounded by maxMessages; must not loop unboundedly.
   */
  syncSince(input: {
    accessToken: string;
    cursor: Record<string, string> | null;
    since: Date;
    mailboxAddress: string;
    maxMessages: number;
  }): Promise<SyncPage>;
  /** Best-effort provider-side revocation. Local token deletion happens regardless. */
  revoke(tokens: { accessToken: string; refreshToken: string | null }): Promise<{ revoked: boolean; detail: string }>;
}

export interface AdapterConfig {
  clientId: string | undefined;
  clientSecret: string | undefined;
  /** Microsoft only: "organizations" (default — work/school accounts), "common", or a tenant id. */
  tenant?: string;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Default 15s. */
  timeoutMs?: number;
}
