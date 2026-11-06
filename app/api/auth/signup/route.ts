/** Self-serve signup (credentials mode only, and only when ALLOW_SELF_SIGNUP permits). Rate limited per client IP. */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { ZodError } from "zod";
import { env } from "@/lib/env";
import { fail, ok, validationError } from "@/lib/api/responses";
import { ApiError } from "@/lib/api/errors";
import { isSameOrigin, readJson } from "@/lib/api/with-org-auth";
import { checkRateLimit } from "@/lib/ratelimit";
import { ipHash } from "@/lib/crypto/hash";
import { signup } from "@/lib/tenancy/signup";
import { reportError } from "@/lib/observability/logger";

const schema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
  orgName: z.string().trim().min(2).max(100),
});

export async function POST(req: NextRequest) {
  try {
    const e = env();
    if (e.authMode !== "credentials" || !e.selfSignupAllowed) return fail(403, "SIGNUP_DISABLED", "Self-serve signup is disabled. Ask an administrator for an invitation.");
    if (!isSameOrigin(req)) return fail(403, "CSRF_REJECTED", "Cross-site request rejected.");
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const rl = await checkRateLimit(`signup:${ipHash(ip)}`, 5, 3600);
    if (!rl.allowed) return fail(429, "RATE_LIMITED", "Too many signups from this network. Try again later.");
    const body = schema.parse(await readJson(req));
    const result = await signup(body);
    return ok({ orgId: result.orgId }, 201);
  } catch (error: unknown) {
    if (error instanceof ApiError) return fail(error.status, error.code, error.message);
    if (error instanceof ZodError) return validationError(error);
    reportError(error, { route: "signup" });
    return fail(500, "INTERNAL_ERROR", "Something went wrong.");
  }
}
