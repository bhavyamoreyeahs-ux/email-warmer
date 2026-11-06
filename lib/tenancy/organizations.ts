/**
 * Organisations: creation (with owner membership, entitlement and starter
 * monitor-only alert rules), settings, retention and the automation kill switch.
 */
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db, type Executor } from "@/lib/db";
import { alertRules, entitlements, memberships, organizations, type OrgSettings } from "@/lib/db/schema";
import { DEFAULT_LIMITS } from "@/lib/usage/entitlements";
import { recordAudit, type AuditActor } from "@/lib/audit";
import { STARTER_RULES } from "@/lib/alerts/starter-rules";
import { notFound } from "@/lib/api/errors";

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "workspace"}-${randomBytes(3).toString("hex")}`;
}

export async function createOrganizationWithOwner(
  input: { name: string; ownerUserId: string; actor: AuditActor; isDemo?: boolean },
  executor?: Executor,
) {
  const run = async (tx: Executor) => {
    const [org] = await tx
      .insert(organizations)
      .values({ name: input.name.trim(), slug: slugify(input.name), isDemo: input.isDemo ?? false })
      .returning();
    await tx.insert(memberships).values({ orgId: org!.id, userId: input.ownerUserId, role: "owner" });
    await tx.insert(entitlements).values({ orgId: org!.id, plan: "trial", limits: DEFAULT_LIMITS });
    await tx.insert(alertRules).values(
      STARTER_RULES.map((r) => ({ ...r, orgId: org!.id, createdByUserId: input.ownerUserId, updatedByUserId: input.ownerUserId })),
    );
    await recordAudit(
      { orgId: org!.id, actor: input.actor, action: "organization.create", targetType: "organization", targetId: org!.id, outcome: "success", metadata: { name: org!.name, isDemo: org!.isDemo } },
      tx,
    );
    return org!;
  };
  return executor ? run(executor) : db.transaction((tx) => run(tx));
}

export async function getOrganization(orgId: string) {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) throw notFound("Organization");
  return org;
}

export interface OrgUpdate {
  name?: string;
  eventRetentionDays?: number | null;
  diagnosticRetentionDays?: number | null;
  auditRetentionDays?: number | null;
  settings?: OrgSettings;
}

export async function updateOrganization(orgId: string, patch: OrgUpdate, actor: AuditActor, requestId?: string) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (!before) throw notFound("Organization");
    const [after] = await tx
      .update(organizations)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.eventRetentionDays !== undefined ? { eventRetentionDays: patch.eventRetentionDays } : {}),
        ...(patch.diagnosticRetentionDays !== undefined ? { diagnosticRetentionDays: patch.diagnosticRetentionDays } : {}),
        ...(patch.auditRetentionDays !== undefined ? { auditRetentionDays: patch.auditRetentionDays } : {}),
        ...(patch.settings !== undefined ? { settings: { ...before.settings, ...patch.settings } } : {}),
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, orgId))
      .returning();
    const retentionChanged =
      patch.eventRetentionDays !== undefined || patch.diagnosticRetentionDays !== undefined || patch.auditRetentionDays !== undefined;
    await recordAudit(
      {
        orgId,
        actor,
        action: retentionChanged ? "organization.retention.update" : "organization.update",
        targetType: "organization",
        targetId: orgId,
        outcome: "success",
        requestId,
        metadata: {
          before: { name: before.name, eventRetentionDays: before.eventRetentionDays, diagnosticRetentionDays: before.diagnosticRetentionDays, auditRetentionDays: before.auditRetentionDays },
          after: { name: after!.name, eventRetentionDays: after!.eventRetentionDays, diagnosticRetentionDays: after!.diagnosticRetentionDays, auditRetentionDays: after!.auditRetentionDays },
        },
      },
      tx,
    );
    return after!;
  });
}

/**
 * Kill switch. While paused: the scheduler enqueues no syncs, scans, alert
 * evaluations or health snapshots for the organisation; already-queued
 * scheduled syncs/scans are skipped when they run; alerts raised by manual
 * activity never request campaign actions. Manual actions by users (a manual
 * scan or sync) still run.
 */
export async function setAutomationPaused(orgId: string, paused: boolean, reason: string, actor: AuditActor, requestId?: string) {
  return db.transaction(async (tx) => {
    const [org] = await tx.update(organizations).set({ automationPaused: paused, updatedAt: new Date() }).where(eq(organizations.id, orgId)).returning();
    if (!org) throw notFound("Organization");
    await recordAudit(
      { orgId, actor, action: paused ? "organization.automation.pause" : "organization.automation.resume", targetType: "organization", targetId: orgId, reason, outcome: "success", requestId },
      tx,
    );
    return org;
  });
}
