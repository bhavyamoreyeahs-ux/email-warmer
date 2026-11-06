/** Organisation-wide kill switch for automation (syncs, scheduled scans, automated campaign actions). */
import { z } from "zod";
import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { parseBody } from "@/lib/api/validation";
import { setAutomationPaused } from "@/lib/tenancy/organizations";

export const POST = withOrgAuth(
  async ({ req, principal, actor, requestId }) => {
    const { paused, reason } = await parseBody(req, z.object({ paused: z.boolean(), reason: z.string().trim().min(3).max(500) }));
    const org = await setAutomationPaused(principal.orgId, paused, reason, actor, requestId);
    return ok({ automationPaused: org.automationPaused });
  },
  { permission: "organization:update" },
);
