/** CSV export honouring the same filters as the event table, tenant-scoped, role-checked, audited. */
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { EVENT_CSV_COLUMNS, exportEvents, parseEventFilters } from "@/lib/events/search";
import { csvResponse, toCsv } from "@/lib/reports/csv";

export const dynamic = "force-dynamic";
export const GET = withOrgAuth(
  async ({ req, principal, audit }) => {
    const filters = parseEventFilters(req.nextUrl.searchParams);
    const { rows, truncated } = await exportEvents(principal.orgId, filters);
    await audit({ action: "event.export", targetType: "events", outcome: "success", metadata: { rows: rows.length, truncated, filters: { ...filters, limit: undefined, offset: undefined } } });
    const res = csvResponse(toCsv(rows as unknown as Record<string, unknown>[], [...EVENT_CSV_COLUMNS]), `quikreach-events-${new Date().toISOString().slice(0, 10)}.csv`);
    if (truncated) res.headers.set("x-quikreach-truncated", "true");
    return res;
  },
  { permission: "event:export", rateLimit: { limit: 10, windowSeconds: 600 } },
);
