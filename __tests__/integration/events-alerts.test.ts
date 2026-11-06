/**
 * Event ingestion idempotency, data minimisation, and alert behaviour:
 * minimum samples, dedupe, cooldown, dry runs, and honest campaign outcomes.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "../helpers/db";
import { makeMailbox, makeTenant } from "../helpers/factories";
import { db } from "@/lib/db";
import { alertRules, alerts, notifications, providerEvents } from "@/lib/db/schema";
import { ingestSignals } from "@/lib/events/ingest";
import { applyEvaluations, evaluateRule } from "@/lib/alerts/evaluate";
import { testRule } from "@/lib/alerts/rules";
import type { NormalizedSignal } from "@/lib/mailboxes/providers/types";

const sig = (ref: string, category: NormalizedSignal["category"], counterparty: string | null = null, minutesAgo = 10): NormalizedSignal => ({
  providerMessageRef: ref,
  category,
  occurredAt: new Date(Date.now() - minutesAgo * 60_000),
  counterpartyAddress: counterparty,
  confidence: "medium",
  classificationBasis: "test",
  diagnosticCode: null,
  metadata: {},
});

describe("event ingestion", () => {
  let t: Awaited<ReturnType<typeof makeTenant>>;
  let conn: Awaited<ReturnType<typeof makeMailbox>>;
  beforeAll(async () => {
    await createTestDb();
    t = await makeTenant();
    conn = await makeMailbox(t.org.id);
  });

  it("is idempotent across re-delivery and retries", async () => {
    const target = { orgId: t.org.id, connectionId: conn.id, domainId: null, provider: "google" as const, source: "gmail_api" };
    const batch = [sig("m1", "hard_bounce", "Jane.Doe@Customer.example"), sig("m2", "reply", "bob@client.example"), sig("m3", "sent")];
    const first = await ingestSignals(target, batch);
    const second = await ingestSignals(target, batch);
    expect(first).toMatchObject({ created: 3, duplicate: 0 });
    expect(second).toMatchObject({ created: 0, duplicate: 3 });
  });

  it("keeps unknown outcomes distinct and stores no raw addresses", async () => {
    const target = { orgId: t.org.id, connectionId: conn.id, domainId: null, provider: "google" as const, source: "gmail_api" };
    await ingestSignals(target, [sig("m4", "unknown"), sig("m4", "bounce_unclassified")]);
    const rows = await db.select().from(providerEvents).where(eq(providerEvents.orgId, t.org.id));
    expect(rows.filter((r) => r.providerMessageRef === "m4").map((r) => r.category).sort()).toEqual(["bounce_unclassified", "unknown"]);
    const bounce = rows.find((r) => r.providerMessageRef === "m1")!;
    expect(bounce.recipientDomain).toBe("customer.example");
    expect(bounce.recipientHash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(rows).toLowerCase()).not.toContain("jane.doe");
  });
});

describe("alert evaluation", () => {
  let t: Awaited<ReturnType<typeof makeTenant>>;
  let conn: Awaited<ReturnType<typeof makeMailbox>>;
  const baseRule = {
    name: "Bounce test",
    description: "",
    metric: "bounce_rate" as const,
    scopeType: "organization" as const,
    scopeId: null,
    comparator: "gte" as const,
    threshold: 0.05,
    windowMinutes: 1440,
    minSample: 50,
    severity: "critical" as const,
    notificationTargets: { inApp: true, emails: [] },
    actionPolicy: "pause_campaigns" as const,
    requireManualResume: true,
    cooldownMinutes: 60,
    enabled: true,
  };

  beforeAll(async () => {
    await createTestDb();
    t = await makeTenant();
    conn = await makeMailbox(t.org.id);
  });

  it("reports insufficient data below the minimum sample instead of firing", async () => {
    const target = { orgId: t.org.id, connectionId: conn.id, domainId: null, provider: "google" as const, source: "gmail_api" };
    await ingestSignals(target, [
      ...Array.from({ length: 10 }, (_, i) => sig(`s${i}`, "sent")),
      ...Array.from({ length: 5 }, (_, i) => sig(`b${i}`, "hard_bounce", `x${i}@r.example`)),
    ]);
    const [res] = await evaluateRule({ ...baseRule, orgId: t.org.id });
    expect(res!.status).toBe("insufficient_data");
    expect(res!.evidence.denominator).toBe(10);
  });

  it("fires with evidence once the sample is met, dedupes repeats, and never claims a pause without an integration", async () => {
    const target = { orgId: t.org.id, connectionId: conn.id, domainId: null, provider: "google" as const, source: "gmail_api" };
    await ingestSignals(target, Array.from({ length: 50 }, (_, i) => sig(`s2-${i}`, "sent")));
    const [rule] = await db.insert(alertRules).values({ ...baseRule, orgId: t.org.id }).returning();
    const results = await evaluateRule(rule!);
    expect(results[0]!.status).toBe("triggered");
    expect(results[0]!.evidence.sampleEventIds.length).toBeGreaterThan(0);

    const first = await applyEvaluations(rule!, results);
    const second = await applyEvaluations(rule!, await evaluateRule(rule!));
    expect(first.created).toHaveLength(1);
    expect(second.created).toHaveLength(0);
    expect(second.updated).toHaveLength(1);

    const [alert] = await db.select().from(alerts).where(eq(alerts.id, first.created[0]!));
    expect(alert!.occurrences).toBe(2);
    expect(alert!.actionOutcome).toBe("no_campaign_integration");
    const [note] = await db.select().from(notifications).where(and(eq(notifications.alertId, alert!.id), eq(notifications.channel, "in_app")));
    expect(note!.body).toContain("has NOT paused anything");
  });

  it("does not re-open a just-resolved alert within the cooldown", async () => {
    const [rule] = await db.select().from(alertRules).where(eq(alertRules.orgId, t.org.id));
    await db.update(alerts).set({ status: "resolved", resolvedAt: new Date() }).where(eq(alerts.orgId, t.org.id));
    const again = await applyEvaluations(rule!, await evaluateRule(rule!));
    expect(again.created).toHaveLength(0);
  });

  it("dry runs create nothing and say a pause is impossible without an integration", async () => {
    const before = (await db.select().from(alerts).where(eq(alerts.orgId, t.org.id))).length;
    const result = await testRule(t.org.id, { ...baseRule, name: "Dry run" }, { type: "user", label: "tester" });
    expect(result.dryRun).toBe(true);
    expect(result.wouldTrigger).toBe(1);
    expect(result.action).toMatch(/cannot pause/i);
    expect((await db.select().from(alerts).where(eq(alerts.orgId, t.org.id))).length).toBe(before);
  });
});
