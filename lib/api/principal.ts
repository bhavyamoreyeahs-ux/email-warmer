/**
 * Resolves WHO is calling and WHICH organisation they are acting in.
 *
 * The organisation is chosen from the `qr_org` cookie when present, but that is
 * only a selection: access is granted solely by an ACTIVE membership row for
 * (user, org) in an ACTIVE organisation, read fresh from the database on every
 * request. A client-supplied org id is never authorization.
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { memberships, organizations, users, type Role } from "@/lib/db/schema";
import { getSelectedOrgId, getSessionIdentity } from "@/lib/api/session";

export interface MembershipSummary {
  orgId: string;
  orgName: string;
  role: Role;
  isDemo: boolean;
}

export interface Principal {
  userId: string;
  email: string;
  name: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
  isDemoOrg: boolean;
  automationPaused: boolean;
  role: Role;
  membershipId: string;
  memberships: MembershipSummary[];
}

export type PrincipalResult =
  | { status: "ok"; principal: Principal }
  | { status: "unauthenticated" }
  | { status: "no_membership"; userId: string; email: string; name: string };

export async function resolvePrincipal(): Promise<PrincipalResult> {
  const identity = await getSessionIdentity();
  if (!identity) return { status: "unauthenticated" };

  const [user] = await db.select().from(users).where(eq(users.id, identity.userId)).limit(1);
  // Disabled accounts and revoked sessions are treated exactly like no session.
  if (!user || user.status !== "active" || user.sessionVersion !== identity.sessionVersion) {
    return { status: "unauthenticated" };
  }

  const rows = await db
    .select({
      membershipId: memberships.id,
      orgId: organizations.id,
      orgName: organizations.name,
      orgSlug: organizations.slug,
      isDemo: organizations.isDemo,
      automationPaused: organizations.automationPaused,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.userId, user.id), eq(memberships.status, "active"), eq(organizations.status, "active")))
    .orderBy(asc(organizations.isDemo), asc(memberships.createdAt));

  if (!rows.length) return { status: "no_membership", userId: user.id, email: user.email, name: user.name };

  const selected = await getSelectedOrgId();
  const active = rows.find((r) => r.orgId === selected) ?? rows[0]!;

  return {
    status: "ok",
    principal: {
      userId: user.id,
      email: user.email,
      name: user.name,
      orgId: active.orgId,
      orgName: active.orgName,
      orgSlug: active.orgSlug,
      isDemoOrg: active.isDemo,
      automationPaused: active.automationPaused,
      role: active.role,
      membershipId: active.membershipId,
      memberships: rows.map((r) => ({ orgId: r.orgId, orgName: r.orgName, role: r.role, isDemo: r.isDemo })),
    },
  };
}
