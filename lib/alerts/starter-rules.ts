/**
 * Starter alert rules created for every new workspace. All are MONITOR-ONLY
 * (notify_only). Thresholds are conservative starting points, not provider
 * guarantees — every rule says so in its description, and customers should
 * tune them to their sending patterns. Values need a product owner sign-off
 * (docs/launch-dependencies.md).
 */
import type { alertRules } from "@/lib/db/schema";

type StarterRule = Omit<typeof alertRules.$inferInsert, "orgId">;

const REVIEW = "Starter rule — review the threshold for your sending patterns.";

export const STARTER_RULES: StarterRule[] = [
  {
    name: "Bounce rate elevated (24h)",
    description: `Observed bounces divided by provider-recorded sent messages over 24 hours. ${REVIEW}`,
    metric: "bounce_rate",
    threshold: 0.05,
    windowMinutes: 1440,
    minSample: 50,
    severity: "warning",
    notificationTargets: { inApp: true, emails: [] },
  },
  {
    name: "Bounce rate critical (24h)",
    description: `Same measurement as above at a higher threshold. ${REVIEW}`,
    metric: "bounce_rate",
    threshold: 0.1,
    windowMinutes: 1440,
    minSample: 50,
    severity: "critical",
    notificationTargets: { inApp: true, emails: [] },
  },
  {
    name: "Complaint feedback received (7d)",
    description: `Feedback-loop (ARF) complaint reports delivered to a connected mailbox. Most providers do not expose complaints to mailbox APIs, so absence of complaints here is not evidence of zero complaints. ${REVIEW}`,
    metric: "complaint_count",
    threshold: 1,
    windowMinutes: 10080,
    minSample: 0,
    severity: "warning",
    notificationTargets: { inApp: true, emails: [] },
  },
  {
    name: "Provider errors (24h)",
    description: `Provider-side rejections, policy blocks and sending-limit notices observed in connected mailboxes. ${REVIEW}`,
    metric: "provider_error_count",
    threshold: 5,
    windowMinutes: 1440,
    minSample: 0,
    severity: "warning",
    notificationTargets: { inApp: true, emails: [] },
  },
  {
    name: "DNS authentication check failing",
    description: "Latest scan of a monitored domain has an SPF, DKIM, DMARC or MX check in a failed state.",
    metric: "dns_check_failing",
    threshold: 1,
    windowMinutes: 1440,
    minSample: 0,
    severity: "critical",
    notificationTargets: { inApp: true, emails: [] },
  },
  {
    name: "Mailbox connection needs attention",
    description: "A connected mailbox requires re-authentication or is repeatedly failing to sync.",
    metric: "mailbox_connection_unhealthy",
    threshold: 1,
    windowMinutes: 60,
    minSample: 0,
    severity: "warning",
    notificationTargets: { inApp: true, emails: [] },
  },
  {
    name: "Mailbox data is stale",
    description: "No successful sync within the stale threshold — health for that mailbox is unknown, not healthy.",
    metric: "sync_stale",
    threshold: 1,
    windowMinutes: 60,
    minSample: 0,
    severity: "info",
    notificationTargets: { inApp: true, emails: [] },
  },
];
