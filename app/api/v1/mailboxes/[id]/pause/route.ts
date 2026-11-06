import { z } from "zod";
import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { parseBody } from "@/lib/api/validation";
import { setMonitoringPaused } from "@/lib/mailboxes/service";

export const POST = withOrgAuth<{ id: string }>(
  async ({ req, params, principal, actor, requestId }) => {
    const { paused, reason } = await parseBody(req, z.object({ paused: z.boolean(), reason: z.string().trim().min(3).max(500) }));
    return ok(await setMonitoringPaused(principal.orgId, params.id, paused, reason, actor, requestId));
  },
  { permission: "mailbox:pause" },
);
