import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { testIntegration } from "@/lib/integrations/service";

export const POST = withOrgAuth<{ id: string }>(
  async ({ params, principal, actor, requestId }) => ok(await testIntegration(principal.orgId, params.id, actor, requestId)),
  { permission: "integration:manage", rateLimit: { limit: 10, windowSeconds: 60 } },
);
