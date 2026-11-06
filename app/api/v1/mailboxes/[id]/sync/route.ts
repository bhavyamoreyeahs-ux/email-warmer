import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { requestSync } from "@/lib/mailboxes/service";

export const POST = withOrgAuth<{ id: string }>(
  async ({ params, principal, actor, requestId }) => ok(await requestSync(principal.orgId, params.id, actor, requestId), 202),
  { permission: "mailbox:sync" },
);
