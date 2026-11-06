/** Validation for alert-rule input — shared by the API and the rule builder UI. */
import { z } from "zod";
import { ALERT_METRICS, SEVERITIES } from "@/lib/db/schema";

export const alertRuleInput = z
  .object({
    name: z.string().trim().min(3).max(120),
    description: z.string().trim().max(500).default(""),
    metric: z.enum(ALERT_METRICS),
    scopeType: z.enum(["organization", "domain", "mailbox"]).default("organization"),
    scopeId: z.string().uuid().nullable().optional(),
    comparator: z.enum(["gt", "gte"]).default("gte"),
    threshold: z.number().finite().min(0).max(1_000_000),
    windowMinutes: z.number().int().min(5).max(43_200),
    minSample: z.number().int().min(0).max(1_000_000).default(0),
    severity: z.enum(SEVERITIES),
    notificationTargets: z.object({
      inApp: z.boolean().default(true),
      emails: z.array(z.string().email().max(254)).max(10).default([]),
      webhookIntegrationId: z.string().uuid().nullable().optional(),
    }),
    actionPolicy: z.enum(["notify_only", "pause_campaigns"]).default("notify_only"),
    requireManualResume: z.boolean().default(true),
    cooldownMinutes: z.number().int().min(0).max(10_080).default(60),
    enabled: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.scopeType !== "organization" && !v.scopeId) ctx.addIssue({ code: "custom", path: ["scopeId"], message: "Choose the domain or mailbox this rule applies to." });
    if ((v.metric === "bounce_rate" || v.metric === "hard_bounce_rate") && v.threshold > 1) {
      ctx.addIssue({ code: "custom", path: ["threshold"], message: "Rate thresholds are fractions between 0 and 1 (e.g. 0.05 = 5%)." });
    }
    if ((v.metric === "bounce_rate" || v.metric === "hard_bounce_rate") && v.minSample < 1) {
      ctx.addIssue({ code: "custom", path: ["minSample"], message: "Rate rules need a minimum sample of at least 1 sent message (we recommend 50+)." });
    }
    if (v.severity === "critical" && v.actionPolicy === "pause_campaigns" && !v.requireManualResume) {
      ctx.addIssue({ code: "custom", path: ["requireManualResume"], message: "Critical rules that pause campaigns must require manual review before resumption." });
    }
  });

export type AlertRuleInput = z.infer<typeof alertRuleInput>;

export const METRIC_INFO: Record<(typeof ALERT_METRICS)[number], { label: string; unit: "rate" | "count"; help: string }> = {
  bounce_rate: { label: "Bounce rate", unit: "rate", help: "Observed bounces ÷ provider-recorded sends in the window." },
  hard_bounce_rate: { label: "Hard bounce rate", unit: "rate", help: "Bounces classified as permanent ÷ sends. Classification is header/subject-based and may be partial." },
  complaint_count: { label: "Complaint reports", unit: "count", help: "Feedback-loop reports delivered to connected mailboxes (partial visibility)." },
  provider_error_count: { label: "Provider errors & sending limits", unit: "count", help: "Provider policy rejections and sending-limit notices." },
  sent_volume: { label: "Sending volume", unit: "count", help: "Provider-recorded outbound messages (not proof of delivery)." },
  dns_check_failing: { label: "Failing DNS checks", unit: "count", help: "Failing checks in each monitored domain's latest scan." },
  mailbox_connection_unhealthy: { label: "Unhealthy mailbox connection", unit: "count", help: "Reconnect required, or 3+ consecutive sync failures." },
  sync_stale: { label: "Stale mailbox data", unit: "count", help: "No successful sync within the workspace's stale threshold (Settings; default 2 hours) while connected." },
};
