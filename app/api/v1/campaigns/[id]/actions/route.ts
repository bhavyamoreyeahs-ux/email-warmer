/** Request a pause/resume. The response is the QUEUED request; the outcome is recorded only when the sending system confirms. */
import { z } from "zod";
import { kickWorker } from "@/lib/jobs/kick";
import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { parseBody } from "@/lib/api/validation";
import { requestCampaignAction } from "@/lib/campaigns/service";

export const POST = withOrgAuth<{ id: string }>(
  async ({ req, params, principal, requestId }) => {
    const body = await parseBody(req, z.object({ action: z.enum(["pause", "resume"]), reason: z.string().trim().min(3).max(500) }));
    const action = await requestCampaignAction(principal, params.id, body.action, body.reason, requestId);
    kickWorker();
    return ok({ actionId: action.id, status: action.status, note: "Requested. The campaign state changes only when the sending system confirms it." }, 202);
  },
  { permission: "campaign:view", liveDataOperation: true },
);
