/** CSV export of the report for the selected period (mailbox summary or daily series), audited. */
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { dailyEventSeries, mailboxSummary, parseRange } from "@/lib/reports/summary";
import { csvResponse, toCsv } from "@/lib/reports/csv";

export const dynamic = "force-dynamic";
export const GET = withOrgAuth(
  async ({ req, principal, audit }) => {
    const p = req.nextUrl.searchParams;
    const range = parseRange(p);
    const kind = p.get("kind") === "daily" ? "daily" : "mailboxes";
    const stamp = `${range.from.toISOString().slice(0, 10)}_${range.to.toISOString().slice(0, 10)}`;
    let csv: string;
    if (kind === "daily") {
      const rows = await dailyEventSeries(principal.orgId, range);
      csv = toCsv(rows, [
        { key: "day", header: "day_utc" },
        { key: "sent", header: "sent_provider_recorded" },
        { key: "bounces", header: "bounces_observed" },
        { key: "bounceRate", header: "bounce_rate" },
        { key: "replies", header: "replies_observed" },
        { key: "complaints", header: "complaint_reports_observed" },
        { key: "providerErrors", header: "provider_errors_and_limits" },
      ]);
    } else {
      const rows = await mailboxSummary(principal.orgId, range);
      csv = toCsv(rows, [
        { key: "email", header: "mailbox" },
        { key: "provider", header: "provider" },
        { key: "state", header: "connection_state" },
        { key: "isDemo", header: "is_demo_data" },
        { key: "sent", header: "sent_provider_recorded" },
        { key: "bounces", header: "bounces_observed" },
        { key: "hardBounces", header: "hard_bounces_observed" },
        { key: "bounceRate", header: "bounce_rate" },
        { key: "bounceRateNote", header: "bounce_rate_note" },
        { key: "replies", header: "replies_observed" },
        { key: "complaints", header: "complaint_reports_observed" },
        { key: "unsubscribes", header: "unsubscribe_requests_observed" },
        { key: "providerErrors", header: "provider_errors_and_limits" },
        { key: "successfulSyncsInPeriod", header: "successful_syncs_in_period" },
      ]);
    }
    await audit({ action: "report.export", targetType: "report", outcome: "success", metadata: { kind, from: range.from.toISOString(), to: range.to.toISOString() } });
    return csvResponse(csv, `quikreach-${kind}-${stamp}.csv`);
  },
  { permission: "report:export", rateLimit: { limit: 20, windowSeconds: 600 } },
);
