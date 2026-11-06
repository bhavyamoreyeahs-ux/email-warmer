/**
 * Invitation acceptance — the one intentionally unauthenticated, DB-touching
 * route (the token is the credential). Protections: hashed single-use token,
 * 7-day expiry, per-IP rate limit, uniform errors, transactional acceptance.
 * A signed-in user may only accept an invitation addressed to their email.
 */
import type { NextRequest } from "next/server";
import { z, ZodError } from "zod";
import { fail, ok, validationError } from "@/lib/api/responses";
import { ApiError } from "@/lib/api/errors";
import { isSameOrigin, readJson } from "@/lib/api/with-org-auth";
import { checkRateLimit } from "@/lib/ratelimit";
import { ipHash } from "@/lib/crypto/hash";
import { acceptInvitation } from "@/lib/tenancy/invitations";
import { resolvePrincipal } from "@/lib/api/principal";
import { reportError } from "@/lib/observability/logger";

const schema = z.object({ token: z.string().min(20).max(200), name: z.string().trim().max(100).optional(), password: z.string().max(200).optional() });

export async function POST(req: NextRequest) {
  try {
    if (!isSameOrigin(req)) return fail(403, "CSRF_REJECTED", "Cross-site request rejected.");
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const rl = await checkRateLimit(`invite-accept:${ipHash(ip)}`, 20, 900);
    if (!rl.allowed) return fail(429, "RATE_LIMITED", "Too many attempts. Try again later.");
    const body = schema.parse(await readJson(req));
    const who = await resolvePrincipal();
    const result =
      who.status === "ok" || who.status === "no_membership"
        ? await acceptInvitation(body.token, { mode: "existing_session", userId: who.status === "ok" ? who.principal.userId : who.userId, email: who.status === "ok" ? who.principal.email : who.email })
        : await acceptInvitation(body.token, { mode: "new_account", name: body.name ?? "", password: body.password ?? "" });
    return ok({ orgName: result.orgName, signedIn: who.status !== "unauthenticated" });
  } catch (error: unknown) {
    if (error instanceof ApiError) return fail(error.status, error.code, error.message);
    if (error instanceof ZodError) return validationError(error);
    reportError(error, { route: "invitations.accept" });
    return fail(500, "INTERNAL_ERROR", "Something went wrong.");
  }
}
