import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { dailyEventSeries, mailboxSummary, parseRange, periodCounts } from "@/lib/reports/summary";

export const dynamic = "force-dynamic";
export const GET = withOrgAuth(
  async ({ req, principal }) => {
    const range = parseRange(req.nextUrl.searchParams);
    const [daily, mailboxes, counts] = await Promise.all([dailyEventSeries(principal.orgId, range), mailboxSummary(principal.orgId, range), periodCounts(principal.orgId, range)]);
    return ok({ range: { from: range.from.toISOString(), to: range.to.toISOString() }, daily, mailboxes, counts });
  },
  { permission: "report:view" },
);
