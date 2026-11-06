import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { getMailboxDetail } from "@/lib/mailboxes/service";

export const dynamic = "force-dynamic";
export const GET = withOrgAuth<{ id: string }>(async ({ params, principal }) => ok(await getMailboxDetail(principal.orgId, params.id)), { permission: "mailbox:view" });
