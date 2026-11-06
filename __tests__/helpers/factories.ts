/**
 * Test data factories. Everything created here is test data in an in-memory DB.
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { domains, memberships, mailboxConnections, organizations, users, entitlements, type Role } from "@/lib/db/schema";
import { DEFAULT_LIMITS } from "@/lib/usage/entitlements";

export async function makeUser(overrides: Partial<typeof users.$inferInsert> = {}) {
  const [u] = await db
    .insert(users)
    .values({ email: `user-${randomUUID().slice(0, 8)}@example.test`, name: "Test User", ...overrides })
    .returning();
  return u!;
}

export async function makeOrg(overrides: Partial<typeof organizations.$inferInsert> = {}) {
  const [o] = await db
    .insert(organizations)
    .values({ name: "Test Org", slug: `org-${randomUUID().slice(0, 8)}`, ...overrides })
    .returning();
  await db.insert(entitlements).values({ orgId: o!.id, plan: "trial", limits: DEFAULT_LIMITS });
  return o!;
}

export async function makeMember(orgId: string, userId: string, role: Role, status: "active" | "disabled" = "active") {
  const [m] = await db.insert(memberships).values({ orgId, userId, role, status }).returning();
  return m!;
}

export async function makeDomain(orgId: string, name = `d-${randomUUID().slice(0, 6)}.example.com`, overrides: Partial<typeof domains.$inferInsert> = {}) {
  const [d] = await db.insert(domains).values({ orgId, name, ...overrides }).returning();
  return d!;
}

export async function makeMailbox(orgId: string, overrides: Partial<typeof mailboxConnections.$inferInsert> = {}) {
  const [m] = await db
    .insert(mailboxConnections)
    .values({
      orgId,
      provider: "google",
      emailAddress: `sender-${randomUUID().slice(0, 6)}@example.com`,
      state: "connected",
      ...overrides,
    })
    .returning();
  return m!;
}

/** A user who is a member of a fresh org with the given role. */
export async function makeTenant(role: Role = "owner") {
  const org = await makeOrg();
  const user = await makeUser();
  const membership = await makeMember(org.id, user.id, role);
  return { org, user, membership };
}
