import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/db";
import { db } from "@/lib/db";
import { alertRules, memberships } from "@/lib/db/schema";
import { bootstrapOrganization } from "@/lib/tenancy/bootstrap";
import { acceptInvitation } from "@/lib/tenancy/invitations";

describe("owner bootstrap", () => {
  beforeAll(async () => {
    await createTestDb();
  });

  it("creates a member-less workspace whose single-use invite makes the acceptor its owner", async () => {
    const r = await bootstrapOrganization({ name: "Acme Outbound", ownerEmail: "Owner@Acme.example" });
    expect(await db.select().from(memberships).where(eq(memberships.orgId, r.orgId))).toHaveLength(0);
    expect((await db.select().from(alertRules).where(eq(alertRules.orgId, r.orgId))).length).toBeGreaterThan(0);
    const token = new URL(r.acceptUrl).searchParams.get("token")!;
    await acceptInvitation(token, { mode: "new_account", name: "Owner", password: "a-long-password-123" });
    const [m] = await db.select().from(memberships).where(eq(memberships.orgId, r.orgId));
    expect(m!.role).toBe("owner");
    await expect(acceptInvitation(token, { mode: "new_account", name: "Again", password: "a-long-password-123" })).rejects.toMatchObject({ status: 400 });
  });
});
