/** Which mailbox providers are configured in this deployment, with the scopes requested and why. */
import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { listProviderStatus } from "@/lib/mailboxes/providers/registry";

export const dynamic = "force-dynamic";
export const GET = withOrgAuth(async () => ok(listProviderStatus()), { permission: "mailbox:view" });
