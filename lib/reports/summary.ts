/**
 * Time-filtered report summaries built only from observed data, with explicit
 * coverage information (which mailboxes actually had data in the period).
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { alerts, campaignActions, domainScans, mailboxConnections } from "@/lib/db/schema";

export interface ReportRange {
  from: Date;
  to: Date;
}

export async function dailyEventSeries(orgId: string, range: ReportRange, connectionId?: string) {
  const connFilter = connectionId ? sql`and connection_id = ${connectionId}` : sql``;
  const result = await db.execute<{ day: string; category: string; n: number }>(sql`
    select to_char(date_trunc('day', occurred_at at time zone 'UTC'), 'YYYY-MM-DD') as day, category, count(*)::int as n
      from provider_events
     where org_id = ${orgId} and occurred_at >= ${range.from.toISOString()} and occurred_at < ${range.to.toISOString()} ${connFilter}
     group by 1, 2 order by 1`);
  const rows = (result as unknown as { rows: Array<{ day: string; category: string; n: number }> }).rows;
  const days = new Map<string, Record<string, number>>();
  for (let t = new Date(Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), range.from.getUTCDate())); t < range.to; t = new Date(t.getTime() + 86_400_000)) {
    days.set(t.toISOString().slice(0, 10), {});
  }
  for (const r of rows) {
    const d = days.get(r.day) ?? {};
    d[r.category] = Number(r.n);
    days.set(r.day, d);
  }
  return [...days.entries()].map(([day, counts]) => {
    const sent = counts.sent ?? 0;
    const bounces = (counts.hard_bounce ?? 0) + (counts.soft_bounce ?? 0) + (counts.bounce_unclassified ?? 0);
    return { day, sent, bounces, replies: counts.reply ?? 0, complaints: counts.complaint ?? 0, providerErrors: (counts.provider_error ?? 0) + (counts.sending_limit ?? 0), bounceRate: sent > 0 ? bounces / sent : null };
  });
}

export async function mailboxSummary(orgId: string, range: ReportRange) {
  const result = await db.execute<{ connection_id: string; category: string; n: number }>(sql`
    select connection_id, category, count(*)::int as n from provider_events
     where org_id = ${orgId} and occurred_at >= ${range.from.toISOString()} and occurred_at < ${range.to.toISOString()}
     group by 1, 2`);
  const rows = (result as unknown as { rows: Array<{ connection_id: string; category: string; n: number }> }).rows;
  const conns = await db
    .select({ id: mailboxConnections.id, email: mailboxConnections.emailAddress, provider: mailboxConnections.provider, state: mailboxConnections.state, lastSync: mailboxConnections.lastSuccessfulSyncAt, isDemo: mailboxConnections.isDemo })
    .from(mailboxConnections)
    .where(eq(mailboxConnections.orgId, orgId));
  const syncCoverage = await db.execute<{ connection_id: string; ok: number }>(sql`
    select connection_id, count(*)::int as ok from provider_syncs
     where org_id = ${orgId} and status in ('succeeded', 'partial') and started_at >= ${range.from.toISOString()} and started_at < ${range.to.toISOString()}
     group by 1`);
  const covered = new Map((syncCoverage as unknown as { rows: Array<{ connection_id: string; ok: number }> }).rows.map((r) => [r.connection_id, Number(r.ok)]));
  return conns.map((c) => {
    const counts: Record<string, number> = {};
    for (const r of rows) if (r.connection_id === c.id) counts[r.category] = Number(r.n);
    const sent = counts.sent ?? 0;
    const bounces = (counts.hard_bounce ?? 0) + (counts.soft_bounce ?? 0) + (counts.bounce_unclassified ?? 0);
    return {
      ...c,
      sent,
      bounces,
      hardBounces: counts.hard_bounce ?? 0,
      replies: counts.reply ?? 0,
      complaints: counts.complaint ?? 0,
      unsubscribes: counts.unsubscribe ?? 0,
      providerErrors: (counts.provider_error ?? 0) + (counts.sending_limit ?? 0),
      bounceRate: sent >= 20 ? bounces / sent : null,
      bounceRateNote: sent >= 20 ? null : `Insufficient sample (${sent} sent)`,
      successfulSyncsInPeriod: c.isDemo ? null : (covered.get(c.id) ?? 0),
    };
  });
}

export async function periodCounts(orgId: string, range: ReportRange) {
  const [alertCount] = await db
    .select({ n: sql<number>`count(*)::int`, critical: sql<number>`count(*) filter (where severity = 'critical')::int` })
    .from(alerts)
    .where(and(eq(alerts.orgId, orgId), gte(alerts.firstTriggeredAt, range.from), lt(alerts.firstTriggeredAt, range.to)));
  const [scanCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(domainScans)
    .where(and(eq(domainScans.orgId, orgId), eq(domainScans.status, "completed"), gte(domainScans.completedAt, range.from), lt(domainScans.completedAt, range.to)));
  const [actions] = await db
    .select({ n: sql<number>`count(*)::int`, confirmed: sql<number>`count(*) filter (where status = 'confirmed')::int` })
    .from(campaignActions)
    .where(and(eq(campaignActions.orgId, orgId), gte(campaignActions.createdAt, range.from), lt(campaignActions.createdAt, range.to)));
  return {
    alerts: alertCount?.n ?? 0,
    criticalAlerts: alertCount?.critical ?? 0,
    scans: scanCount?.n ?? 0,
    campaignActions: actions?.n ?? 0,
    campaignActionsConfirmed: actions?.confirmed ?? 0,
  };
}

export function parseRange(params: URLSearchParams, defaultDays = 30): ReportRange {
  const to = params.get("to") ? new Date(params.get("to")!) : new Date();
  const from = params.get("from") ? new Date(params.get("from")!) : new Date(to.getTime() - defaultDays * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return { from: new Date(Date.now() - defaultDays * 86_400_000), to: new Date() };
  const maxSpan = 366 * 86_400_000;
  return to.getTime() - from.getTime() > maxSpan ? { from: new Date(to.getTime() - maxSpan), to } : { from, to };
}
