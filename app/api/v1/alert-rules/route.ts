import { created, ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { parseBody } from "@/lib/api/validation";
import { alertRuleInput } from "@/lib/alerts/schemas";
import { createRule, listRules } from "@/lib/alerts/rules";

export const dynamic = "force-dynamic";
export const GET = withOrgAuth(async ({ principal }) => ok(await listRules(principal.orgId)), { permission: "alert_rule:view" });
export const POST = withOrgAuth(
  async ({ req, principal, actor, requestId }) => created(await createRule(principal.orgId, await parseBody(req, alertRuleInput), actor, requestId)),
  { permission: "alert_rule:manage" },
);
