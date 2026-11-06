import { z } from "zod";
import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { parseBody } from "@/lib/api/validation";
import { resolveAlert } from "@/lib/alerts/service";

export const POST = withOrgAuth<{ id: string }>(
  async ({ req, params, principal, actor, requestId }) => {
    const { note } = await parseBody(req, z.object({ note: z.string().trim().min(3).max(1000) }));
    return ok(await resolveAlert(principal.orgId, params.id, note, actor, requestId));
  },
  { permission: "alert:resolve" },
);
