/**
 * QuikReach health evaluation.
 *
 * Three SEPARATE, explainable states — never blended into a single opaque score:
 *   1. Domain configuration (latest DNS checks + freshness)
 *   2. Mailbox health (connection state, freshness, observed event rates)
 *   3. Campaign safety (open alerts, data freshness, available controls)
 *
 * Every state expands into its inputs (with evidence references) and an
 * explicit list of missing data. Unknown/inconclusive inputs make the state
 * `unknown`; stale data makes it `stale`. Neither is ever reported as healthy.
 *
 * These are QuikReach's own heuristics (versioned below), NOT a mailbox
 * provider's reputation score, and they do not predict inbox placement.
 */
import type { CheckStatus, CheckType, ConnectionState, HealthInput, HealthState } from "@/lib/db/schema";

export const HEALTH_RULE_VERSION = "health-2026.10.1";

/** Thresholds for observed rates — QuikReach heuristics, documented in docs/health-model.md. */
export const MAILBOX_THRESHOLDS = {
  minSentForRate: 20,
  bounceRateAtRisk: 0.02,
  bounceRateCritical: 0.05,
  windowDays: 7,
} as const;

const SEVERITY: Record<HealthState, number> = { critical: 5, at_risk: 4, stale: 3, unknown: 2, healthy: 1 };

/** critical > at_risk > stale > unknown > healthy. */
export function combineStates(states: HealthState[]): HealthState {
  if (!states.length) return "unknown";
  return states.reduce((worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst), "healthy" as HealthState);
}

export interface HealthResult {
  state: HealthState;
  inputs: HealthInput[];
  missing: string[];
  ruleVersion: string;
}

/* ─── Domain configuration ────────────────────────────────────────────── */

export interface DomainCheckLite {
  id: string;
  checkType: CheckType;
  status: CheckStatus;
  summary: string;
  checkedAt: Date;
}

const CHECK_LABEL: Record<CheckType, string> = { mx: "MX (inbound mail routing)", spf: "SPF", dkim: "DKIM", dmarc: "DMARC" };

export function checkStatusToHealth(status: CheckStatus): HealthState {
  switch (status) {
    case "pass":
      return "healthy";
    case "warn":
      return "at_risk";
    case "fail":
      return "critical";
    default:
      return "unknown";
  }
}

export function evaluateDomainHealth(input: { checks: DomainCheckLite[]; lastScanAt: Date | null; verified: boolean; now: Date; staleAfterDays?: number }): HealthResult {
  const staleAfterMs = (input.staleAfterDays ?? 7) * 86_400_000;
  const inputs: HealthInput[] = [];
  const missing: string[] = [];

  for (const type of ["mx", "spf", "dkim", "dmarc"] as CheckType[]) {
    const c = input.checks.find((x) => x.checkType === type);
    if (!c) {
      missing.push(`${CHECK_LABEL[type]}: no completed check yet`);
      inputs.push({ key: `dns.${type}`, label: CHECK_LABEL[type], state: "unknown", detail: "Not checked yet.", observedAt: null, evidenceRefs: [] });
      continue;
    }
    if (c.status === "inconclusive") missing.push(`${CHECK_LABEL[type]}: inconclusive — ${c.summary}`);
    inputs.push({
      key: `dns.${type}`,
      label: CHECK_LABEL[type],
      state: checkStatusToHealth(c.status),
      detail: c.summary,
      observedAt: c.checkedAt.toISOString(),
      evidenceRefs: [`check:${c.id}`],
    });
  }

  const stale = !input.lastScanAt || input.now.getTime() - input.lastScanAt.getTime() > staleAfterMs;
  inputs.push({
    key: "dns.freshness",
    label: "Scan freshness",
    state: stale ? "stale" : "healthy",
    detail: input.lastScanAt ? `Last completed scan ${input.lastScanAt.toISOString()}.` : "Never scanned.",
    observedAt: input.lastScanAt?.toISOString() ?? null,
    evidenceRefs: [],
  });
  if (!input.verified) missing.push("Domain ownership not verified — scheduled monitoring and alerts are limited until it is.");

  return { state: combineStates(inputs.filter((i) => !i.informational).map((i) => i.state)), inputs, missing, ruleVersion: HEALTH_RULE_VERSION };
}

/* ─── Mailbox health ──────────────────────────────────────────────────── */

export interface MailboxHealthInput {
  connectionId: string;
  state: ConnectionState;
  stateReason: string | null;
  lastSuccessfulSyncAt: Date | null;
  /** Event counts by category over MAILBOX_THRESHOLDS.windowDays. */
  counts: Record<string, number>;
  /** Capability statuses by key. */
  capabilities: Record<string, string>;
  now: Date;
  staleAfterHours?: number;
}

export function evaluateMailboxHealth(m: MailboxHealthInput): HealthResult {
  const inputs: HealthInput[] = [];
  const missing: string[] = [];
  const ref = `conn:${m.connectionId}`;

  const connState: Record<ConnectionState, HealthState> = {
    connected: "healthy",
    degraded: "at_risk",
    reauth_required: "critical",
    pending: "unknown",
    paused: "unknown",
    disconnected: "unknown",
    demo: "healthy",
  };
  inputs.push({
    key: "mailbox.connection",
    label: "Connection",
    state: connState[m.state],
    detail: m.state === "demo" ? "Demo connection — seeded sample data, not a live mailbox." : m.stateReason ?? `Connection is ${m.state.replace(/_/g, " ")}.`,
    observedAt: null,
    evidenceRefs: [ref],
  });

  const staleMs = (m.staleAfterHours ?? 2) * 3_600_000;
  const fresh = m.state === "demo" || (m.lastSuccessfulSyncAt !== null && m.now.getTime() - m.lastSuccessfulSyncAt.getTime() <= staleMs);
  inputs.push({
    key: "mailbox.freshness",
    label: "Data freshness",
    state: fresh ? "healthy" : "stale",
    detail: m.lastSuccessfulSyncAt ? `Last successful sync ${m.lastSuccessfulSyncAt.toISOString()}.` : "No successful sync yet.",
    observedAt: m.lastSuccessfulSyncAt?.toISOString() ?? null,
    evidenceRefs: [ref],
  });
  if (!fresh) missing.push("Recent mailbox data (sync is stale or has not run).");

  const sent = m.counts.sent ?? 0;
  const bounces = (m.counts.hard_bounce ?? 0) + (m.counts.soft_bounce ?? 0) + (m.counts.bounce_unclassified ?? 0);
  if (m.capabilities.sent_volume === "unavailable" || m.capabilities.bounce_detection === "unavailable") {
    missing.push("Bounce rate: required permission not available for this mailbox.");
    inputs.push({ key: "mailbox.bounce_rate", label: `Bounce rate (${MAILBOX_THRESHOLDS.windowDays}d)`, state: "unknown", detail: "Not measurable with the granted permissions.", observedAt: null, evidenceRefs: [] });
  } else if (sent < MAILBOX_THRESHOLDS.minSentForRate) {
    missing.push(`Bounce rate: only ${sent} sent messages observed (minimum ${MAILBOX_THRESHOLDS.minSentForRate} for a meaningful rate).`);
    inputs.push({
      key: "mailbox.bounce_rate",
      label: `Bounce rate (${MAILBOX_THRESHOLDS.windowDays}d)`,
      state: "unknown",
      detail: `Insufficient sample: ${bounces} bounces / ${sent} sent.`,
      observedAt: null,
      evidenceRefs: [`events:${m.connectionId}:bounces:${MAILBOX_THRESHOLDS.windowDays}d`],
    });
  } else {
    const rate = bounces / sent;
    const state: HealthState = rate >= MAILBOX_THRESHOLDS.bounceRateCritical ? "critical" : rate >= MAILBOX_THRESHOLDS.bounceRateAtRisk ? "at_risk" : "healthy";
    inputs.push({
      key: "mailbox.bounce_rate",
      label: `Bounce rate (${MAILBOX_THRESHOLDS.windowDays}d)`,
      state,
      detail: `${(rate * 100).toFixed(1)}% observed (${bounces} bounces / ${sent} provider-recorded sends). Observed in this mailbox only.`,
      observedAt: m.now.toISOString(),
      evidenceRefs: [`events:${m.connectionId}:bounces:${MAILBOX_THRESHOLDS.windowDays}d`],
    });
  }

  const providerErrors = (m.counts.provider_error ?? 0) + (m.counts.sending_limit ?? 0);
  inputs.push({
    key: "mailbox.provider_errors",
    label: `Provider errors & limits (${MAILBOX_THRESHOLDS.windowDays}d)`,
    state: providerErrors > 0 ? "at_risk" : fresh ? "healthy" : "unknown",
    detail: providerErrors > 0 ? `${providerErrors} provider rejection or sending-limit notices observed.` : "None observed.",
    observedAt: null,
    evidenceRefs: [`events:${m.connectionId}:provider_errors:${MAILBOX_THRESHOLDS.windowDays}d`],
  });

  const complaints = m.counts.complaint ?? 0;
  inputs.push({
    key: "mailbox.complaints",
    label: "Complaint feedback",
    state: complaints > 0 ? "at_risk" : "unknown",
    detail:
      complaints > 0
        ? `${complaints} feedback-loop complaint report(s) observed.`
        : "No complaint reports observed. Mailbox APIs only expose feedback reports delivered to this mailbox, so this is not evidence of zero complaints.",
    observedAt: null,
    evidenceRefs: complaints > 0 ? [`events:${m.connectionId}:complaint:${MAILBOX_THRESHOLDS.windowDays}d`] : [],
    informational: complaints === 0,
  });
  missing.push("Inbox placement: not measured (mailbox APIs cannot see recipients' inboxes).");

  // Complaint "unknown" is informational: on its own it should not make a
  // mailbox look broken, so informational inputs are excluded from the combined state.
  return { state: combineStates(inputs.filter((i) => !i.informational).map((i) => i.state)), inputs, missing, ruleVersion: HEALTH_RULE_VERSION };
}

/* ─── Campaign safety ─────────────────────────────────────────────────── */

export function evaluateCampaignSafety(input: {
  openAlerts: Array<{ id: string; severity: "info" | "warning" | "critical"; title: string }>;
  mailboxesTotal: number;
  mailboxesFresh: number;
  campaignIntegrationActive: boolean;
}): HealthResult {
  const inputs: HealthInput[] = [];
  const missing: string[] = [];
  const critical = input.openAlerts.filter((a) => a.severity === "critical");
  const warning = input.openAlerts.filter((a) => a.severity === "warning");
  inputs.push({
    key: "safety.alerts",
    label: "Open alerts",
    state: critical.length ? "critical" : warning.length ? "at_risk" : "healthy",
    detail: input.openAlerts.length ? `${critical.length} critical, ${warning.length} warning open.` : "No open warning or critical alerts.",
    observedAt: null,
    evidenceRefs: input.openAlerts.map((a) => `alert:${a.id}`),
  });
  inputs.push({
    key: "safety.coverage",
    label: "Monitoring coverage",
    state: input.mailboxesTotal === 0 ? "unknown" : input.mailboxesFresh === input.mailboxesTotal ? "healthy" : input.mailboxesFresh === 0 ? "stale" : "at_risk",
    detail: input.mailboxesTotal === 0 ? "No mailboxes connected." : `${input.mailboxesFresh} of ${input.mailboxesTotal} mailboxes have fresh data.`,
    observedAt: null,
    evidenceRefs: [],
  });
  if (input.mailboxesTotal === 0) missing.push("Connect a mailbox to monitor sending signals.");
  inputs.push({
    key: "safety.controls",
    label: "Campaign controls",
    state: "unknown",
    informational: true,
    detail: input.campaignIntegrationActive
      ? "A campaign integration is configured; rules with a pause policy can request pauses (confirmed by the sending system)."
      : "Monitor-only: no campaign integration is configured, so QuikReach can alert but cannot pause campaigns.",
    observedAt: null,
    evidenceRefs: [],
  });
  return { state: combineStates(inputs.filter((i) => !i.informational).map((i) => i.state)), inputs, missing, ruleVersion: HEALTH_RULE_VERSION };
}
