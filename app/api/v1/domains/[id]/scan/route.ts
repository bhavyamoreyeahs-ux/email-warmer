import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { requestScan } from "@/lib/domains/service";

export const POST = withOrgAuth<{ id: string }>(
  async ({ req, params, principal, actor, requestId }) => {
    const trigger = req.nextUrl.searchParams.get("trigger") === "recheck" ? "recheck" : "manual";
    const result = await requestScan(principal.orgId, params.id, trigger, actor, requestId);
    return ok({ scanId: result.scan.id, status: result.scan.status, deduplicated: result.deduplicated }, 202);
  },
  { permission: "domain:scan", liveDataOperation: true },
);
