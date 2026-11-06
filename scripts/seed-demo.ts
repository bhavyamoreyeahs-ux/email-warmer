/**
 * DEMO DATA SEED — `npm run db:seed:demo`
 *
 * Creates an isolated, conspicuously labelled DEMO workspace:
 *   - organisation flagged is_demo (a banner is shown on every page)
 *   - domain under the reserved `.example` TLD (cannot be a real domain)
 *   - mailboxes with provider "demo" / state "demo" (a DB check constraint
 *     prevents demo rows outside demo provider)
 *   - DNS check rows with rule_version "demo-seed" and resolver
 *     "demo-seed (not a live DNS query)"
 *   - provider events with source "demo_seed", is_demo = true
 * Live data is never written to this workspace (API rejects live-data
 * operations in demo orgs), and demo data is never written anywhere else.
 *
 * Login: demo@quikreach.test with DEMO_USER_PASSWORD, or a random password
 * printed once by this script.
 */
import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, closeDb } from "@/lib/db";
import {
  domainChecks,
  domainScans,
  domains,
  mailboxConnections,
  memberships,
  organizations,
  providerCapabilities,
  providerEvents,
  users,
  type CheckFinding,
  type EventCategory,
} from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { createOrganizationWithOwner } from "@/lib/tenancy/organizations";
import { evaluateOrgRules } from "@/lib/alerts/evaluate";
import { storeHealthSnapshots } from "@/lib/health/service";
import { recipientHash } from "@/lib/crypto/hash";

const DEMO_EMAIL = "demo@quikreach.test";
const DEMO_ORG_NAME = "DEMO — Northwind Outbound (sample data)";
const DEMO_DOMAIN = "northwind-demo.example";
const SEED_RESOLVER = "demo-seed (not a live DNS query)";

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

async function main() {
  const existing = await db.select({ id: organizations.id }).from(organizations).where(and(eq(organizations.isDemo, true), eq(organizations.name, DEMO_ORG_NAME)));
  if (existing.length && !process.argv.includes("--reset")) {
    console.log("[seed-demo] demo workspace already exists (use --reset to recreate it).");
    return;
  }
  for (const o of existing) await db.delete(organizations).where(eq(organizations.id, o.id));

  const password = process.env.DEMO_USER_PASSWORD || `Demo-${randomBytes(9).toString("base64url")}1`;
  let [user] = await db.select().from(users).where(sql`lower(${users.email}) = ${DEMO_EMAIL}`).limit(1);
  if (!user) {
    [user] = await db.insert(users).values({ email: DEMO_EMAIL, name: "Demo User", passwordHash: await hashPassword(password) }).returning();
  } else {
    await db.update(users).set({ passwordHash: await hashPassword(password), status: "active" }).where(eq(users.id, user.id));
  }

  const org = await createOrganizationWithOwner({ name: DEMO_ORG_NAME, ownerUserId: user!.id, actor: { type: "system", label: "seed-demo" }, isDemo: true });
  const orgId = org.id;
  const now = Date.now();

  const [domain] = await db
    .insert(domains)
    .values({ orgId, name: DEMO_DOMAIN, verificationStatus: "verified", verifiedAt: new Date(now - 20 * 86_400_000), dkimSelectors: ["demo1"], lastScanAt: new Date(now - 3 * 3_600_000) })
    .returning();

  // Two demo scans so the comparison view has something to compare.
  const scanDefs: Array<{ ageHours: number; spf: "pass" | "warn"; dmarc: "warn" | "pass" }> = [
    { ageHours: 75, spf: "warn", dmarc: "warn" },
    { ageHours: 3, spf: "pass", dmarc: "warn" },
  ];
  for (const s of scanDefs) {
    const at = new Date(now - s.ageHours * 3_600_000);
    const [scan] = await db
      .insert(domainScans)
      .values({ orgId, domainId: domain!.id, trigger: "manual", status: "completed", ruleVersion: "demo-seed", resolver: SEED_RESOLVER, startedAt: at, completedAt: at, createdAt: at, summary: { mx: "pass", spf: s.spf, dkim: "pass", dmarc: s.dmarc } })
      .returning();
    const spfRecord = s.spf === "pass" ? "v=spf1 include:_spf.google.com -all" : "v=spf1 include:_spf.google.com include:mail.example-esp.example ?all";
    const mk = (checkType: "mx" | "spf" | "dkim" | "dmarc", status: "pass" | "warn", summary: string, findings: CheckFinding[], name: string, answers: string[]) => ({
      orgId,
      domainId: domain!.id,
      scanId: scan!.id,
      checkType,
      status,
      summary: `[DEMO] ${summary}`,
      findings,
      evidence: { queries: [{ name, type: checkType === "mx" ? ("MX" as const) : ("TXT" as const), answers, outcome: "NOERROR", durationMs: 0 }], parsed: { demo: true } },
      ruleVersion: "demo-seed",
      resolver: SEED_RESOLVER,
      durationMs: 0,
      checkedAt: at,
    });
    await db.insert(domainChecks).values([
      mk("mx", "pass", "MX records route mail to Google Workspace.", [], DEMO_DOMAIN, ["1 aspmx.l.google.com.", "5 alt1.aspmx.l.google.com."]),
      mk(
        "spf",
        s.spf,
        s.spf === "pass" ? "SPF authorises Google Workspace and ends with -all." : "SPF ends with ?all (neutral), which does not tell receivers to reject unauthorised senders.",
        s.spf === "pass" ? [] : [{ code: "spf_neutral_all", severity: "warning", message: "Record ends with ?all.", recommendation: "Use ~all or -all once all legitimate senders are listed." }],
        DEMO_DOMAIN,
        [spfRecord],
      ),
      mk("dkim", "pass", "Selector demo1 publishes a 2048-bit RSA key.", [], `demo1._domainkey.${DEMO_DOMAIN}`, ["v=DKIM1; k=rsa; p=MIIB…(demo)"]),
      mk(
        "dmarc",
        "warn",
        "DMARC policy is p=none (monitoring only).",
        [{ code: "dmarc_policy_none", severity: "warning", message: "p=none does not ask receivers to act on failing mail.", recommendation: "Move to p=quarantine after reviewing aggregate reports." }],
        `_dmarc.${DEMO_DOMAIN}`,
        ["v=DMARC1; p=none; rua=mailto:dmarc@northwind-demo.example"],
      ),
    ]);
  }

  const mailboxes = await db
    .insert(mailboxConnections)
    .values([
      { orgId, domainId: domain!.id, provider: "demo", emailAddress: `alex@${DEMO_DOMAIN}`, displayName: "Alex (demo)", state: "demo", stateReason: "Demo connection — seeded sample data, not a live mailbox.", isDemo: true, lastSuccessfulSyncAt: new Date(now - 20 * 60_000) },
      { orgId, domainId: domain!.id, provider: "demo", emailAddress: `sam@${DEMO_DOMAIN}`, displayName: "Sam (demo)", state: "demo", stateReason: "Demo connection — seeded sample data, not a live mailbox.", isDemo: true, lastSuccessfulSyncAt: new Date(now - 25 * 60_000) },
    ])
    .returning();

  for (const m of mailboxes) {
    await db.insert(providerCapabilities).values(
      [
        ["sent_volume", "available", "Demo: sent counts are seeded."],
        ["bounce_detection", "available", "Demo: bounces are seeded."],
        ["bounce_classification", "partial", "Demo: mirrors live behaviour — classification is header/subject-based."],
        ["reply_detection", "partial", "Demo: mirrors live behaviour — header-based."],
        ["complaint_feedback", "partial", "Demo: mirrors live behaviour — only ARF reports delivered to the mailbox."],
        ["inbox_placement", "unavailable", "Not measured by QuikReach."],
        ["open_tracking", "unavailable", "QuikReach does not track opens."],
      ].map(([capability, status, detail]) => ({ orgId, connectionId: m.id, capability: capability!, status: status as "available", detail: detail! })),
    );
  }

  // Events: 14 days. Sam's mailbox has a bounce spike in the last 24h so a demo alert fires.
  const rand = rng(42);
  const recipientDomains = ["acme-demo.example", "globex-demo.example", "initech-demo.example", "umbrella-demo.example", "hooli-demo.example"];
  const rows: Array<typeof providerEvents.$inferInsert> = [];
  for (const [idx, m] of mailboxes.entries()) {
    for (let day = 13; day >= 0; day--) {
      const sent = 40 + Math.floor(rand() * 30);
      const spike = idx === 1 && day === 0;
      const counts: Partial<Record<EventCategory, number>> = {
        sent,
        hard_bounce: spike ? 9 : Math.floor(rand() * 2),
        soft_bounce: spike ? 3 : Math.floor(rand() * 2),
        reply: Math.floor(rand() * 4),
        auto_reply: Math.floor(rand() * 3),
        unsubscribe: rand() > 0.85 ? 1 : 0,
        provider_error: spike ? 1 : 0,
      };
      for (const [category, n] of Object.entries(counts) as Array<[EventCategory, number]>) {
        for (let i = 0; i < n; i++) {
          const occurredAt = new Date(now - day * 86_400_000 - Math.floor(rand() * (day === 0 ? 20 : 23)) * 3_600_000 - Math.floor(rand() * 3_600_000));
          const ref = `demo-${m.id.slice(0, 8)}-${day}-${category}-${i}`;
          const recipient = category === "sent" ? null : `contact${i}@${recipientDomains[Math.floor(rand() * recipientDomains.length)]}`;
          rows.push({
            orgId,
            connectionId: m.id,
            domainId: domain!.id,
            provider: "demo",
            source: "demo_seed",
            category,
            dedupeKey: `demo:${m.id}:${ref}:${category}`,
            providerMessageRef: ref,
            occurredAt,
            recipientDomain: recipient ? recipient.split("@")[1]! : null,
            recipientHash: recipient ? recipientHash(orgId, recipient) : null,
            confidence: category === "sent" ? "high" : "medium",
            classificationBasis: "demo-seed (synthetic sample event)",
            metadata: { demo: true },
            isDemo: true,
          });
        }
      }
    }
  }
  for (let i = 0; i < rows.length; i += 500) await db.insert(providerEvents).values(rows.slice(i, i + 500));

  const evaluation = await evaluateOrgRules(orgId);
  await storeHealthSnapshots(orgId);

  // Sanity: the demo user is only a member of the demo workspace unless they joined others.
  const member = await db.select().from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, user!.id)));
  console.log("[seed-demo] DEMO workspace created (sample data only):");
  console.log(`  organization: ${DEMO_ORG_NAME}`);
  console.log(`  events: ${rows.length}, alerts created: ${evaluation.created}, membership role: ${member[0]?.role}`);
  console.log(`  login: ${DEMO_EMAIL}`);
  if (!process.env.DEMO_USER_PASSWORD) console.log(`  password (shown once): ${password}`);
}

main()
  .then(() => closeDb())
  .catch(async (error: unknown) => {
    console.error("[seed-demo] failed:", error instanceof Error ? error.message : error);
    await closeDb();
    process.exit(1);
  });
