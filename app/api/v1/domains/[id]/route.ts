import { z } from "zod";
import { ok } from "@/lib/api/responses";
import { withOrgAuth, noContent } from "@/lib/api/with-org-auth";
import { parseBody } from "@/lib/api/validation";
import { deleteDomain, getDomainDetail, updateDomain } from "@/lib/domains/service";

export const dynamic = "force-dynamic";
export const GET = withOrgAuth<{ id: string }>(async ({ params, principal }) => ok(await getDomainDetail(principal.orgId, params.id)), { permission: "domain:view" });

export const PATCH = withOrgAuth<{ id: string }>(
  async ({ req, params, principal, actor, requestId }) => {
    const body = await parseBody(req, z.object({ dkimSelectors: z.array(z.string().max(63)).max(10).optional(), monitoringEnabled: z.boolean().optional() }));
    return ok(await updateDomain(principal.orgId, params.id, body, actor, requestId));
  },
  { permission: "domain:update", liveDataOperation: true },
);

export const DELETE = withOrgAuth<{ id: string }>(
  async ({ req, params, principal, actor, requestId }) => {
    await deleteDomain(principal.orgId, params.id, actor, (req.nextUrl.searchParams.get("reason") || "Removed by user").slice(0, 500), requestId);
    return noContent();
  },
  { permission: "domain:delete", liveDataOperation: true },
);
