/**
 * Display vocabulary for alerts and alert rules (server- and client-safe:
 * type-only imports from the schema, no database code).
 *
 * Truthfulness: only `pause_confirmed` / a `confirmed` pause action is ever
 * described as "paused". Everything else says plainly that nothing is known to
 * have been paused.
 */
import type { AlertMetric, EventCategory } from "@/lib/db/schema";
import { pct } from "@/lib/ui/format";

export type PillTone = "good" | "warn" | "bad" | "unknown" | "stale" | "info" | "demo";

export type ActionOutcome = "notify_only" | "no_campaign_integration" | "no_linked_campaigns" | "pause_requested" | "pause_confirmed" | "pause_failed";

export const ACTION_OUTCOME: Record<ActionOutcome, { label: string; tone: PillTone; detail: string }> = {
  notify_only: { label: "Monitor only", tone: "info", detail: "This rule notifies only. No campaign action was requested." },
  no_campaign_integration: {
    label: "Not paused — no campaign integration",
    tone: "unknown",
    detail: "The rule asks to pause campaigns, but no campaign integration is active. QuikReach did not pause anything.",
  },
  no_linked_campaigns: {
    label: "Not paused — no linked campaigns",
    tone: "unknown",
    detail: "A campaign integration is active, but no campaigns are linked to this mailbox or domain. Nothing was paused.",
  },
  pause_requested: {
    label: "Pause requested (awaiting confirmation)",
    tone: "stale",
    detail: "A pause was requested from the sending system. Campaigns are not known to be paused until it confirms.",
  },
  pause_confirmed: { label: "Pause confirmed by sending system", tone: "good", detail: "The sending system confirmed the pause of the linked campaigns." },
  pause_failed: { label: "Pause failed", tone: "bad", detail: "The pause request failed. Campaigns are not known to be paused — check your sending tool." },
};

export const ACTION_POLICY_LABEL: Record<"notify_only" | "pause_campaigns", string> = {
  notify_only: "Monitor only",
  pause_campaigns: "Request campaign pause",
};

export const ALERT_STATUS: Record<"open" | "acknowledged" | "resolved", { label: string; tone: PillTone }> = {
  open: { label: "Open", tone: "warn" },
  acknowledged: { label: "Acknowledged", tone: "info" },
  resolved: { label: "Resolved", tone: "unknown" },
};

export const COMPARATOR_SYMBOL: Record<"gt" | "gte", string> = { gt: ">", gte: "≥" };

const RATE_METRICS = new Set<AlertMetric>(["bounce_rate", "hard_bounce_rate"]);
export const isRateMetric = (metric: AlertMetric) => RATE_METRICS.has(metric);

/** Rates as percentages; missing values are "Not measured", never zero. */
export function formatMetricValue(metric: AlertMetric, value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "Not measured";
  return isRateMetric(metric) ? pct(value, digits) : String(Math.round(value * 100) / 100);
}

export function formatWindow(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} min`;
}

/** Event categories that make up the numerator of an event-based metric (mirrors lib/alerts/evaluate.ts). */
export const METRIC_EVENT_CATEGORIES: Partial<Record<AlertMetric, EventCategory[]>> = {
  bounce_rate: ["hard_bounce", "soft_bounce", "bounce_unclassified"],
  hard_bounce_rate: ["hard_bounce"],
  complaint_count: ["complaint"],
  provider_error_count: ["provider_error", "sending_limit"],
  sent_volume: ["sent"],
};

export const CAMPAIGN_ACTION_STATUS: Record<"queued" | "sent" | "confirmed" | "failed" | "unconfirmed", { pause: string; resume: string; tone: PillTone }> = {
  queued: { pause: "Queued — not paused", resume: "Queued — not resumed", tone: "stale" },
  sent: { pause: "Sent — awaiting confirmation (not confirmed paused)", resume: "Sent — awaiting confirmation", tone: "stale" },
  confirmed: { pause: "Paused — confirmed by sending system", resume: "Resumed — confirmed by sending system", tone: "good" },
  unconfirmed: { pause: "Unconfirmed — not known to be paused", resume: "Unconfirmed — not known to be resumed", tone: "unknown" },
  failed: { pause: "Failed — not paused", resume: "Failed — not resumed", tone: "bad" },
};

export const NOTIFICATION_STATUS: Record<"pending" | "sent" | "failed" | "not_configured", { label: string; tone: PillTone }> = {
  pending: { label: "Pending", tone: "stale" },
  sent: { label: "Sent", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
  not_configured: { label: "Not sent — email delivery is not configured", tone: "unknown" },
};

export const NOTIFICATION_CHANNEL: Record<"in_app" | "email" | "webhook", string> = { in_app: "In-app", email: "Email", webhook: "Webhook" };
