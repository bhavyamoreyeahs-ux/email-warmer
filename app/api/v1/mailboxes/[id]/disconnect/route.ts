import { z } from "zod";
import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { parseBody } from "@/lib/api/validation";
import { disconnectMailbox } from "@/lib/mailboxes/service";

export const POST = withOrgAuth<{ id: string }>(
  async ({ req, params, principal, actor, requestId }) => {
    const body = await parseBody(req, z.object({ reason: z.string().trim().min(3).max(500), deleteEvents: z.boolean().default(false) }));
    return ok(await disconnectMailbox(principal.orgId, params.id, body, actor, requestId));
  },
  { permission: "mailbox:disconnect" },
);
