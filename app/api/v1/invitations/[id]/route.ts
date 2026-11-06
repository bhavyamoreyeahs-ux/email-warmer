import { withOrgAuth, noContent } from "@/lib/api/with-org-auth";
import { revokeInvitation } from "@/lib/tenancy/invitations";

export const DELETE = withOrgAuth<{ id: string }>(
  async ({ params, principal, requestId }) => {
    await revokeInvitation(principal, params.id, requestId);
    return noContent();
  },
  { permission: "member:invite" },
);
