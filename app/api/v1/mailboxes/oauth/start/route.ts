import { z } from "zod";
import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { parseBody } from "@/lib/api/validation";
import { startMailboxOAuth } from "@/lib/mailboxes/oauth";

export const POST = withOrgAuth(
  async ({ req, principal, requestId }) => {
    const body = await parseBody(req, z.object({ provider: z.enum(["google", "microsoft"]), reconnectConnectionId: z.string().uuid().optional() }));
    return ok(await startMailboxOAuth(principal, body.provider, body.reconnectConnectionId, requestId));
  },
  { permission: "mailbox:connect", liveDataOperation: true, rateLimit: { limit: 20, windowSeconds: 600 } },
);
