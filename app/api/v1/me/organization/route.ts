/** Switch the active organisation. The cookie is only a preference; membership is verified here and on every request. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { memberships, organizations } from "@/lib/db/schema";
import { withUserAuth } from "@/lib/api/with-org-auth";
import { parseBody } from "@/lib/api/validation";
import { fail } from "@/lib/api/responses";
import { ORG_COOKIE } from "@/lib/api/session";
import { env } from "@/lib/env";

export const POST = withUserAuth(async ({ req, userId }) => {
  const { orgId } = await parseBody(req, z.object({ orgId: z.string().uuid() }));
  const [m] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId), eq(memberships.status, "active"), eq(organizations.status, "active")))
    .limit(1);
  if (!m) return fail(404, "NOT_FOUND", "Organization not found.");
  const res = NextResponse.json({ success: true, data: { orgId } });
  res.cookies.set(ORG_COOKIE, orgId, { httpOnly: true, sameSite: "lax", secure: env().APP_URL.startsWith("https://"), path: "/", maxAge: 60 * 60 * 24 * 180 });
  return res;
});
