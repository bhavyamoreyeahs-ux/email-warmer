import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { backgroundJobs, JOB_STATUSES } from "@/lib/db/schema";
import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";

export const dynamic = "force-dynamic";
export const GET = withOrgAuth(
  async ({ req, principal }) => {
    const status = req.nextUrl.searchParams.get("status");
    const conds = [eq(backgroundJobs.orgId, principal.orgId)];
    if (status && (JOB_STATUSES as readonly string[]).includes(status)) conds.push(inArray(backgroundJobs.status, [status as (typeof JOB_STATUSES)[number]]));
    const rows = await db
      .select({ id: backgroundJobs.id, type: backgroundJobs.type, status: backgroundJobs.status, attempts: backgroundJobs.attempts, maxAttempts: backgroundJobs.maxAttempts, runAt: backgroundJobs.runAt, lastError: backgroundJobs.lastError, createdAt: backgroundJobs.createdAt, completedAt: backgroundJobs.completedAt })
      .from(backgroundJobs)
      .where(and(...conds))
      .orderBy(desc(backgroundJobs.createdAt))
      .limit(100);
    return ok(rows);
  },
  { permission: "job:view" },
);
