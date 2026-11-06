/**
 * Audit trail for security-relevant changes and high-impact actions.
 *
 * Every record captures: actor (user or automation), tenant, target, timestamp,
 * reason and outcome. Metadata is passed through `redact` so secrets cannot be
 * written even by mistake. Audit writes accept an executor so they can join the
 * same transaction as the change they describe.
 */
import { and, desc, eq, gte, ilike, lte, or, sql, type SQL } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import { auditLogs } from "@/lib/db/schema";
import { redact, logger } from "@/lib/observability/logger";

export interface AuditActor {
  type: "user" | "system" | "automation";
  userId?: string | null;
  /** Email for users, job/rule name for automation. */
  label: string;
}

export interface AuditEntry {
  orgId: string | null;
  actor: AuditActor;
  action: string;
  targetType: string;
  targetId?: string | null;
  reason?: string | null;
  outcome: "success" | "failure" | "denied" | "pending";
  metadata?: Record<string, unknown>;
  requestId?: string | null;
  ipHash?: string | null;
}

export async function recordAudit(entry: AuditEntry, executor: Executor = db): Promise<void> {
  try {
    await executor.insert(auditLogs).values({
      orgId: entry.orgId,
      actorType: entry.actor.type,
      actorUserId: entry.actor.userId ?? null,
      actorLabel: entry.actor.label,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      reason: entry.reason ?? null,
      outcome: entry.outcome,
      metadata: (redact(entry.metadata ?? {}) as Record<string, unknown>) ?? {},
      requestId: entry.requestId ?? null,
      ipHash: entry.ipHash ?? null,
    });
  } catch (error: unknown) {
    // Inside a transaction the caller's transaction fails too (desired: no
    // unaudited change). Outside one, surface loudly but do not mask the action.
    logger.error("audit_write_failed", { action: entry.action, error });
    if (executor !== db) throw error;
  }
}

export const systemActor: AuditActor = { type: "system", label: "quikreach-system" };
export const automationActor = (name: string): AuditActor => ({ type: "automation", label: name });

export interface AuditSearch {
  q?: string;
  action?: string;
  outcome?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export async function searchAudit(orgId: string, filters: AuditSearch) {
  const conds: SQL[] = [eq(auditLogs.orgId, orgId)];
  if (filters.action) conds.push(eq(auditLogs.action, filters.action));
  if (filters.outcome) conds.push(eq(auditLogs.outcome, filters.outcome as "success"));
  if (filters.from) conds.push(gte(auditLogs.createdAt, filters.from));
  if (filters.to) conds.push(lte(auditLogs.createdAt, filters.to));
  if (filters.q) {
    const like = `%${filters.q.replace(/[%_]/g, "\\$&")}%`;
    conds.push(or(ilike(auditLogs.actorLabel, like), ilike(auditLogs.action, like), ilike(auditLogs.targetType, like), ilike(sql`coalesce(${auditLogs.reason}, '')`, like))!);
  }
  const limit = Math.min(filters.limit ?? 50, 200);
  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(...conds))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit + 1)
    .offset(filters.offset ?? 0);
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}
