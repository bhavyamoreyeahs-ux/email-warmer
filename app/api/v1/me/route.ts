import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { permissionsFor } from "@/lib/rbac";

export const dynamic = "force-dynamic";

export const GET = withOrgAuth(async ({ principal }) =>
  ok({
    user: { id: principal.userId, email: principal.email, name: principal.name },
    organization: { id: principal.orgId, name: principal.orgName, isDemo: principal.isDemoOrg, automationPaused: principal.automationPaused },
    role: principal.role,
    permissions: permissionsFor(principal.role),
    memberships: principal.memberships,
  }),
);
