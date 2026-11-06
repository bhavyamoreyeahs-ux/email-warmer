/** Dry-run a (possibly unsaved) rule against current data. No alerts, notifications or campaign actions are created. */
import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { parseBody } from "@/lib/api/validation";
import { alertRuleInput } from "@/lib/alerts/schemas";
import { testRule } from "@/lib/alerts/rules";

export const POST = withOrgAuth(
  async ({ req, principal, actor, requestId }) => ok(await testRule(principal.orgId, await parseBody(req, alertRuleInput), actor, requestId)),
  { permission: "alert_rule:test", rateLimit: { limit: 30, windowSeconds: 60 } },
);
