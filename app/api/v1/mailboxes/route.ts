import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { listMailboxes } from "@/lib/mailboxes/service";

export const dynamic = "force-dynamic";
export const GET = withOrgAuth(async ({ principal }) => ok(await listMailboxes(principal.orgId)), { permission: "mailbox:view" });
