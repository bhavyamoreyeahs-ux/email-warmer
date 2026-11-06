/**
 * Standard auth + tenant + permission guard for every QuikReach API route that
 * touches tenant data. Mirrors QuikIT's `withOrgAuth` contract.
 *
 *   no session / disabled user / revoked session → 401
 *   no active membership                         → 403
 *   role lacks the permission                    → 403 (audited for mutations)
 *   cross-site mutation (Origin mismatch)        → 403
 *   rate limit exceeded                          → 429
 *   empty route parameter                        → 404
 *   ApiError thrown                              → its status + code
 *   ZodError thrown                              → 400
 *   anything else                                → 500, generic message, reported
 *
 * Usage:
 *   export const GET = withOrgAuth(async ({ principal }) => ok(...), { permission: "domain:view" });
 */
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { randomUUID } from "node:crypto";
import { ApiError } from "@/lib/api/errors";
import { fail, validationError } from "@/lib/api/responses";
import { resolvePrincipal, type Principal } from "@/lib/api/principal";
import { can, type Permission } from "@/lib/rbac";
import { recordAudit, type AuditActor, type AuditEntry } from "@/lib/audit";
import { checkRateLimit } from "@/lib/ratelimit";
import { env } from "@/lib/env";
import { logger, reportError } from "@/lib/observability/logger";
import { incCounter } from "@/lib/observability/metrics";
import { ipHash } from "@/lib/crypto/hash";

export interface RequestContext<P> {
  req: NextRequest;
  params: P;
  principal: Principal;
  requestId: string;
  actor: AuditActor;
  /** Audit helper pre-filled with tenant, actor and request id. */
  audit: (entry: Omit<AuditEntry, "orgId" | "actor" | "requestId" | "ipHash">) => Promise<void>;
}

export interface WithOrgAuthOptions {
  permission?: Permission;
  /** Requests per window per user (mutations default to 120/min). */
  rateLimit?: { limit: number; windowSeconds: number };
  /** Rejected in demo workspaces, which must never receive live data. */
  liveDataOperation?: boolean;
  /** Route label for metrics (low cardinality). */
  route?: string;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  const allowed = new Set([new URL(env().APP_URL).origin, req.nextUrl.origin]);
  if (origin) return allowed.has(origin);
  return req.headers.get("sec-fetch-site") === "same-origin";
}

function emptyParam(params: unknown): boolean {
  if (!params || typeof params !== "object") return false;
  return Object.values(params as Record<string, unknown>).some((v) => v === undefined || v === null || (typeof v === "string" && v.trim() === ""));
}

export function withOrgAuth<P extends Record<string, string> = Record<string, never>>(
  handler: (ctx: RequestContext<P>) => Promise<Response> | Response,
  options: WithOrgAuthOptions = {},
) {
  return async (req: NextRequest, routeCtx?: { params?: Promise<P> | P }): Promise<Response> => {
    const requestId = req.headers.get("x-request-id") ?? randomUUID();
    const started = Date.now();
    const headers = { "x-request-id": requestId, "cache-control": "no-store" };
    const route = options.route ?? req.nextUrl.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ":id");
    let response: Response;
    let orgId: string | null = null;
    let auditDenial: RequestContext<P>["audit"] | null = null;

    try {
      const mutating = MUTATING.has(req.method);
      if (mutating && !isSameOrigin(req)) {
        response = fail(403, "CSRF_REJECTED", "Cross-site request rejected.", undefined, headers);
      } else {
        const resolved = await resolvePrincipal();
        if (resolved.status === "unauthenticated") {
          response = fail(401, "UNAUTHORIZED", "Sign in to continue.", undefined, headers);
        } else if (resolved.status === "no_membership") {
          response = fail(403, "NO_MEMBERSHIP", "You are not an active member of any organization.", undefined, headers);
        } else {
          const principal = resolved.principal;
          orgId = principal.orgId;
          const actor: AuditActor = { type: "user", userId: principal.userId, label: principal.email };
          const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
          const audit: RequestContext<P>["audit"] = (entry) =>
            recordAudit({ ...entry, orgId: principal.orgId, actor, requestId, ipHash: ipHash(ip) });
          if (mutating) auditDenial = audit;

          const params = ((await routeCtx?.params) ?? {}) as P;
          if (options.permission && !can(principal.role, options.permission)) {
            if (mutating) {
              await audit({ action: "authz.denied", targetType: "permission", targetId: options.permission, outcome: "denied", metadata: { route } });
            }
            response = fail(403, "FORBIDDEN", `Your role (${principal.role.replace(/_/g, " ")}) does not permit ${options.permission}.`, undefined, headers);
          } else if (options.liveDataOperation && principal.isDemoOrg && mutating) {
            response = fail(
              403,
              "DEMO_WORKSPACE",
              "This is a demo workspace with sample data only. Create or switch to a real workspace to use live data.",
              undefined,
              headers,
            );
          } else if (emptyParam(params)) {
            response = fail(404, "NOT_FOUND", "Resource not found.", undefined, headers);
          } else {
            // Route-specific limits get their own counter; the default limit is shared per user and direction.
            const rl = options.rateLimit ?? (mutating ? { limit: 120, windowSeconds: 60 } : { limit: 600, windowSeconds: 60 });
            const rlKey = options.rateLimit ? `api:${principal.userId}:${req.method}:${route}` : `api:${principal.userId}:${mutating ? "w" : "r"}`;
            const limit = await checkRateLimit(rlKey, rl.limit, rl.windowSeconds);
            if (!limit.allowed) {
              response = fail(429, "RATE_LIMITED", "Too many requests. Try again shortly.", { retryAfterSeconds: limit.retryAfterSeconds }, {
                ...headers,
                "retry-after": String(limit.retryAfterSeconds),
              });
            } else {
              response = await handler({ req, params, principal, requestId, actor, audit });
              response.headers.set("x-request-id", requestId);
              if (!response.headers.has("cache-control")) response.headers.set("cache-control", "no-store");
            }
          }
        }
      }
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        // Permission checks made inside a handler (e.g. role-specific rules) are audited like guard denials.
        if (error.status === 403 && error.code === "FORBIDDEN" && auditDenial) {
          await auditDenial({ action: "authz.denied", targetType: "route", targetId: route, outcome: "denied", reason: error.message }).catch(() => undefined);
        }
        response = fail(error.status, error.code, error.message, error.details, headers);
      } else if (error instanceof ZodError) {
        response = validationError(error);
        response.headers.set("x-request-id", requestId);
      } else {
        reportError(error, { requestId, route, orgId });
        response = fail(500, "INTERNAL_ERROR", "Something went wrong. The error has been logged with this request id.", { requestId }, headers);
      }
    }

    incCounter("quikreach_api_requests_total", { route, method: req.method, status: String(response.status) }, 1, "API requests by route and status");
    logger.info("api_request", { requestId, route, method: req.method, status: response.status, ms: Date.now() - started, orgId });
    return response;
  };
}

/** Parse a JSON body with a size cap; throws ApiError on malformed input. */
export async function readJson(req: NextRequest, maxBytes = 64 * 1024): Promise<unknown> {
  const text = await req.text();
  if (text.length > maxBytes) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
}

export function noContent(): Response {
  return new NextResponse(null, { status: 204 });
}

/**
 * Guard for routes that need a signed-in, active user but no organisation yet
 * (creating a first workspace, switching workspace).
 */
export function withUserAuth(handler: (ctx: { req: NextRequest; userId: string; email: string; requestId: string }) => Promise<Response> | Response) {
  return async (req: NextRequest): Promise<Response> => {
    const requestId = req.headers.get("x-request-id") ?? randomUUID();
    const headers = { "x-request-id": requestId, "cache-control": "no-store" };
    try {
      if (MUTATING.has(req.method) && !isSameOrigin(req)) return fail(403, "CSRF_REJECTED", "Cross-site request rejected.", undefined, headers);
      const resolved = await resolvePrincipal();
      if (resolved.status === "unauthenticated") return fail(401, "UNAUTHORIZED", "Sign in to continue.", undefined, headers);
      const userId = resolved.status === "ok" ? resolved.principal.userId : resolved.userId;
      const email = resolved.status === "ok" ? resolved.principal.email : resolved.email;
      const limit = await checkRateLimit(`user:${userId}:${req.method}`, 30, 60);
      if (!limit.allowed) return fail(429, "RATE_LIMITED", "Too many requests. Try again shortly.", undefined, headers);
      return await handler({ req, userId, email, requestId });
    } catch (error: unknown) {
      if (error instanceof ApiError) return fail(error.status, error.code, error.message, error.details, headers);
      if (error instanceof ZodError) return validationError(error);
      reportError(error, { requestId });
      return fail(500, "INTERNAL_ERROR", "Something went wrong.", { requestId }, headers);
    }
  };
}
