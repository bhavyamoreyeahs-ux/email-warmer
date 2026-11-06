import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { getUsageOverview } from "@/lib/usage/overview";

export const dynamic = "force-dynamic";
export const GET = withOrgAuth(async ({ principal }) => ok(await getUsageOverview(principal.orgId)), { permission: "usage:view" });
