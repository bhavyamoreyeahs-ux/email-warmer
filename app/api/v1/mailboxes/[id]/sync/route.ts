import { ok } from "@/lib/api/responses";
import { kickWorker } from "@/lib/jobs/kick";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { requestSync } from "@/lib/mailboxes/service";

export const POST = withOrgAuth<{ id: string }>(
  async ({ params, principal, actor, requestId }) => {
    const r = await requestSync(principal.orgId, params.id, actor, requestId);
    kickWorker();
    return ok(r, 202);
  },
  { permission: "mailbox:sync" },
);
