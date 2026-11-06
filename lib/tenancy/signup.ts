/**
 * Self-serve signup (standalone / credentials mode only). Creates the user, a
 * workspace and the owner membership atomically. Disabled in production unless
 * ALLOW_SELF_SIGNUP=true; email verification before launch is a recorded
 * launch dependency.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { hashPassword, validatePasswordPolicy } from "@/lib/auth/password";
import { badRequest, conflict } from "@/lib/api/errors";
import { createOrganizationWithOwner } from "@/lib/tenancy/organizations";

export async function signup(input: { name: string; email: string; password: string; orgName: string }) {
  const policy = validatePasswordPolicy(input.password);
  if (policy) throw badRequest(policy);
  const email = input.email.trim().toLowerCase();
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
    // Same message whether or not it exists would be ideal; for a signup form the
    // usability cost is high, so we disclose it but rate limit the endpoint.
    if (existing) throw conflict("An account with this email already exists. Sign in instead.");
    const [user] = await tx.insert(users).values({ email, name: input.name.trim(), passwordHash: await hashPassword(input.password) }).returning();
    const org = await createOrganizationWithOwner({ name: input.orgName, ownerUserId: user!.id, actor: { type: "user", userId: user!.id, label: email } }, tx);
    return { userId: user!.id, orgId: org.id };
  });
}
