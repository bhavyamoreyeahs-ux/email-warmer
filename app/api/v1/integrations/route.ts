import { created, ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { parseBody } from "@/lib/api/validation";
import { createIntegration, integrationInput, listIntegrations, ROADMAP_INTEGRATIONS } from "@/lib/integrations/service";
import { listProviderStatus } from "@/lib/mailboxes/providers/registry";

export const dynamic = "force-dynamic";
export const GET = withOrgAuth(
  async ({ principal }) => ok({ integrations: await listIntegrations(principal.orgId), mailboxProviders: listProviderStatus(), roadmap: ROADMAP_INTEGRATIONS }),
  { permission: "integration:view" },
);
export const POST = withOrgAuth(
  async ({ req, principal, actor, requestId }) => {
    const result = await createIntegration(principal.orgId, await parseBody(req, integrationInput), actor, requestId);
    // signingSecret is returned once and never again.
    return created(result);
  },
  { permission: "integration:manage", liveDataOperation: true },
);
