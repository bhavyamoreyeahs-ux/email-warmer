import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/db";
import { makeDomain, makeMailbox, makeTenant, makeUser } from "../helpers/factories";
import { db } from "@/lib/db";
import { auditLogs, domainScans, invitations, memberships, organizations, providerEvents } from "@/lib/db/schema";
import { acceptInvitation, createInvitation, describeInvitation } from "@/lib/tenancy/invitations";
import { purgeOrganization } from "@/lib/retention/purge";
import type { Principal } from "@/lib/api/principal";

const asPrincipal = (t: Awaited<ReturnType<typeof makeTenant>>): Principal => ({
  userId: t.user.id,
  email: t.user.email,
  name: t.user.name,
  orgId: t.org.id,
  orgName: t.org.name,
  orgSlug: t.org.slug,
  isDemoOrg: false,
  automationPaused: false,
  role: t.membership.role,
  membershipId: t.membership.id,
  memberships: [],
});

describe("invitations", () => {
  let t: Awaited<ReturnType<typeof makeTenant>>;
  beforeAll(async () => {
    await createTestDb();
    t = await makeTenant("owner");
  });

  it("stores only a token digest, is single-use, and binds to the invited email", async () => {
    const { acceptUrl, emailStatus } = await createInvitation(asPrincipal(t), { email: "New.Person@Example.test", role: "analyst" });
    expect(emailStatus).toBe("not_configured");
    const token = new URL(acceptUrl).searchParams.get("token")!;
    const [row] = await db.select().from(invitations).where(eq(invitations.orgId, t.org.id));
    expect(row!.tokenHash).not.toContain(token);
    expect(row!.email).toBe("new.person@example.test");

    expect(await describeInvitation(token)).toMatchObject({ valid: true, accountExists: false });
    expect(await describeInvitation("x".repeat(43))).toEqual({ valid: false });

    const stranger = await makeUser({ email: "someone.else@example.test" });
    await expect(acceptInvitation(token, { mode: "existing_session", userId: stranger.id, email: stranger.email })).rejects.toMatchObject({ status: 403 });

    await expect(acceptInvitation(token, { mode: "new_account", name: "New", password: "short" })).rejects.toMatchObject({ status: 400 });
    const ok = await acceptInvitation(token, { mode: "new_account", name: "New Person", password: "a-long-password-123" });
    expect(ok.orgId).toBe(t.org.id);
    const members = await db.select().from(memberships).where(eq(memberships.orgId, t.org.id));
    expect(members.find((m) => m.role === "analyst")).toBeDefined();
    await expect(acceptInvitation(token, { mode: "new_account", name: "Again", password: "a-long-password-123" })).rejects.toMatchObject({ status: 400 });
  });

  it("only owners can invite owners", async () => {
    const admin = await makeTenant("admin");
    await expect(createInvitation(asPrincipal(admin), { email: "boss@example.test", role: "owner" })).rejects.toMatchObject({ status: 403 });
  });
});

describe("retention purge", () => {
  it("deletes expired events and scans but always keeps the latest scan per domain, and audits the purge", async () => {
    await createTestDb();
    const t = await makeTenant();
    await db.update(organizations).set({ eventRetentionDays: 30 }).where(eq(organizations.id, t.org.id));
    const conn = await makeMailbox(t.org.id);
    const old = new Date(Date.now() - 60 * 86_400_000);
    await db.insert(providerEvents).values([
      { orgId: t.org.id, connectionId: conn.id, provider: "google", source: "gmail_api", category: "sent", dedupeKey: "old", occurredAt: old, confidence: "high", classificationBasis: "t" },
      { orgId: t.org.id, connectionId: conn.id, provider: "google", source: "gmail_api", category: "sent", dedupeKey: "new", occurredAt: new Date(), confidence: "high", classificationBasis: "t" },
    ]);
    const d = await makeDomain(t.org.id);
    await db.insert(domainScans).values([
      { orgId: t.org.id, domainId: d.id, trigger: "manual", status: "completed", createdAt: new Date(old.getTime() - 86_400_000), completedAt: new Date(old.getTime() - 86_400_000) },
      { orgId: t.org.id, domainId: d.id, trigger: "manual", status: "completed", createdAt: old, completedAt: old },
    ]);

    const counts = await purgeOrganization(t.org.id);
    expect(counts).toMatchObject({ events: 1, domainScans: 1 });
    expect((await db.select().from(providerEvents).where(eq(providerEvents.orgId, t.org.id))).map((e) => e.dedupeKey)).toEqual(["new"]);
    expect(await db.select().from(domainScans).where(eq(domainScans.orgId, t.org.id))).toHaveLength(1);
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.orgId, t.org.id));
    expect(audit.some((a) => a.action === "retention.purge" && a.actorType === "system")).toBe(true);
  });
});
