/**
 * Invitations.
 *
 *  - Token: 32 random bytes; only its SHA-256 digest is stored. The raw token is
 *    returned exactly once (to show/copy, and in the email when SMTP is set).
 *  - Expires after 7 days; single use (conditional update on accepted_at IS NULL).
 *  - Acceptance binds to the invited email: a signed-in user can only accept an
 *    invitation addressed to their own email.
 */
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { invitations, memberships, organizations, users, type Role } from "@/lib/db/schema";
import { randomToken, sha256Hex } from "@/lib/crypto/hash";
import { canAssignRole } from "@/lib/rbac";
import { badRequest, conflict, forbidden, notFound } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import { hashPassword, validatePasswordPolicy } from "@/lib/auth/password";
import { assertCanAddMember } from "@/lib/usage/entitlements";
import { sendEmail } from "@/lib/notify/email";
import { env } from "@/lib/env";
import type { Principal } from "@/lib/api/principal";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function listInvitations(orgId: string) {
  return db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      expiresAt: invitations.expiresAt,
      acceptedAt: invitations.acceptedAt,
      revokedAt: invitations.revokedAt,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .where(eq(invitations.orgId, orgId))
    .orderBy(desc(invitations.createdAt))
    .limit(100);
}

export async function createInvitation(principal: Principal, input: { email: string; role: Role }, requestId?: string) {
  if (!canAssignRole(principal.role, input.role)) throw forbidden("Only an owner can invite another owner.");
  await assertCanAddMember(principal.orgId);
  const email = input.email.trim().toLowerCase();

  const [existingMember] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, principal.orgId), sql`lower(${users.email}) = ${email}`))
    .limit(1);
  if (existingMember) throw conflict("That person is already a member of this organization.");

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const invitation = await db.transaction(async (tx) => {
    // A new invitation supersedes any pending one for the same email.
    await tx
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(and(eq(invitations.orgId, principal.orgId), eq(invitations.email, email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
    const [row] = await tx
      .insert(invitations)
      .values({ orgId: principal.orgId, email, role: input.role, tokenHash: sha256Hex(token), invitedByUserId: principal.userId, expiresAt })
      .returning({ id: invitations.id, email: invitations.email, role: invitations.role, expiresAt: invitations.expiresAt });
    await recordAudit(
      {
        orgId: principal.orgId,
        actor: { type: "user", userId: principal.userId, label: principal.email },
        action: "member.invite",
        targetType: "invitation",
        targetId: row!.id,
        outcome: "success",
        requestId,
        metadata: { email, role: input.role },
      },
      tx,
    );
    return row!;
  });

  const acceptUrl = `${env().APP_URL}/invitations/accept?token=${encodeURIComponent(token)}`;
  const email_ = await sendEmail({
    to: email,
    subject: `You're invited to ${principal.orgName} on QuikReach`,
    text: `${principal.name || principal.email} invited you to join ${principal.orgName} on QuikReach as ${input.role.replace(/_/g, " ")}.\n\nAccept: ${acceptUrl}\n\nThis link expires on ${expiresAt.toUTCString()} and can be used once.`,
  });
  return { invitation, acceptUrl, emailStatus: email_.status };
}

export async function revokeInvitation(principal: Principal, invitationId: string, requestId?: string) {
  const [row] = await db
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(and(eq(invitations.id, invitationId), eq(invitations.orgId, principal.orgId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
    .returning({ id: invitations.id, email: invitations.email });
  if (!row) throw notFound("Pending invitation");
  await recordAudit({
    orgId: principal.orgId,
    actor: { type: "user", userId: principal.userId, label: principal.email },
    action: "member.invite.revoke",
    targetType: "invitation",
    targetId: row.id,
    outcome: "success",
    requestId,
    metadata: { email: row.email },
  });
}

async function findUsableInvitation(token: string) {
  const [row] = await db
    .select({
      id: invitations.id,
      orgId: invitations.orgId,
      email: invitations.email,
      role: invitations.role,
      orgName: organizations.name,
      orgStatus: organizations.status,
    })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.orgId))
    .where(and(eq(invitations.tokenHash, sha256Hex(token)), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())))
    .limit(1);
  return row && row.orgStatus === "active" ? row : null;
}

/** Public, read-only. Returns details ONLY for a working token; uniform answer otherwise. */
export async function describeInvitation(token: string) {
  const inv = await findUsableInvitation(token);
  if (!inv) return { valid: false as const };
  const [account] = await db.select({ id: users.id, hasPassword: sql<boolean>`${users.passwordHash} is not null` }).from(users).where(sql`lower(${users.email}) = ${inv.email}`).limit(1);
  return { valid: true as const, orgName: inv.orgName, email: inv.email, role: inv.role, accountExists: Boolean(account) };
}

export type AcceptInput =
  | { mode: "existing_session"; userId: string; email: string }
  | { mode: "new_account"; name: string; password: string };

export async function acceptInvitation(token: string, input: AcceptInput) {
  const inv = await findUsableInvitation(token);
  if (!inv) throw badRequest("This invitation is invalid, expired, or already used.");

  return db.transaction(async (tx) => {
    let userId: string;
    let actorLabel: string;
    if (input.mode === "existing_session") {
      if (input.email.trim().toLowerCase() !== inv.email) throw forbidden("This invitation was sent to a different email address.");
      userId = input.userId;
      actorLabel = input.email;
    } else {
      const policy = validatePasswordPolicy(input.password);
      if (policy) throw badRequest(policy);
      const [existing] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${inv.email}`).limit(1);
      if (existing) throw conflict("An account already exists for this email. Sign in, then open the invitation link again.");
      const [created] = await tx.insert(users).values({ email: inv.email, name: input.name.trim(), passwordHash: await hashPassword(input.password) }).returning({ id: users.id });
      userId = created!.id;
      actorLabel = inv.email;
    }

    // Single use: only one concurrent acceptance can match this row.
    const [claimed] = await tx
      .update(invitations)
      .set({ acceptedAt: new Date(), acceptedByUserId: userId })
      .where(and(eq(invitations.id, inv.id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
      .returning({ id: invitations.id });
    if (!claimed) throw badRequest("This invitation is invalid, expired, or already used.");

    await tx
      .insert(memberships)
      .values({ orgId: inv.orgId, userId, role: inv.role })
      .onConflictDoUpdate({ target: [memberships.orgId, memberships.userId], set: { role: inv.role, status: "active", disabledAt: null, updatedAt: new Date() } });

    await recordAudit(
      { orgId: inv.orgId, actor: { type: "user", userId, label: actorLabel }, action: "member.invite.accept", targetType: "invitation", targetId: inv.id, outcome: "success", metadata: { role: inv.role } },
      tx,
    );
    return { orgId: inv.orgId, orgName: inv.orgName, email: inv.email };
  });
}
