/**
 * Loads the inputs for health evaluation from the database (tenant-scoped),
 * evaluates them, and stores versioned snapshots for trends.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  alerts,
  domainChecks,
  domainScans,
  domains,
  healthSnapshots,
  integrations,
  mailboxConnections,
  organizations,
  providerCapabilities,
  type HealthState,
} from "@/lib/db/schema";
import {
  evaluateCampaignSafety,
  evaluateDomainHealth,
  evaluateMailboxHealth,
  MAILBOX_THRESHOLDS,
  type HealthResult,
} from "@/lib/health/evaluate";

export interface OrgHealth {
  computedAt: string;
  domains: Array<{ id: string; name: string; verified: boolean; monitoringEnabled: boolean; health: HealthResult; lastScanAt: string | null }>;
  mailboxes: Array<{ id: string; emailAddress: string; provider: string; state: string; isDemo: boolean; health: HealthResult; lastSuccessfulSyncAt: string | null }>;
  campaignSafety: HealthResult;
}

export async function getOrgHealth(orgId: string, now = new Date()): Promise<OrgHealth> {
  const [org] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const staleAfterDays = org?.settings.scanStaleAfterDays ?? 7;
  const staleAfterHours = org?.settings.syncStaleAfterHours ?? 2;

  const domainRows = await db.select().from(domains).where(eq(domains.orgId, orgId)).orderBy(domains.name);
  const latestScans = domainRows.length
    ? await db
        .selectDistinctOn([domainScans.domainId], { domainId: domainScans.domainId, id: domainScans.id })
        .from(domainScans)
        .where(and(eq(domainScans.orgId, orgId), eq(domainScans.status, "completed")))
        .orderBy(domainScans.domainId, desc(domainScans.completedAt))
    : [];
  const scanIds = latestScans.map((s) => s.id);
  const checks = scanIds.length
    ? await db
        .select({ id: domainChecks.id, domainId: domainChecks.domainId, checkType: domainChecks.checkType, status: domainChecks.status, summary: domainChecks.summary, checkedAt: domainChecks.checkedAt })
        .from(domainChecks)
        .where(and(eq(domainChecks.orgId, orgId), inArray(domainChecks.scanId, scanIds)))
    : [];

  const domainHealth = domainRows.map((d) => ({
    id: d.id,
    name: d.name,
    verified: d.verificationStatus === "verified",
    monitoringEnabled: d.monitoringEnabled,
    lastScanAt: d.lastScanAt?.toISOString() ?? null,
    health: evaluateDomainHealth({ checks: checks.filter((c) => c.domainId === d.id), lastScanAt: d.lastScanAt, verified: d.verificationStatus === "verified", now, staleAfterDays }),
  }));

  const mailboxRows = await db
    .select()
    .from(mailboxConnections)
    .where(and(eq(mailboxConnections.orgId, orgId), sql`${mailboxConnections.state} <> 'disconnected'`))
    .orderBy(mailboxConnections.emailAddress);
  const since = new Date(now.getTime() - MAILBOX_THRESHOLDS.windowDays * 86_400_000);
  const countRows = mailboxRows.length
    ? ((
        await db.execute<{ connection_id: string; category: string; n: number }>(sql`
          select connection_id, category, count(*)::int as n from provider_events
           where org_id = ${orgId} and occurred_at >= ${since.toISOString()} and occurred_at < ${now.toISOString()}
           group by connection_id, category`)
      ) as unknown as { rows: Array<{ connection_id: string; category: string; n: number }> }).rows
    : [];
  const caps = mailboxRows.length
    ? await db.select().from(providerCapabilities).where(eq(providerCapabilities.orgId, orgId))
    : [];

  const mailboxHealth = mailboxRows.map((m) => {
    const counts: Record<string, number> = {};
    for (const r of countRows) if (r.connection_id === m.id) counts[r.category] = Number(r.n);
    const capMap: Record<string, string> = {};
    for (const c of caps) if (c.connectionId === m.id) capMap[c.capability] = c.status;
    return {
      id: m.id,
      emailAddress: m.emailAddress,
      provider: m.provider,
      state: m.state,
      isDemo: m.isDemo,
      lastSuccessfulSyncAt: m.lastSuccessfulSyncAt?.toISOString() ?? null,
      health: evaluateMailboxHealth({ connectionId: m.id, state: m.state, stateReason: m.stateReason, lastSuccessfulSyncAt: m.lastSuccessfulSyncAt, counts, capabilities: capMap, now, staleAfterHours }),
    };
  });

  const openAlerts = await db
    .select({ id: alerts.id, severity: alerts.severity, title: alerts.title })
    .from(alerts)
    .where(and(eq(alerts.orgId, orgId), inArray(alerts.status, ["open", "acknowledged"])));
  const [campaignIntegration] = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(and(eq(integrations.orgId, orgId), eq(integrations.kind, "campaign_webhook"), eq(integrations.status, "active")))
    .limit(1);
  const live = mailboxHealth.filter((m) => !["paused"].includes(m.state));
  const campaignSafety = evaluateCampaignSafety({
    openAlerts,
    mailboxesTotal: live.length,
    mailboxesFresh: live.filter((m) => m.health.inputs.find((i) => i.key === "mailbox.freshness")?.state === "healthy").length,
    campaignIntegrationActive: Boolean(campaignIntegration),
  });

  return { computedAt: now.toISOString(), domains: domainHealth, mailboxes: mailboxHealth, campaignSafety };
}

export async function storeHealthSnapshots(orgId: string, now = new Date()) {
  const health = await getOrgHealth(orgId, now);
  const rows = [
    ...health.domains.map((d) => ({ orgId, subjectType: "domain" as const, subjectId: d.id, state: d.health.state, inputs: d.health.inputs, missing: d.health.missing, ruleVersion: d.health.ruleVersion, computedAt: now })),
    ...health.mailboxes.map((m) => ({ orgId, subjectType: "mailbox" as const, subjectId: m.id, state: m.health.state, inputs: m.health.inputs, missing: m.health.missing, ruleVersion: m.health.ruleVersion, computedAt: now })),
    { orgId, subjectType: "campaign_safety" as const, subjectId: null, state: health.campaignSafety.state, inputs: health.campaignSafety.inputs, missing: health.campaignSafety.missing, ruleVersion: health.campaignSafety.ruleVersion, computedAt: now },
  ];
  if (rows.length) await db.insert(healthSnapshots).values(rows);
  return { snapshots: rows.length };
}

export async function healthHistory(orgId: string, subjectType: "domain" | "mailbox" | "campaign_safety", subjectId: string | null, days = 30) {
  const since = new Date(Date.now() - days * 86_400_000);
  const conds = [eq(healthSnapshots.orgId, orgId), eq(healthSnapshots.subjectType, subjectType), gte(healthSnapshots.computedAt, since)];
  if (subjectId) conds.push(eq(healthSnapshots.subjectId, subjectId));
  return db
    .select({ state: healthSnapshots.state, computedAt: healthSnapshots.computedAt, ruleVersion: healthSnapshots.ruleVersion })
    .from(healthSnapshots)
    .where(and(...conds))
    .orderBy(healthSnapshots.computedAt);
}

export function summarizeStates(states: HealthState[]) {
  const out: Record<HealthState, number> = { healthy: 0, at_risk: 0, critical: 0, unknown: 0, stale: 0 };
  for (const s of states) out[s] += 1;
  return out;
}
