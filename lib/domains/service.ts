/**
 * Domains: ownership verification, DNS scans, scan history and comparison.
 *
 * Every query is scoped by the server-resolved org id. Scans are queued in the
 * same transaction as the scan row (transactional outbox) and executed by the
 * worker; verification is a single bounded TXT lookup and runs inline so the
 * user gets an immediate answer.
 *
 * QuikReach never changes DNS. Findings carry recommendations only.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  domainChecks,
  domainScans,
  domainVerifications,
  domains,
  mailboxConnections,
  campaignReferences,
  organizations,
  type CheckStatus,
  type CheckType,
} from "@/lib/db/schema";
import { normalizeDomain } from "@/lib/dns/domain-name";
import { runDomainChecks } from "@/lib/dns/checker";
import { createNodeResolver } from "@/lib/dns/resolver";
import { checkVerification, generateVerificationToken, verificationRecordName, verificationRecordValue } from "@/lib/dns/verification";
import type { DnsResolver } from "@/lib/dns/types";
import { badRequest, conflict, notFound, rateLimited } from "@/lib/api/errors";
import { recordAudit, type AuditActor } from "@/lib/audit";
import { enqueueJob } from "@/lib/jobs/queue";
import { assertCanAddDomain, assertCanScan } from "@/lib/usage/entitlements";
import { recordUsage } from "@/lib/usage/ledger";
import { checkRateLimit } from "@/lib/ratelimit";
import { env } from "@/lib/env";
import { incCounter } from "@/lib/observability/metrics";

export function defaultResolver(): DnsResolver {
  const e = env();
  const servers = e.DNS_RESOLVERS?.split(",").map((s) => s.trim()).filter(Boolean);
  return createNodeResolver({ servers: servers?.length ? servers : undefined, timeoutMs: e.DNS_TIMEOUT_MS });
}

/* ─── Queries ─────────────────────────────────────────────────────────── */

export async function listDomains(orgId: string) {
  const rows = await db.select().from(domains).where(eq(domains.orgId, orgId)).orderBy(domains.name);
  if (!rows.length) return [];
  const ids = rows.map((d) => d.id);
  // Latest completed scan per domain.
  const latest = await db
    .selectDistinctOn([domainScans.domainId], {
      domainId: domainScans.domainId,
      scanId: domainScans.id,
      summary: domainScans.summary,
      completedAt: domainScans.completedAt,
      status: domainScans.status,
    })
    .from(domainScans)
    .where(and(eq(domainScans.orgId, orgId), inArray(domainScans.domainId, ids), eq(domainScans.status, "completed")))
    .orderBy(domainScans.domainId, desc(domainScans.completedAt));
  const pending = await db
    .select({ domainId: domainScans.domainId })
    .from(domainScans)
    .where(and(eq(domainScans.orgId, orgId), inArray(domainScans.domainId, ids), inArray(domainScans.status, ["queued", "running"])));
  const mailboxCounts = await db
    .select({ domainId: mailboxConnections.domainId, n: sql<number>`count(*)::int` })
    .from(mailboxConnections)
    .where(and(eq(mailboxConnections.orgId, orgId), inArray(mailboxConnections.domainId, ids)))
    .groupBy(mailboxConnections.domainId);
  const latestBy = new Map(latest.map((l) => [l.domainId, l]));
  const pendingSet = new Set(pending.map((p) => p.domainId));
  const countBy = new Map(mailboxCounts.map((m) => [m.domainId, m.n]));
  return rows.map((d) => ({
    ...d,
    latestScan: latestBy.get(d.id) ?? null,
    scanPending: pendingSet.has(d.id),
    mailboxCount: countBy.get(d.id) ?? 0,
  }));
}

export async function getDomain(orgId: string, domainId: string) {
  const [d] = await db.select().from(domains).where(and(eq(domains.id, domainId), eq(domains.orgId, orgId))).limit(1);
  if (!d) throw notFound("Domain");
  return d;
}

export async function getDomainDetail(orgId: string, domainId: string) {
  const domain = await getDomain(orgId, domainId);
  const [verification] = await db
    .select()
    .from(domainVerifications)
    .where(and(eq(domainVerifications.orgId, orgId), eq(domainVerifications.domainId, domainId), inArray(domainVerifications.status, ["pending", "verified", "failed"])))
    .orderBy(desc(domainVerifications.createdAt))
    .limit(1);
  const scans = await db
    .select()
    .from(domainScans)
    .where(and(eq(domainScans.orgId, orgId), eq(domainScans.domainId, domainId)))
    .orderBy(desc(domainScans.createdAt))
    .limit(20);
  const completed = scans.filter((s) => s.status === "completed");
  const latestScan = completed[0] ?? null;
  const previousScan = completed[1] ?? null;
  const scanIds = [latestScan?.id, previousScan?.id].filter((x): x is string => Boolean(x));
  const checks = scanIds.length
    ? await db.select().from(domainChecks).where(and(eq(domainChecks.orgId, orgId), inArray(domainChecks.scanId, scanIds)))
    : [];
  const latestChecks = checks.filter((c) => c.scanId === latestScan?.id);
  const previousChecks = checks.filter((c) => c.scanId === previousScan?.id);
  const mailboxes = await db
    .select({ id: mailboxConnections.id, emailAddress: mailboxConnections.emailAddress, provider: mailboxConnections.provider, state: mailboxConnections.state })
    .from(mailboxConnections)
    .where(and(eq(mailboxConnections.orgId, orgId), eq(mailboxConnections.domainId, domainId)));

  return {
    domain,
    verification: verification
      ? { ...verification, expectedValue: verificationRecordValue(verification.token) }
      : null,
    scans,
    latestScan,
    previousScan,
    latestChecks,
    comparison: compareChecks(latestChecks, previousChecks),
    mailboxes,
  };
}

export interface CheckComparison {
  checkType: CheckType;
  before: CheckStatus | null;
  after: CheckStatus | null;
  statusChanged: boolean;
  recordsChanged: boolean;
}

type ComparableCheck = { checkType: CheckType; status: CheckStatus; evidence: { queries: Array<{ name: string; type: string; answers: string[] }> } };

/** Before/after comparison between two scans: status changes and DNS answer changes. */
export function compareChecks(latest: ComparableCheck[], previous: ComparableCheck[]): CheckComparison[] {
  const types: CheckType[] = ["mx", "spf", "dkim", "dmarc"];
  const answers = (c?: ComparableCheck) =>
    JSON.stringify(
      (c?.evidence.queries ?? [])
        .map((q) => `${q.type} ${q.name} => ${[...q.answers].sort().join(" | ")}`)
        .sort(),
    );
  return types.map((t) => {
    const a = latest.find((c) => c.checkType === t);
    const b = previous.find((c) => c.checkType === t);
    return {
      checkType: t,
      before: b?.status ?? null,
      after: a?.status ?? null,
      statusChanged: Boolean(a && b && a.status !== b.status),
      recordsChanged: Boolean(a && b && answers(a) !== answers(b)),
    };
  });
}

/* ─── Mutations ───────────────────────────────────────────────────────── */

export async function createDomain(orgId: string, rawName: string, actor: AuditActor, requestId?: string) {
  const normalized = normalizeDomain(rawName);
  if (!normalized.ok) throw badRequest(normalized.error);
  await assertCanAddDomain(orgId);

  const token = generateVerificationToken();
  try {
    return await db.transaction(async (tx) => {
      const [domain] = await tx.insert(domains).values({ orgId, name: normalized.domain, createdByUserId: actor.userId ?? null, verificationStatus: "pending" }).returning();
      // Mailboxes connected before the domain was added get linked now.
      await tx
        .update(mailboxConnections)
        .set({ domainId: domain!.id, updatedAt: new Date() })
        .where(and(eq(mailboxConnections.orgId, orgId), isNull(mailboxConnections.domainId), sql`split_part(${mailboxConnections.emailAddress}, '@', 2) = ${normalized.domain}`));
      await tx.insert(domainVerifications).values({
        orgId,
        domainId: domain!.id,
        recordName: verificationRecordName(normalized.domain),
        token,
      });
      const [scan] = await tx.insert(domainScans).values({ orgId, domainId: domain!.id, trigger: "setup", requestedByUserId: actor.userId ?? null }).returning();
      await enqueueJob({ type: "domain.scan", orgId, payload: { scanId: scan!.id }, idempotencyKey: `scan:${scan!.id}` }, tx);
      await recordAudit(
        { orgId, actor, action: "domain.create", targetType: "domain", targetId: domain!.id, outcome: "success", requestId, metadata: { domain: normalized.domain } },
        tx,
      );
      return domain!;
    });
  } catch (error: unknown) {
    if (error instanceof Error && /domains_org_name_uq/.test(error.message + String((error as { cause?: unknown }).cause ?? ""))) {
      throw conflict("This domain is already in your workspace.");
    }
    throw error;
  }
}

export async function updateDomain(
  orgId: string,
  domainId: string,
  patch: { dkimSelectors?: string[]; monitoringEnabled?: boolean },
  actor: AuditActor,
  requestId?: string,
) {
  const before = await getDomain(orgId, domainId);
  const selectors = patch.dkimSelectors?.map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (selectors?.some((s) => !/^[a-z0-9._-]{1,63}$/.test(s))) throw badRequest("DKIM selectors may contain letters, digits, dot, underscore and hyphen (max 63).");
  if (selectors && selectors.length > 10) throw badRequest("At most 10 DKIM selectors.");
  return db.transaction(async (tx) => {
    const [after] = await tx
      .update(domains)
      .set({
        ...(selectors ? { dkimSelectors: [...new Set(selectors)] } : {}),
        ...(patch.monitoringEnabled !== undefined ? { monitoringEnabled: patch.monitoringEnabled } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(domains.id, domainId), eq(domains.orgId, orgId)))
      .returning();
    await recordAudit(
      {
        orgId,
        actor,
        action: "domain.update",
        targetType: "domain",
        targetId: domainId,
        outcome: "success",
        requestId,
        metadata: { before: { dkimSelectors: before.dkimSelectors, monitoringEnabled: before.monitoringEnabled }, after: { dkimSelectors: after!.dkimSelectors, monitoringEnabled: after!.monitoringEnabled } },
      },
      tx,
    );
    return after!;
  });
}

export async function deleteDomain(orgId: string, domainId: string, actor: AuditActor, reason: string, requestId?: string) {
  const domain = await getDomain(orgId, domainId);
  await db.transaction(async (tx) => {
    await tx.update(mailboxConnections).set({ domainId: null }).where(and(eq(mailboxConnections.orgId, orgId), eq(mailboxConnections.domainId, domainId)));
    await tx.update(campaignReferences).set({ domainId: null }).where(and(eq(campaignReferences.orgId, orgId), eq(campaignReferences.domainId, domainId)));
    await tx.delete(domains).where(and(eq(domains.id, domainId), eq(domains.orgId, orgId)));
    await recordAudit({ orgId, actor, action: "domain.delete", targetType: "domain", targetId: domainId, reason, outcome: "success", requestId, metadata: { domain: domain.name } }, tx);
  });
}

export async function requestScan(
  orgId: string,
  domainId: string,
  trigger: "manual" | "recheck" | "scheduled",
  actor: AuditActor,
  requestId?: string,
) {
  const domain = await getDomain(orgId, domainId);
  if (trigger !== "scheduled") {
    const rl = await checkRateLimit(`scan:${domainId}`, 3, 60);
    if (!rl.allowed) throw rateLimited(rl.retryAfterSeconds);
  }
  await assertCanScan(orgId);
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(domainScans)
      .where(and(eq(domainScans.orgId, orgId), eq(domainScans.domainId, domainId), inArray(domainScans.status, ["queued", "running"])))
      .limit(1);
    if (existing) return { scan: existing, deduplicated: true };
    const [scan] = await tx.insert(domainScans).values({ orgId, domainId, trigger, requestedByUserId: actor.userId ?? null }).returning();
    await enqueueJob({ type: "domain.scan", orgId, payload: { scanId: scan!.id }, idempotencyKey: `scan:${scan!.id}`, priority: trigger === "scheduled" ? 200 : 50 }, tx);
    if (trigger !== "scheduled") {
      await recordAudit({ orgId, actor, action: "domain.scan.request", targetType: "domain", targetId: domainId, outcome: "pending", requestId, metadata: { domain: domain.name, trigger, scanId: scan!.id } }, tx);
    }
    return { scan: scan!, deduplicated: false };
  });
}

/** Inline ownership check: one bounded TXT lookup. */
export async function verifyDomain(orgId: string, domainId: string, actor: AuditActor, requestId?: string, resolver: DnsResolver = defaultResolver()) {
  const domain = await getDomain(orgId, domainId);
  if (domain.verificationStatus === "verified") return { verified: true, detail: "Domain is already verified.", domain };
  const rl = await checkRateLimit(`verify:${domainId}`, 10, 60);
  if (!rl.allowed) throw rateLimited(rl.retryAfterSeconds);

  let [verification] = await db
    .select()
    .from(domainVerifications)
    .where(and(eq(domainVerifications.orgId, orgId), eq(domainVerifications.domainId, domainId), inArray(domainVerifications.status, ["pending", "failed"])))
    .orderBy(desc(domainVerifications.createdAt))
    .limit(1);
  if (!verification) {
    [verification] = await db
      .insert(domainVerifications)
      .values({ orgId, domainId, recordName: verificationRecordName(domain.name), token: generateVerificationToken() })
      .returning();
  }
  const result = await checkVerification(domain.name, verification!.token, resolver);
  const now = new Date();

  try {
    return await db.transaction(async (tx) => {
      await tx
        .update(domainVerifications)
        .set({ status: result.verified ? "verified" : "failed", lastCheckedAt: now, verifiedAt: result.verified ? now : null, evidence: { query: result.evidence, outcome: result.outcome, detail: result.detail, resolver: resolver.label } })
        .where(eq(domainVerifications.id, verification!.id));
      const [updated] = await tx
        .update(domains)
        .set({ verificationStatus: result.verified ? "verified" : "failed", verifiedAt: result.verified ? now : null, updatedAt: now })
        .where(and(eq(domains.id, domainId), eq(domains.orgId, orgId)))
        .returning();
      await recordAudit(
        { orgId, actor, action: "domain.verify", targetType: "domain", targetId: domainId, outcome: result.verified ? "success" : "failure", reason: result.detail, requestId, metadata: { domain: domain.name, dnsOutcome: result.outcome } },
        tx,
      );
      return { verified: result.verified, detail: result.detail, domain: updated! };
    });
  } catch (error: unknown) {
    if (error instanceof Error && /domains_verified_name_uq/.test(error.message + String((error as { cause?: unknown }).cause ?? ""))) {
      throw conflict("This domain has already been verified by another QuikReach organization. Contact support if you believe this is wrong.");
    }
    throw error;
  }
}

/* ─── Worker: execute a scan ──────────────────────────────────────────── */

export async function runScan(orgId: string, scanId: string, resolver: DnsResolver = defaultResolver()) {
  const [scan] = await db.select().from(domainScans).where(and(eq(domainScans.id, scanId), eq(domainScans.orgId, orgId))).limit(1);
  if (!scan) return { skipped: "scan not found" };
  if (scan.status === "completed") return { skipped: "already completed" };
  const domain = await getDomain(orgId, scan.domainId);
  if (scan.trigger === "scheduled") {
    const [org] = await db.select({ paused: organizations.automationPaused }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (org?.paused) {
      await db.update(domainScans).set({ status: "failed", error: "Skipped: automation paused for this organization", completedAt: new Date() }).where(eq(domainScans.id, scanId));
      return { skipped: "automation paused for this organization" };
    }
  }

  await db.update(domainScans).set({ status: "running", startedAt: new Date() }).where(eq(domainScans.id, scanId));

  const providers = await db
    .selectDistinct({ provider: mailboxConnections.provider })
    .from(mailboxConnections)
    .where(and(eq(mailboxConnections.orgId, orgId), eq(mailboxConnections.domainId, domain.id)));
  const mailboxProviders = providers.map((p) => p.provider).filter((p): p is "google" | "microsoft" => p === "google" || p === "microsoft");

  const results = await runDomainChecks(domain.name, resolver, { dkimSelectors: domain.dkimSelectors, mailboxProviders });
  const now = new Date();
  const summary = Object.fromEntries(results.map((r) => [r.checkType, r.status])) as Partial<Record<CheckType, CheckStatus>>;

  await db.transaction(async (tx) => {
    await tx
      .insert(domainChecks)
      .values(
        results.map((r) => ({
          orgId,
          domainId: domain.id,
          scanId,
          checkType: r.checkType,
          status: r.status,
          summary: r.summary,
          findings: r.findings,
          evidence: r.evidence,
          ruleVersion: r.ruleVersion,
          resolver: r.resolver,
          durationMs: r.durationMs,
          checkedAt: now,
        })),
      )
      .onConflictDoNothing();
    await tx
      .update(domainScans)
      .set({ status: "completed", completedAt: now, summary, resolver: resolver.label, ruleVersion: results.map((r) => r.ruleVersion).join(",") })
      .where(eq(domainScans.id, scanId));
    await tx.update(domains).set({ lastScanAt: now, updatedAt: now }).where(eq(domains.id, domain.id));
    await recordUsage({ orgId, metric: "dns_scan", quantity: 1, idempotencyKey: `scan:${scanId}`, source: "domain.scan" }, tx);
    await enqueueJob({ type: "alerts.evaluate", orgId, idempotencyKey: `alerts:${orgId}`, runAt: new Date(Date.now() + 5_000) }, tx);
    await enqueueJob({ type: "health.compute", orgId, idempotencyKey: `health:${orgId}`, runAt: new Date(Date.now() + 5_000) }, tx);
  });
  for (const r of results) incCounter("quikreach_dns_checks_total", { check: r.checkType, status: r.status }, 1, "DNS checks by type and status");
  return { domain: domain.name, summary };
}

export async function markScanFailed(orgId: string, scanId: string, error: string) {
  await db
    .update(domainScans)
    .set({ status: "failed", error: error.slice(0, 500), completedAt: new Date() })
    .where(and(eq(domainScans.id, scanId), eq(domainScans.orgId, orgId)));
}
