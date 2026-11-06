/**
 * Plan entitlements and enforcement.
 *
 * QuikReach never bills here and never silently overbills: limits are HARD
 * stops with a clear message, and usage is recorded in an append-only ledger
 * (lib/usage/ledger.ts). The default limits below are PLACEHOLDERS for a trial
 * workspace — commercial plans and prices need a product owner decision
 * (docs/launch-dependencies.md).
 */
import { and, count, eq, gte, ne, sql } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import { domains, entitlements, mailboxConnections, memberships, usageLedger, type EntitlementLimits, type UsageMetric } from "@/lib/db/schema";
import { limitReached } from "@/lib/api/errors";

export const DEFAULT_LIMITS: EntitlementLimits = {
  maxDomains: 5,
  maxMailboxes: 10,
  maxMembers: 10,
  dnsScansPerDay: 50,
  aiDiagnosesPerMonth: 100,
  eventsPerMonth: 100_000,
};

export async function getEntitlement(orgId: string, executor: Executor = db) {
  const [row] = await executor.select().from(entitlements).where(eq(entitlements.orgId, orgId)).limit(1);
  if (!row) return { plan: "trial", limits: DEFAULT_LIMITS, status: "active" as const, validUntil: null };
  return { plan: row.plan, limits: { ...DEFAULT_LIMITS, ...row.limits }, status: row.status, validUntil: row.validUntil };
}

async function assertActive(orgId: string, executor: Executor) {
  const ent = await getEntitlement(orgId, executor);
  if (ent.status !== "active" || (ent.validUntil && ent.validUntil < new Date())) {
    throw limitReached("This workspace's plan is not active. Contact your QuikIT administrator.");
  }
  return ent;
}

const startOfUtcDay = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};
const startOfUtcMonth = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
};

export async function usageSince(orgId: string, metric: UsageMetric, since: Date, executor: Executor = db): Promise<number> {
  const [row] = await executor
    .select({ total: sql<number>`coalesce(sum(${usageLedger.quantity}), 0)::int` })
    .from(usageLedger)
    .where(and(eq(usageLedger.orgId, orgId), eq(usageLedger.metric, metric), gte(usageLedger.occurredAt, since)));
  return Number(row?.total ?? 0);
}

export async function assertCanAddDomain(orgId: string, executor: Executor = db) {
  const ent = await assertActive(orgId, executor);
  const [row] = await executor.select({ n: count() }).from(domains).where(eq(domains.orgId, orgId));
  if ((row?.n ?? 0) >= ent.limits.maxDomains) throw limitReached(`Your plan allows ${ent.limits.maxDomains} domains. Remove one or ask an administrator to raise the limit.`);
}

export async function assertCanAddMailbox(orgId: string, executor: Executor = db) {
  const ent = await assertActive(orgId, executor);
  const [row] = await executor
    .select({ n: count() })
    .from(mailboxConnections)
    .where(and(eq(mailboxConnections.orgId, orgId), ne(mailboxConnections.state, "disconnected")));
  if ((row?.n ?? 0) >= ent.limits.maxMailboxes) throw limitReached(`Your plan allows ${ent.limits.maxMailboxes} connected mailboxes.`);
}

export async function assertCanAddMember(orgId: string, executor: Executor = db) {
  const ent = await assertActive(orgId, executor);
  const [row] = await executor.select({ n: count() }).from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.status, "active")));
  if ((row?.n ?? 0) >= ent.limits.maxMembers) throw limitReached(`Your plan allows ${ent.limits.maxMembers} members.`);
}

export async function assertCanScan(orgId: string, executor: Executor = db) {
  const ent = await assertActive(orgId, executor);
  const used = await usageSince(orgId, "dns_scan", startOfUtcDay(), executor);
  if (used >= ent.limits.dnsScansPerDay) throw limitReached(`Daily DNS scan limit (${ent.limits.dnsScansPerDay}) reached. Scans reset at 00:00 UTC.`);
}

export async function assertCanDiagnose(orgId: string, executor: Executor = db) {
  const ent = await assertActive(orgId, executor);
  const used = await usageSince(orgId, "ai_diagnosis", startOfUtcMonth(), executor);
  if (used >= ent.limits.aiDiagnosesPerMonth) throw limitReached(`Monthly diagnosis limit (${ent.limits.aiDiagnosesPerMonth}) reached.`);
}

/** Event ingestion is never silently dropped: over the limit we stop ingesting and say so. */
export async function remainingEventAllowance(orgId: string, executor: Executor = db): Promise<number> {
  const ent = await getEntitlement(orgId, executor);
  const used = await usageSince(orgId, "event_ingested", startOfUtcMonth(), executor);
  return Math.max(0, ent.limits.eventsPerMonth - used);
}

export { startOfUtcDay, startOfUtcMonth };
