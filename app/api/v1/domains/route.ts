import { z } from "zod";
import { created, ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { parseBody } from "@/lib/api/validation";
import { createDomain, listDomains } from "@/lib/domains/service";

export const dynamic = "force-dynamic";
export const GET = withOrgAuth(async ({ principal }) => ok(await listDomains(principal.orgId)), { permission: "domain:view" });

export const POST = withOrgAuth(
  async ({ req, principal, actor, requestId }) => {
    const { name } = await parseBody(req, z.object({ name: z.string().trim().min(3).max(300) }));
    return created(await createDomain(principal.orgId, name, actor, requestId));
  },
  { permission: "domain:create", liveDataOperation: true, rateLimit: { limit: 20, windowSeconds: 3600 } },
);
