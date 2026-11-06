/**
 * Production bootstrap: create a workspace with NO members plus a one-time
 * Owner invitation. The person who opens the link sets their own password —
 * no password is ever generated or handled by an operator. Used by
 * scripts/bootstrap-owner.ts when self-signup is disabled.
 */
import { db } from "@/lib/db";
import { alertRules, entitlements, invitations, organizations } from "@/lib/db/schema";
import { DEFAULT_LIMITS } from "@/lib/usage/entitlements";
import { STARTER_RULES } from "@/lib/alerts/starter-rules";
import { slugify } from "@/lib/tenancy/organizations";
import { randomToken, sha256Hex } from "@/lib/crypto/hash";
import { recordAudit, systemActor } from "@/lib/audit";
import { badRequest } from "@/lib/api/errors";
import { env } from "@/lib/env";

export async function bootstrapOrganization(input: { name: string; ownerEmail: string }) {
  const email = input.ownerEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest("A valid owner email is required.");
  if (input.name.trim().length < 2) throw badRequest("Organization name is too short.");
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const org = await db.transaction(async (tx) => {
    const [o] = await tx.insert(organizations).values({ name: input.name.trim(), slug: slugify(input.name) }).returning();
    await tx.insert(entitlements).values({ orgId: o!.id, plan: "trial", limits: DEFAULT_LIMITS });
    await tx.insert(alertRules).values(STARTER_RULES.map((r) => ({ ...r, orgId: o!.id })));
    const [inv] = await tx.insert(invitations).values({ orgId: o!.id, email, role: "owner", tokenHash: sha256Hex(token), expiresAt }).returning({ id: invitations.id });
    await recordAudit({ orgId: o!.id, actor: systemActor, action: "organization.bootstrap", targetType: "invitation", targetId: inv!.id, outcome: "success", metadata: { name: o!.name, ownerEmail: email } }, tx);
    return o!;
  });
  return { orgId: org.id, orgName: org.name, acceptUrl: `${env().APP_URL}/invitations/accept?token=${encodeURIComponent(token)}`, expiresAt };
}
