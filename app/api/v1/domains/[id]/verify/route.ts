import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { verifyDomain } from "@/lib/domains/service";

export const POST = withOrgAuth<{ id: string }>(
  async ({ params, principal, actor, requestId }) => {
    const r = await verifyDomain(principal.orgId, params.id, actor, requestId);
    return ok({ verified: r.verified, detail: r.detail, verificationStatus: r.domain.verificationStatus });
  },
  { permission: "domain:update", liveDataOperation: true },
);
