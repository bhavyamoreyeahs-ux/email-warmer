import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { listAlerts } from "@/lib/alerts/service";

export const dynamic = "force-dynamic";
export const GET = withOrgAuth(
  async ({ req, principal }) => {
    const p = req.nextUrl.searchParams;
    const status = p.get("status");
    return ok(
      await listAlerts(principal.orgId, {
        status: status === "open" || status === "acknowledged" || status === "resolved" || status === "active" ? status : undefined,
        severity: p.get("severity") ?? undefined,
      }),
    );
  },
  { permission: "alert:view" },
);
