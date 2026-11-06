import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { getAlertDetail } from "@/lib/alerts/service";

export const dynamic = "force-dynamic";
export const GET = withOrgAuth<{ id: string }>(async ({ params, principal }) => ok(await getAlertDetail(principal.orgId, params.id)), { permission: "alert:view" });
