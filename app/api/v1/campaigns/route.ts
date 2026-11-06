import { created, ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { parseBody } from "@/lib/api/validation";
import { campaignInput, createCampaignReference, listCampaignActions, listCampaigns } from "@/lib/campaigns/service";

export const dynamic = "force-dynamic";
export const GET = withOrgAuth(
  async ({ principal }) => ok({ campaigns: await listCampaigns(principal.orgId), actions: await listCampaignActions(principal.orgId) }),
  { permission: "campaign:view" },
);
export const POST = withOrgAuth(
  async ({ req, principal, actor, requestId }) => created(await createCampaignReference(principal.orgId, await parseBody(req, campaignInput), actor, requestId)),
  { permission: "campaign:manage", liveDataOperation: true },
);
