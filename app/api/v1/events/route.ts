import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { parseEventFilters, searchEvents } from "@/lib/events/search";

export const dynamic = "force-dynamic";
export const GET = withOrgAuth(async ({ req, principal }) => ok(await searchEvents(principal.orgId, parseEventFilters(req.nextUrl.searchParams))), { permission: "event:view" });
