import { z } from "zod";
import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { parseBody } from "@/lib/api/validation";
import { setIntegrationStatus } from "@/lib/integrations/service";

export const POST = withOrgAuth<{ id: string }>(
  async ({ req, params, principal, actor, requestId }) => {
    const body = await parseBody(req, z.object({ status: z.enum(["disabled", "revoked"]).default("revoked"), reason: z.string().trim().min(3).max(500) }));
    return ok(await setIntegrationStatus(principal.orgId, params.id, body.status, body.reason, actor, requestId));
  },
  { permission: "integration:manage" },
);
