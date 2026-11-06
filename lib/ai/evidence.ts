/**
 * Tenant-scoped evidence retrieval for diagnostics. Every query filters by the
 * server-resolved org id. Evidence carries derived metrics, DNS check results
 * and connection states — never message bodies, subjects or recipient
 * addresses (only recipient DOMAINS, aggregated).
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { alerts, domainChecks, domainScans, domains, mailboxConnections, providerCapabilities } from "@/lib/db/schema";
import type { EvidenceItem } from "@/lib/ai/schema";
import { notFound } from "@/lib/api/errors";

export type DiagnosisSubject = { type: "organization" } | { type: "domain"; id: string } | { type: "mailbox"; id: string } | { type: "alert"; id: string };

const WINDOW_DAYS = 7;

async function domainEvidence(orgId: string, domainIds: string[]): Promise<EvidenceItem[]> {
  if (!domainIds.length) return [];
  const ds = await db.select().from(domains).where(and(eq(domains.orgId, orgId), inArray(domains.id, domainIds)));
  const latest = await db
    .selectDistinctOn([domainScans.domainId], { domainId: domainScans.domainId, id: domainScans.id })
    .from(domainScans)
    .where(and(eq(domainScans.orgId, orgId), eq(domainScans.status, "completed"), inArray(domainScans.domainId, domainIds)))
    .orderBy(domainScans.domainId, desc(domainScans.completedAt));
  if (!latest.length) {
    return ds.map((d) => ({ ref: `domain:${d.id}`, kind: "dns_check" as const, title: `${d.name}: not scanned yet`, observedAt: null, facts: { domain: d.name, verified: d.verificationStatus === "verified" } }));
  }
  const checks = await db.select().from(domainChecks).where(and(eq(domainChecks.orgId, orgId), inArray(domainChecks.scanId, latest.map((l) => l.id))));
  const nameOf = new Map(ds.map((d) => [d.id, d.name]));
  return checks.map((c) => ({
    ref: `check:${c.id}`,
    kind: "dns_check" as const,
    title: `${c.checkType.toUpperCase()} check for ${nameOf.get(c.domainId) ?? "domain"}: ${c.status}`,
    observedAt: c.checkedAt.toISOString(),
    facts: {
      domain: nameOf.get(c.domainId) ?? null,
      checkType: c.checkType,
      status: c.status,
      summary: c.summary,
      findings: c.findings.map((f) => `[${f.severity}] ${f.code}: ${f.message}`).slice(0, 12),
      ruleVersion: c.ruleVersion,
      resolver: c.resolver,
    },
  }));
}

async function mailboxEvidence(orgId: string, connectionIds: string[]): Promise<EvidenceItem[]> {
  if (!connectionIds.length) return [];
  const conns = await db.select().from(mailboxConnections).where(and(eq(mailboxConnections.orgId, orgId), inArray(mailboxConnections.id, connectionIds)));
  const caps = await db.select().from(providerCapabilities).where(and(eq(providerCapabilities.orgId, orgId), inArray(providerCapabilities.connectionId, connectionIds)));
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
  const counts = (await db.execute<{ connection_id: string; category: string; n: number }>(sql`
    select connection_id, category, count(*)::int as n from provider_events
     where org_id = ${orgId} and occurred_at >= ${since.toISOString()}
       and connection_id in (${sql.join(connectionIds.map((c) => sql`${c}`), sql`, `)})
     group by connection_id, category`)) as unknown as { rows: Array<{ connection_id: string; category: string; n: number }> };
  const bounceDomains = (await db.execute<{ connection_id: string; recipient_domain: string; n: number }>(sql`
    select connection_id, recipient_domain, count(*)::int as n from provider_events
     where org_id = ${orgId} and occurred_at >= ${since.toISOString()} and recipient_domain is not null
       and category in ('hard_bounce', 'soft_bounce', 'bounce_unclassified')
       and connection_id in (${sql.join(connectionIds.map((c) => sql`${c}`), sql`, `)})
     group by connection_id, recipient_domain order by n desc limit 50`)) as unknown as { rows: Array<{ connection_id: string; recipient_domain: string; n: number }> };

  const items: EvidenceItem[] = [];
  for (const c of conns) {
    items.push({
      ref: `conn:${c.id}`,
      kind: "mailbox",
      title: `Mailbox ${c.emailAddress} (${c.provider}): ${c.state}`,
      observedAt: c.lastSuccessfulSyncAt?.toISOString() ?? null,
      facts: {
        provider: c.provider,
        state: c.state,
        stateReason: c.stateReason,
        lastSuccessfulSync: c.lastSuccessfulSyncAt?.toISOString() ?? null,
        consecutiveFailures: c.consecutiveFailures,
        lastErrorCode: c.lastErrorCode,
        isDemo: c.isDemo,
      },
    });
    const byCat: Record<string, number> = {};
    for (const r of counts.rows) if (r.connection_id === c.id) byCat[r.category] = Number(r.n);
    const sent = byCat.sent ?? 0;
    const bounces = (byCat.hard_bounce ?? 0) + (byCat.soft_bounce ?? 0) + (byCat.bounce_unclassified ?? 0);
    items.push({
      ref: `events:${c.id}:${WINDOW_DAYS}d`,
      kind: "event_summary",
      title: `Observed events for ${c.emailAddress}, last ${WINDOW_DAYS} days`,
      observedAt: new Date().toISOString(),
      facts: {
        sent,
        hardBounces: byCat.hard_bounce ?? 0,
        softBounces: byCat.soft_bounce ?? 0,
        unclassifiedBounces: byCat.bounce_unclassified ?? 0,
        bounceRate: sent > 0 ? Number((bounces / sent).toFixed(4)) : null,
        replies: byCat.reply ?? 0,
        autoReplies: byCat.auto_reply ?? 0,
        complaints: byCat.complaint ?? 0,
        unsubscribes: byCat.unsubscribe ?? 0,
        providerErrors: byCat.provider_error ?? 0,
        sendingLimitNotices: byCat.sending_limit ?? 0,
        topBouncingRecipientDomains: bounceDomains.rows.filter((r) => r.connection_id === c.id).slice(0, 5).map((r) => `${r.recipient_domain} (${r.n})`),
        note: "Counts are observed in this mailbox only. Sent = provider-recorded outbound messages, not proof of inbox delivery.",
      },
    });
    const gaps = caps.filter((x) => x.connectionId === c.id && x.status !== "available");
    if (gaps.length) {
      items.push({
        ref: `caps:${c.id}`,
        kind: "capability_gap",
        title: `Signals not fully observable for ${c.emailAddress}`,
        observedAt: gaps[0]?.checkedAt.toISOString() ?? null,
        facts: Object.fromEntries(gaps.map((g) => [g.capability, `${g.status}: ${g.detail}`])),
      });
    }
  }
  return items;
}

async function alertEvidence(orgId: string, alertIds: string[] | "open"): Promise<EvidenceItem[]> {
  const rows =
    alertIds === "open"
      ? await db.select().from(alerts).where(and(eq(alerts.orgId, orgId), inArray(alerts.status, ["open", "acknowledged"]))).orderBy(desc(alerts.lastTriggeredAt)).limit(20)
      : alertIds.length
        ? await db.select().from(alerts).where(and(eq(alerts.orgId, orgId), inArray(alerts.id, alertIds)))
        : [];
  return rows.map((a) => ({
    ref: `alert:${a.id}`,
    kind: "alert" as const,
    title: a.title,
    observedAt: a.lastTriggeredAt.toISOString(),
    facts: { metric: a.metric, severity: a.severity, status: a.status, observedValue: a.observedValue, threshold: a.threshold, sampleSize: a.sampleSize, occurrences: a.occurrences, actionOutcome: a.actionOutcome, notes: a.evidence.notes },
  }));
}

export async function collectEvidence(orgId: string, subject: DiagnosisSubject): Promise<EvidenceItem[]> {
  if (subject.type === "organization") {
    const ds = await db.select({ id: domains.id }).from(domains).where(eq(domains.orgId, orgId)).limit(20);
    const ms = await db.select({ id: mailboxConnections.id }).from(mailboxConnections).where(and(eq(mailboxConnections.orgId, orgId), sql`${mailboxConnections.state} <> 'disconnected'`)).limit(20);
    return [...(await domainEvidence(orgId, ds.map((d) => d.id))), ...(await mailboxEvidence(orgId, ms.map((m) => m.id))), ...(await alertEvidence(orgId, "open"))];
  }
  if (subject.type === "domain") {
    const [d] = await db.select({ id: domains.id }).from(domains).where(and(eq(domains.id, subject.id), eq(domains.orgId, orgId))).limit(1);
    if (!d) throw notFound("Domain");
    const ms = await db.select({ id: mailboxConnections.id }).from(mailboxConnections).where(and(eq(mailboxConnections.orgId, orgId), eq(mailboxConnections.domainId, d.id)));
    const as = await db.select({ id: alerts.id }).from(alerts).where(and(eq(alerts.orgId, orgId), eq(alerts.scopeId, d.id), gte(alerts.lastTriggeredAt, new Date(Date.now() - 30 * 86_400_000))));
    return [...(await domainEvidence(orgId, [d.id])), ...(await mailboxEvidence(orgId, ms.map((m) => m.id))), ...(await alertEvidence(orgId, as.map((a) => a.id)))];
  }
  if (subject.type === "mailbox") {
    const [m] = await db.select({ id: mailboxConnections.id, domainId: mailboxConnections.domainId }).from(mailboxConnections).where(and(eq(mailboxConnections.id, subject.id), eq(mailboxConnections.orgId, orgId))).limit(1);
    if (!m) throw notFound("Mailbox connection");
    const as = await db.select({ id: alerts.id }).from(alerts).where(and(eq(alerts.orgId, orgId), eq(alerts.scopeId, m.id), gte(alerts.lastTriggeredAt, new Date(Date.now() - 30 * 86_400_000))));
    return [...(await mailboxEvidence(orgId, [m.id])), ...(await domainEvidence(orgId, m.domainId ? [m.domainId] : [])), ...(await alertEvidence(orgId, as.map((a) => a.id)))];
  }
  const [a] = await db.select().from(alerts).where(and(eq(alerts.id, subject.id), eq(alerts.orgId, orgId))).limit(1);
  if (!a) throw notFound("Alert");
  const base = await alertEvidence(orgId, [a.id]);
  if (a.scopeType === "mailbox" && a.scopeId) return [...base, ...(await collectEvidence(orgId, { type: "mailbox", id: a.scopeId })).filter((e) => e.ref !== `alert:${a.id}`)];
  if (a.scopeType === "domain" && a.scopeId) return [...base, ...(await collectEvidence(orgId, { type: "domain", id: a.scopeId })).filter((e) => e.ref !== `alert:${a.id}`)];
  return base;
}
