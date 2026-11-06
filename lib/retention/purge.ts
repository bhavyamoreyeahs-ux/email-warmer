/**
 * Retention and deletion.
 *
 * Per organisation (org override, else deployment default):
 *   provider events, health snapshots, notifications → event retention
 *   AI diagnoses → diagnostic retention
 *   DNS scans/checks → event retention, but the latest completed scan per
 *     domain is always kept so current state never disappears
 *   resolved alerts → event retention
 *   audit logs → audit retention
 *   sync history, closed invitations, failed/superseded verifications → event retention
 *   finished campaign actions → audit retention (they are part of the action trail)
 *   usage ledger → USAGE_LEDGER_RETENTION_DAYS (kept longer as plan/usage evidence)
 * Global housekeeping: finished background jobs > 30 days, expired OAuth
 * states, old rate-limit windows, stale worker heartbeats, and audit rows with
 * no organisation (e.g. failed logins) after the default audit retention.
 * Every per-org purge writes an audit record with counts.
 * DEFAULT PERIODS ARE PLACEHOLDERS pending product/security review.
 */
import { and, eq, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  aiRecommendations,
  auditLogs,
  campaignActions,
  domainScans,
  domainVerifications,
  healthSnapshots,
  invitations,
  notifications,
  oauthStates,
  organizations,
  providerEvents,
  providerSyncs,
  usageLedger,
  workerHeartbeats,
} from "@/lib/db/schema";
import { env } from "@/lib/env";
import { recordAudit, systemActor } from "@/lib/audit";
import { deleteResolvedAlertsBefore } from "@/lib/alerts/evaluate";
import { purgeRateLimitBuckets } from "@/lib/ratelimit";

const days = (n: number) => new Date(Date.now() - n * 86_400_000);

/** Usage records are evidence for plan/usage questions, so they outlive event data. Placeholder: needs an owner. */
export const USAGE_LEDGER_RETENTION_DAYS = 400;

export async function purgeOrganization(orgId: string) {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) return null;
  const e = env();
  const eventDays = org.eventRetentionDays ?? e.DEFAULT_EVENT_RETENTION_DAYS;
  const diagDays = org.diagnosticRetentionDays ?? e.DEFAULT_DIAGNOSTIC_RETENTION_DAYS;
  const auditDays = org.auditRetentionDays ?? e.DEFAULT_AUDIT_RETENTION_DAYS;

  const events = await db.delete(providerEvents).where(and(eq(providerEvents.orgId, orgId), lt(providerEvents.occurredAt, days(eventDays)))).returning({ id: providerEvents.id });
  const snaps = await db.delete(healthSnapshots).where(and(eq(healthSnapshots.orgId, orgId), lt(healthSnapshots.computedAt, days(eventDays)))).returning({ id: healthSnapshots.id });
  const notes = await db.delete(notifications).where(and(eq(notifications.orgId, orgId), lt(notifications.createdAt, days(eventDays)))).returning({ id: notifications.id });
  const diags = await db.delete(aiRecommendations).where(and(eq(aiRecommendations.orgId, orgId), lt(aiRecommendations.createdAt, days(diagDays)))).returning({ id: aiRecommendations.id });
  const latestScanIds = (
    (await db.execute<{ id: string }>(sql`
      select distinct on (domain_id) id from domain_scans where org_id = ${orgId} and status = 'completed' order by domain_id, completed_at desc`)) as unknown as { rows: Array<{ id: string }> }
  ).rows.map((r) => r.id);
  const scanConds = [eq(domainScans.orgId, orgId), lt(domainScans.createdAt, days(eventDays))];
  if (latestScanIds.length) scanConds.push(notInArray(domainScans.id, latestScanIds));
  const scans = await db.delete(domainScans).where(and(...scanConds)).returning({ id: domainScans.id });
  const resolvedAlerts = await deleteResolvedAlertsBefore(orgId, days(eventDays));
  const audits = await db.delete(auditLogs).where(and(eq(auditLogs.orgId, orgId), lt(auditLogs.createdAt, days(auditDays)))).returning({ id: auditLogs.id });
  const syncs = await db.delete(providerSyncs).where(and(eq(providerSyncs.orgId, orgId), lt(providerSyncs.startedAt, days(eventDays)))).returning({ id: providerSyncs.id });
  const actions = await db
    .delete(campaignActions)
    .where(and(eq(campaignActions.orgId, orgId), isNotNull(campaignActions.completedAt), lt(campaignActions.createdAt, days(auditDays))))
    .returning({ id: campaignActions.id });
  const invites = await db
    .delete(invitations)
    .where(and(eq(invitations.orgId, orgId), lt(invitations.createdAt, days(eventDays)), or(isNotNull(invitations.acceptedAt), isNotNull(invitations.revokedAt), lt(invitations.expiresAt, new Date()))))
    .returning({ id: invitations.id });
  const verifications = await db
    .delete(domainVerifications)
    .where(and(eq(domainVerifications.orgId, orgId), inArray(domainVerifications.status, ["failed", "superseded"]), lt(domainVerifications.createdAt, days(eventDays))))
    .returning({ id: domainVerifications.id });
  const usage = await db.delete(usageLedger).where(and(eq(usageLedger.orgId, orgId), lt(usageLedger.occurredAt, days(USAGE_LEDGER_RETENTION_DAYS)))).returning({ id: usageLedger.id });

  const counts = {
    events: events.length,
    healthSnapshots: snaps.length,
    notifications: notes.length,
    diagnoses: diags.length,
    domainScans: scans.length,
    resolvedAlerts: resolvedAlerts.length,
    auditLogs: audits.length,
    providerSyncs: syncs.length,
    campaignActions: actions.length,
    invitations: invites.length,
    domainVerifications: verifications.length,
    usageLedger: usage.length,
  };
  if (Object.values(counts).some((n) => n > 0)) {
    await recordAudit({ orgId, actor: systemActor, action: "retention.purge", targetType: "organization", targetId: orgId, outcome: "success", metadata: { counts, eventDays, diagDays, auditDays } });
  }
  return counts;
}

export async function purgeAll() {
  const orgs = await db.select({ id: organizations.id }).from(organizations);
  const results: Record<string, unknown> = {};
  for (const o of orgs) results[o.id] = await purgeOrganization(o.id);
  await db.execute(sql`delete from background_jobs where status in ('succeeded', 'cancelled', 'dead') and completed_at < now() - interval '30 days'`);
  await db.delete(oauthStates).where(lt(oauthStates.expiresAt, days(1)));
  await purgeRateLimitBuckets(days(1));
  await db.delete(workerHeartbeats).where(lt(workerHeartbeats.lastSeenAt, days(7)));
  await db.delete(auditLogs).where(and(isNull(auditLogs.orgId), lt(auditLogs.createdAt, days(env().DEFAULT_AUDIT_RETENTION_DAYS))));
  return { organizations: orgs.length, results };
}
