/** Usage vs. entitlement for the Reports & Usage page. Read-only; QuikReach does not bill. */
import { and, count, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, mailboxConnections, memberships } from "@/lib/db/schema";
import { getEntitlement, startOfUtcDay, startOfUtcMonth, usageSince } from "@/lib/usage/entitlements";

export async function getUsageOverview(orgId: string) {
  const ent = await getEntitlement(orgId);
  const [d] = await db.select({ n: count() }).from(domains).where(eq(domains.orgId, orgId));
  const [m] = await db.select({ n: count() }).from(mailboxConnections).where(and(eq(mailboxConnections.orgId, orgId), ne(mailboxConnections.state, "disconnected")));
  const [u] = await db.select({ n: count() }).from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.status, "active")));
  return {
    plan: ent.plan,
    status: ent.status,
    validUntil: ent.validUntil,
    note: "Plan limits are placeholders for trial workspaces. QuikReach stops at a limit rather than charging overage.",
    meters: [
      { key: "domains", label: "Domains", used: d?.n ?? 0, limit: ent.limits.maxDomains, period: "current" },
      { key: "mailboxes", label: "Connected mailboxes", used: m?.n ?? 0, limit: ent.limits.maxMailboxes, period: "current" },
      { key: "members", label: "Active members", used: u?.n ?? 0, limit: ent.limits.maxMembers, period: "current" },
      { key: "dns_scans", label: "DNS scans today", used: await usageSince(orgId, "dns_scan", startOfUtcDay()), limit: ent.limits.dnsScansPerDay, period: "day (UTC)" },
      { key: "ai_diagnoses", label: "Diagnoses this month", used: await usageSince(orgId, "ai_diagnosis", startOfUtcMonth()), limit: ent.limits.aiDiagnosesPerMonth, period: "month (UTC)" },
      { key: "events", label: "Events ingested this month", used: await usageSince(orgId, "event_ingested", startOfUtcMonth()), limit: ent.limits.eventsPerMonth, period: "month (UTC)" },
      { key: "inbox_tests", label: "Inbox placement tests", used: 0, limit: 0, period: "not available in this release" },
    ],
  };
}
