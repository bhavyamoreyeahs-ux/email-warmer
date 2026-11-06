import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { listNotifications } from "@/lib/alerts/service";

export const dynamic = "force-dynamic";
export const GET = withOrgAuth(async ({ principal }) => ok(await listNotifications(principal.orgId)), { permission: "alert:view" });
