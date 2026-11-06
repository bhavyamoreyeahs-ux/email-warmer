/**
 * Membership management: roles, disable/enable, removal.
 *
 * Invariants: an organisation always keeps at least one active owner; only an
 * owner can grant/revoke the owner role (lib/rbac.ts canAssignRole); a
 * disabled member loses API access on their next request because principals
 * are resolved from the database per request.
 */
import { and, asc, count, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { memberships, users, type Role } from "@/lib/db/schema";
import { canAssignRole } from "@/lib/rbac";
import { badRequest, conflict, forbidden, notFound } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import type { Principal } from "@/lib/api/principal";

export async function listMembers(orgId: string) {
  return db
    .select({
      id: memberships.id,
      userId: users.id,
      email: users.email,
      name: users.name,
      role: memberships.role,
      status: memberships.status,
      lastLoginAt: users.lastLoginAt,
      createdAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.orgId, orgId))
    .orderBy(asc(memberships.createdAt));
}

async function loadMember(orgId: string, membershipId: string) {
  const [m] = await db
    .select({ id: memberships.id, userId: memberships.userId, role: memberships.role, status: memberships.status, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.id, membershipId), eq(memberships.orgId, orgId)))
    .limit(1);
  if (!m) throw notFound("Member");
  return m;
}

async function activeOwnerCount(orgId: string, excludingMembershipId?: string) {
  const conds = [eq(memberships.orgId, orgId), eq(memberships.role, "owner"), eq(memberships.status, "active")];
  if (excludingMembershipId) conds.push(ne(memberships.id, excludingMembershipId));
  const [row] = await db.select({ n: count() }).from(memberships).where(and(...conds));
  return row?.n ?? 0;
}

export async function updateMemberRole(principal: Principal, membershipId: string, role: Role, requestId?: string) {
  const target = await loadMember(principal.orgId, membershipId);
  if (!canAssignRole(principal.role, role) || !canAssignRole(principal.role, target.role)) {
    throw forbidden("Only an owner can grant or change the Owner role.");
  }
  if (target.role === "owner" && role !== "owner" && (await activeOwnerCount(principal.orgId, membershipId)) === 0) {
    throw conflict("An organization must keep at least one active owner.");
  }
  await db.transaction(async (tx) => {
    await tx.update(memberships).set({ role, updatedAt: new Date() }).where(and(eq(memberships.id, membershipId), eq(memberships.orgId, principal.orgId)));
    await recordAudit(
      {
        orgId: principal.orgId,
        actor: { type: "user", userId: principal.userId, label: principal.email },
        action: "member.role.update",
        targetType: "membership",
        targetId: membershipId,
        outcome: "success",
        requestId,
        metadata: { member: target.email, from: target.role, to: role },
      },
      tx,
    );
  });
}

export async function setMemberStatus(principal: Principal, membershipId: string, status: "active" | "disabled", reason: string, requestId?: string) {
  const target = await loadMember(principal.orgId, membershipId);
  if (target.userId === principal.userId) throw badRequest("You cannot change your own membership status.");
  if (!canAssignRole(principal.role, target.role)) throw forbidden("Only an owner can disable another owner.");
  if (status === "disabled" && target.role === "owner" && (await activeOwnerCount(principal.orgId, membershipId)) === 0) {
    throw conflict("An organization must keep at least one active owner.");
  }
  await db.transaction(async (tx) => {
    await tx
      .update(memberships)
      .set({ status, disabledAt: status === "disabled" ? new Date() : null, updatedAt: new Date() })
      .where(and(eq(memberships.id, membershipId), eq(memberships.orgId, principal.orgId)));
    await recordAudit(
      {
        orgId: principal.orgId,
        actor: { type: "user", userId: principal.userId, label: principal.email },
        action: status === "disabled" ? "member.disable" : "member.enable",
        targetType: "membership",
        targetId: membershipId,
        reason,
        outcome: "success",
        requestId,
        metadata: { member: target.email },
      },
      tx,
    );
  });
}

export async function removeMember(principal: Principal, membershipId: string, reason: string, requestId?: string) {
  const target = await loadMember(principal.orgId, membershipId);
  if (target.userId === principal.userId) throw badRequest("You cannot remove yourself.");
  if (!canAssignRole(principal.role, target.role)) throw forbidden("Only an owner can remove another owner.");
  if (target.role === "owner" && (await activeOwnerCount(principal.orgId, membershipId)) === 0) {
    throw conflict("An organization must keep at least one active owner.");
  }
  await db.transaction(async (tx) => {
    await tx.delete(memberships).where(and(eq(memberships.id, membershipId), eq(memberships.orgId, principal.orgId)));
    await recordAudit(
      {
        orgId: principal.orgId,
        actor: { type: "user", userId: principal.userId, label: principal.email },
        action: "member.remove",
        targetType: "membership",
        targetId: membershipId,
        reason,
        outcome: "success",
        requestId,
        metadata: { member: target.email, role: target.role },
      },
      tx,
    );
  });
}
