import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { listMembers } from "@/lib/tenancy/members";

export const dynamic = "force-dynamic";
export const GET = withOrgAuth(async ({ principal }) => ok(await listMembers(principal.orgId)), { permission: "member:view" });
