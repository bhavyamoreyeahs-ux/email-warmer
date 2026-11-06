import { z } from "zod";
import { created, ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { parseBody } from "@/lib/api/validation";
import { ROLES } from "@/lib/db/schema";
import { createInvitation, listInvitations } from "@/lib/tenancy/invitations";

export const dynamic = "force-dynamic";
export const GET = withOrgAuth(async ({ principal }) => ok(await listInvitations(principal.orgId)), { permission: "member:view" });

export const POST = withOrgAuth(
  async ({ req, principal, requestId }) => {
    const body = await parseBody(req, z.object({ email: z.string().trim().email().max(254), role: z.enum(ROLES) }));
    const result = await createInvitation(principal, body, requestId);
    // The accept URL (containing the raw token) is returned exactly once so the inviter can share it.
    return created({ invitation: result.invitation, acceptUrl: result.acceptUrl, emailStatus: result.emailStatus });
  },
  { permission: "member:invite", rateLimit: { limit: 30, windowSeconds: 3600 } },
);
