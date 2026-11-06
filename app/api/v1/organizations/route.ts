/** Create an additional workspace (the caller becomes its owner). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withUserAuth } from "@/lib/api/with-org-auth";
import { parseBody } from "@/lib/api/validation";
import { createOrganizationWithOwner } from "@/lib/tenancy/organizations";
import { ORG_COOKIE } from "@/lib/api/session";
import { env } from "@/lib/env";

export const POST = withUserAuth(async ({ req, userId, email }) => {
  const { name } = await parseBody(req, z.object({ name: z.string().trim().min(2).max(100) }));
  const org = await createOrganizationWithOwner({ name, ownerUserId: userId, actor: { type: "user", userId, label: email } });
  const res = NextResponse.json({ success: true, data: { id: org.id, name: org.name } }, { status: 201 });
  res.cookies.set(ORG_COOKIE, org.id, { httpOnly: true, sameSite: "lax", secure: env().APP_URL.startsWith("https://"), path: "/", maxAge: 60 * 60 * 24 * 180 });
  return res;
});
