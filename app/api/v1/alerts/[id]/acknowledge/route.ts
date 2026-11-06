import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { acknowledgeAlert } from "@/lib/alerts/service";

export const POST = withOrgAuth<{ id: string }>(
  async ({ params, principal, actor, requestId }) => ok(await acknowledgeAlert(principal.orgId, params.id, actor, requestId)),
  { permission: "alert:acknowledge" },
);
