import { ok } from "@/lib/api/responses";
import { withOrgAuth, noContent } from "@/lib/api/with-org-auth";
import { parseBody } from "@/lib/api/validation";
import { alertRuleInput } from "@/lib/alerts/schemas";
import { deleteRule, getRule, updateRule } from "@/lib/alerts/rules";

export const dynamic = "force-dynamic";
export const GET = withOrgAuth<{ id: string }>(async ({ params, principal }) => ok(await getRule(principal.orgId, params.id)), { permission: "alert_rule:view" });
export const PUT = withOrgAuth<{ id: string }>(
  async ({ req, params, principal, actor, requestId }) => ok(await updateRule(principal.orgId, params.id, await parseBody(req, alertRuleInput), actor, requestId)),
  { permission: "alert_rule:manage" },
);
export const DELETE = withOrgAuth<{ id: string }>(
  async ({ params, principal, actor, requestId }) => {
    await deleteRule(principal.orgId, params.id, actor, requestId);
    return noContent();
  },
  { permission: "alert_rule:manage" },
);
