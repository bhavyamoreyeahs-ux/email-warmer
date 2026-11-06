import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { searchAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const GET = withOrgAuth(
  async ({ req, principal }) => {
    const p = req.nextUrl.searchParams;
    const date = (v: string | null) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v) : undefined);
    return ok(
      await searchAudit(principal.orgId, {
        q: p.get("q")?.slice(0, 100) || undefined,
        action: p.get("action") || undefined,
        outcome: p.get("outcome") || undefined,
        from: date(p.get("from")),
        to: date(p.get("to")),
        limit: Number(p.get("limit") ?? 50) || 50,
        offset: Number(p.get("offset") ?? 0) || 0,
      }),
    );
  },
  { permission: "audit:view" },
);
