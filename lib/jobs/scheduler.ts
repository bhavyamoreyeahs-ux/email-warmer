/**
 * Periodic scheduling, run by the worker every minute. Enqueues are idempotent
 * (idempotency keys), so several workers ticking at once cannot duplicate work.
 * Organisations with automation paused, suspended organisations, demo
 * organisations and non-syncable mailboxes are skipped.
 */
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, mailboxConnections, organizations } from "@/lib/db/schema";
import { enqueueJob } from "@/lib/jobs/queue";
import { env } from "@/lib/env";
import { assertCanScan } from "@/lib/usage/entitlements";
import { requestScan } from "@/lib/domains/service";
import { automationActor } from "@/lib/audit";

/** True when a period boundary (every `minutes`, offset by `offset`) lies in (prev, now]. Robust to tick drift. */
export function crossedBoundary(prev: Date | null, now: Date, minutes: number, offset = 0): boolean {
  const bucket = (d: Date) => Math.floor((d.getTime() / 60_000 - offset) / minutes);
  return prev === null ? true : bucket(now) !== bucket(prev);
}

export async function schedulerTick(now = new Date(), prev: Date | null = null) {
  const e = env();
  const activeOrgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.status, "active"), eq(organizations.automationPaused, false), eq(organizations.isDemo, false)));
  const orgIds = activeOrgs.map((o) => o.id);
  const out = { syncs: 0, scans: 0, evaluations: 0 };
  if (!orgIds.length) return out;

  const due = await db
    .select({ id: mailboxConnections.id, orgId: mailboxConnections.orgId })
    .from(mailboxConnections)
    .where(
      and(
        inArray(mailboxConnections.orgId, orgIds),
        inArray(mailboxConnections.state, ["connected", "degraded"]),
        or(isNull(mailboxConnections.nextSyncAt), lte(mailboxConnections.nextSyncAt, now)),
      ),
    )
    .limit(500);
  for (const c of due) {
    const r = await enqueueJob({ type: "mailbox.sync", orgId: c.orgId, payload: { connectionId: c.id, trigger: "scheduled" }, idempotencyKey: `sync:${c.id}` });
    if (!r.deduplicated) out.syncs += 1;
  }

  const staleBefore = new Date(now.getTime() - e.SCAN_INTERVAL_HOURS * 3_600_000);
  const scanDue = await db
    .select({ id: domains.id, orgId: domains.orgId })
    .from(domains)
    .where(
      and(
        inArray(domains.orgId, orgIds),
        eq(domains.verificationStatus, "verified"),
        eq(domains.monitoringEnabled, true),
        or(isNull(domains.lastScanAt), lte(domains.lastScanAt, staleBefore)),
      ),
    )
    .limit(200);
  for (const d of scanDue) {
    try {
      await assertCanScan(d.orgId);
      const r = await requestScan(d.orgId, d.id, "scheduled", automationActor("scheduler"));
      if (!r.deduplicated) out.scans += 1;
    } catch {
      // Plan limit reached: skip quietly; the domain shows as stale, never healthy.
    }
  }

  // Alerts every 5 minutes, health snapshots hourly, retention daily (03:00 UTC).
  // Boundary-crossing rather than `minute % n === 0`, so a drifting tick never skips a period.
  const alertsDue = crossedBoundary(prev, now, 5);
  const healthDue = crossedBoundary(prev, now, 60);
  for (const orgId of orgIds) {
    if (alertsDue) {
      const r = await enqueueJob({ type: "alerts.evaluate", orgId, idempotencyKey: `alerts:${orgId}` });
      if (!r.deduplicated) out.evaluations += 1;
    }
    if (healthDue) await enqueueJob({ type: "health.compute", orgId, idempotencyKey: `health:${orgId}` });
  }
  // Retention runs daily after 03:00 UTC. Checked hourly against the last successful
  // run, so a worker that was down at 03:00 still catches up the same day.
  if (crossedBoundary(prev, now, 60) && now.getUTCHours() >= 3) {
    const r = await db.execute<{ last: string | null }>(sql`select max(completed_at) as last from background_jobs where type = 'retention.purge' and status = 'succeeded'`);
    const last = (r as unknown as { rows: Array<{ last: string | null }> }).rows[0]?.last;
    const today3am = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3));
    if (!last || new Date(last) < today3am) {
      await enqueueJob({ type: "retention.purge", orgId: null, idempotencyKey: `retention:${now.toISOString().slice(0, 10)}` });
    }
  }
  return out;
}
