import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { getOrgHealth } from "@/lib/health/service";

export const dynamic = "force-dynamic";
export const GET = withOrgAuth(async ({ principal }) => ok(await getOrgHealth(principal.orgId)), { permission: "domain:view" });
