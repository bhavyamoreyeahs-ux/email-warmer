/**
 * Server-safe display helpers for the mailbox pages (no hooks, no client code).
 * Every status renders icon + text through the shared Pill.
 */
import { Pill } from "@/components/ui/primitives";
import { CATEGORY_LABEL } from "@/lib/ui/format";
import type { CapabilityStatus, EventCategory } from "@/lib/db/schema";

/** Short provider names used on connect buttons ("Connect Google Workspace"). */
export const PROVIDER_SHORT: Record<string, string> = { google: "Google Workspace", microsoft: "Microsoft 365", demo: "Demo" };

export const CAPABILITY_LABEL: Record<string, string> = {
  sent_volume: "Sent volume (provider-recorded)",
  bounce_detection: "Bounce detection",
  bounce_classification: "Bounce classification (hard / soft)",
  reply_detection: "Reply detection",
  auto_reply_detection: "Auto-reply detection",
  complaint_feedback: "Complaint feedback reports",
  unsubscribe_requests: "Unsubscribe requests",
  sending_limit_notices: "Sending-limit notices",
  provider_api_errors: "Provider API errors",
  inbox_placement: "Inbox placement",
  open_tracking: "Open tracking",
  realtime_push: "Real-time push notifications",
};

export function capabilityLabel(key: string): string {
  return CAPABILITY_LABEL[key] ?? key.replace(/_/g, " ");
}

export function CapabilityPill({ status }: { status: CapabilityStatus }) {
  switch (status) {
    case "available":
      return <Pill tone="good">Available</Pill>;
    case "partial":
      return <Pill tone="warn">Partial</Pill>;
    case "unavailable":
      return <Pill tone="unknown">Unavailable</Pill>;
    default:
      return <Pill tone="unknown">Unknown</Pill>;
  }
}

export const SYNC_TRIGGER_LABEL: Record<"initial" | "scheduled" | "manual", string> = { initial: "Initial", scheduled: "Scheduled", manual: "Manual" };

export function SyncStatusPill({ status }: { status: "running" | "succeeded" | "failed" | "partial" }) {
  switch (status) {
    case "succeeded":
      return <Pill tone="good">Succeeded</Pill>;
    case "failed":
      return <Pill tone="bad">Failed</Pill>;
    case "partial":
      return <Pill tone="warn">Partial</Pill>;
    default:
      return <Pill tone="info">Running</Pill>;
  }
}

const CATEGORY_TONE: Record<EventCategory, "good" | "warn" | "bad" | "unknown" | "info"> = {
  sent: "info",
  hard_bounce: "bad",
  soft_bounce: "warn",
  bounce_unclassified: "warn",
  complaint: "bad",
  unsubscribe: "warn",
  reply: "info",
  auto_reply: "info",
  provider_error: "bad",
  sending_limit: "warn",
  unknown: "unknown",
};

export function CategoryPill({ category }: { category: EventCategory }) {
  return <Pill tone={CATEGORY_TONE[category] ?? "unknown"}>{CATEGORY_LABEL[category] ?? category}</Pill>;
}

export const EVENT_SOURCE_LABEL: Record<string, string> = { gmail_api: "Gmail API", graph_api: "Microsoft Graph", demo_seed: "Demo seed" };

export const CONFIDENCE_LABEL: Record<"high" | "medium" | "low", string> = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" };

/**
 * Defence in depth for stored provider error text before display: strip
 * control characters, redact anything token-shaped, collapse whitespace and
 * truncate. (Messages are already sanitised when stored.)
 */
export function sanitizeErrorMessage(message: string | null | undefined, max = 180): string | null {
  if (!message) return null;
  const cleaned = message
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9._~+/-]{40,}={0,2}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** Messages for `?oauth_error=<code>` set by the OAuth callback (only a code is ever placed in the URL). */
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  consent_denied: "Permission was not granted on the provider's consent screen, so no mailbox was connected. You can try again at any time.",
  invalid_state: "This connection attempt expired or was already used. Start again from this page.",
  session_mismatch: "The connection was finished in a different signed-in session from the one that started it. Start again and complete it in the same browser session.",
  forbidden: "Your role does not permit connecting mailboxes in this organization. Ask an Owner or Administrator.",
  demo_workspace: "Live mailboxes cannot be connected to a demo workspace. Create or switch to a real workspace first.",
  provider_error: "The provider returned an error during sign-in. No mailbox was connected — please try again.",
  missing_code: "The provider did not return an authorization code, so no mailbox was connected. Please try again.",
  admin_consent_required:
    "Your organization requires an administrator to approve QuikReach before users can connect mailboxes. Ask your Google Workspace or Microsoft 365 administrator to grant consent, then try again.",
  insufficient_scope: "Not every requested permission was granted. QuikReach needs each listed permission to monitor the mailbox — connect again and approve all of them.",
  auth_revoked: "The provider reported that access was revoked or expired while connecting. Please connect again.",
  plan_limit_reached: "Your plan's mailbox limit has been reached. Disconnect a mailbox or upgrade your plan to connect another.",
  bad_request: "The connection request was not valid. Start again from this page.",
  internal_error: "Something went wrong on our side while finishing the connection. No mailbox was connected. Try again; if it keeps happening, contact support.",
  unsupported_provider: "That mailbox provider is not supported. Connect Google Workspace or Microsoft 365.",
};

export function oauthErrorMessage(code: string): string {
  return OAUTH_ERROR_MESSAGES[code] ?? "The mailbox could not be connected. No connection was created. Try again; if it keeps happening, contact support.";
}
