/** Display helpers shared by server and client components. */
import type { CheckStatus, ConnectionState, EventCategory, HealthState } from "@/lib/db/schema";

export function relativeTime(value: Date | string | null | undefined, now = Date.now()): string {
  if (!value) return "never";
  const t = typeof value === "string" ? new Date(value).getTime() : value.getTime();
  const diff = Math.round((now - t) / 1000);
  const abs = Math.abs(diff);
  const fmt = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  const s = abs < 60 ? fmt(abs, "second") : abs < 3600 ? fmt(Math.round(abs / 60), "minute") : abs < 86400 ? fmt(Math.round(abs / 3600), "hour") : fmt(Math.round(abs / 86400), "day");
  return diff >= 0 ? `${s} ago` : `in ${s}`;
}

export function dateTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function pct(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined || Number.isNaN(v) ? "—" : `${(v * 100).toFixed(digits)}%`;
}

export const HEALTH_LABEL: Record<HealthState, string> = { healthy: "Healthy", at_risk: "At risk", critical: "Critical", unknown: "Unknown", stale: "Stale" };
export const CHECK_LABEL: Record<CheckStatus, string> = { pass: "Pass", warn: "Warning", fail: "Fail", inconclusive: "Inconclusive" };
export const CONNECTION_LABEL: Record<ConnectionState, string> = {
  pending: "Validating",
  connected: "Connected",
  degraded: "Degraded",
  reauth_required: "Reconnect required",
  disconnected: "Disconnected",
  paused: "Paused",
  demo: "Demo data",
};
export const CATEGORY_LABEL: Record<EventCategory, string> = {
  sent: "Sent (provider-recorded)",
  hard_bounce: "Hard bounce",
  soft_bounce: "Soft bounce",
  bounce_unclassified: "Bounce (unclassified)",
  complaint: "Complaint report",
  unsubscribe: "Unsubscribe request",
  reply: "Reply",
  auto_reply: "Auto-reply",
  provider_error: "Provider error",
  sending_limit: "Sending limit notice",
  unknown: "Unknown outcome",
};
export const PROVIDER_LABEL: Record<string, string> = { google: "Google Workspace / Gmail", microsoft: "Microsoft 365 / Outlook", demo: "Demo (sample data)" };
