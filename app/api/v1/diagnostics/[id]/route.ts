import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { getDiagnosis } from "@/lib/ai/service";

export const dynamic = "force-dynamic";
export const GET = withOrgAuth<{ id: string }>(async ({ params, principal }) => ok(await getDiagnosis(principal.orgId, params.id)), { permission: "diagnostic:view" });
