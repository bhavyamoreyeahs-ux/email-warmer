/** Alerts: list, detail (with expanded evidence), acknowledge, resolve. */
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { alerts, campaignActions, domainChecks, notifications, providerEvents } from "@/lib/db/schema";
import { badRequest, notFound } from "@/lib/api/errors";
import { recordAudit, type AuditActor } from "@/lib/audit";

export async function listAlerts(orgId: string, filters: { status?: "open" | "acknowledged" | "resolved" | "active"; severity?: string; limit?: number } = {}) {
  const conds: SQL[] = [eq(alerts.orgId, orgId)];
  if (filters.status === "active") conds.push(inArray(alerts.status, ["open", "acknowledged"]));
  else if (filters.status) conds.push(eq(alerts.status, filters.status));
  if (filters.severity) conds.push(eq(alerts.severity, filters.severity as "warning"));
  return db.select().from(alerts).where(and(...conds)).orderBy(desc(alerts.lastTriggeredAt)).limit(Math.min(filters.limit ?? 100, 500));
}

export async function getAlertDetail(orgId: string, alertId: string) {
  const [alert] = await db.select().from(alerts).where(and(eq(alerts.id, alertId), eq(alerts.orgId, orgId))).limit(1);
  if (!alert) throw notFound("Alert");
  const [events, checks, notes, actions] = await Promise.all([
    alert.evidence.sampleEventIds.length
      ? db.select().from(providerEvents).where(and(eq(providerEvents.orgId, orgId), inArray(providerEvents.id, alert.evidence.sampleEventIds)))
      : Promise.resolve([]),
    alert.evidence.checkIds.length ? db.select().from(domainChecks).where(and(eq(domainChecks.orgId, orgId), inArray(domainChecks.id, alert.evidence.checkIds))) : Promise.resolve([]),
    db.select().from(notifications).where(and(eq(notifications.orgId, orgId), eq(notifications.alertId, alertId))),
    db.select().from(campaignActions).where(and(eq(campaignActions.orgId, orgId), eq(campaignActions.alertId, alertId))),
  ]);
  return { alert, events, checks, notifications: notes, campaignActions: actions };
}

export async function acknowledgeAlert(orgId: string, alertId: string, actor: AuditActor, requestId?: string) {
  const [row] = await db
    .update(alerts)
    .set({ status: "acknowledged", acknowledgedByUserId: actor.userId ?? null, acknowledgedAt: new Date() })
    .where(and(eq(alerts.id, alertId), eq(alerts.orgId, orgId), eq(alerts.status, "open")))
    .returning();
  if (!row) throw badRequest("Only open alerts can be acknowledged.");
  await recordAudit({ orgId, actor, action: "alert.acknowledge", targetType: "alert", targetId: alertId, outcome: "success", requestId });
  return row;
}

export async function resolveAlert(orgId: string, alertId: string, note: string, actor: AuditActor, requestId?: string) {
  const [row] = await db
    .update(alerts)
    .set({ status: "resolved", resolvedByUserId: actor.userId ?? null, resolvedAt: new Date(), resolutionNote: note })
    .where(and(eq(alerts.id, alertId), eq(alerts.orgId, orgId), inArray(alerts.status, ["open", "acknowledged"])))
    .returning();
  if (!row) throw badRequest("Only open or acknowledged alerts can be resolved.");
  await recordAudit({ orgId, actor, action: "alert.resolve", targetType: "alert", targetId: alertId, reason: note, outcome: "success", requestId });
  return row;
}

export async function listNotifications(orgId: string, limit = 30) {
  return db.select().from(notifications).where(eq(notifications.orgId, orgId)).orderBy(desc(notifications.createdAt)).limit(limit);
}
