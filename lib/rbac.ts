/**
 * QuikReach roles and permissions — the single source of truth.
 *
 * Pure data + pure functions (no database import) so routes, server components,
 * the UI and tests share one definition. docs/permissions.md is generated from
 * this matrix; __tests__/unit/rbac.test.ts pins the key rules.
 *
 * Hiding a button is a courtesy, not a control: every protected API route
 * declares its permission in `withOrgAuth({ permission })`, checked server-side
 * after the membership is loaded fresh from the database
 * (lib/api/with-org-auth.ts); role-specific rules inside handlers use `can()`.
 */
import type { Role } from "@/lib/db/schema";

export const PERMISSIONS = [
  "organization:view",
  "organization:update",
  "organization:delete",
  "member:view",
  "member:invite",
  "member:update",
  "member:disable",
  "domain:view",
  "domain:create",
  "domain:update",
  "domain:delete",
  "domain:scan",
  "mailbox:view",
  "mailbox:connect",
  "mailbox:disconnect",
  "mailbox:sync",
  "mailbox:pause",
  "event:view",
  "event:export",
  "alert_rule:view",
  "alert_rule:manage",
  "alert_rule:test",
  "alert:view",
  "alert:acknowledge",
  "alert:resolve",
  "campaign:view",
  "campaign:manage",
  "campaign:pause",
  "campaign:resume",
  "campaign:review",
  "integration:view",
  "integration:manage",
  "report:view",
  "report:export",
  "usage:view",
  "audit:view",
  "diagnostic:view",
  "diagnostic:run",
  "job:view",
  "job:retry",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEW_ALL: Permission[] = [
  "organization:view",
  "member:view",
  "domain:view",
  "mailbox:view",
  "event:view",
  "alert_rule:view",
  "alert:view",
  "campaign:view",
  "integration:view",
  "report:view",
  "usage:view",
  "diagnostic:view",
];

const ALL = new Set<Permission>(PERMISSIONS);

const ADMIN = new Set<Permission>(PERMISSIONS.filter((p) => p !== "organization:delete"));

const DELIVERABILITY_MANAGER = new Set<Permission>([
  ...VIEW_ALL,
  "domain:create",
  "domain:update",
  "domain:delete",
  "domain:scan",
  "mailbox:connect",
  "mailbox:disconnect",
  "mailbox:sync",
  "mailbox:pause",
  "event:export",
  "alert_rule:manage",
  "alert_rule:test",
  "alert:acknowledge",
  "alert:resolve",
  "campaign:pause",
  "campaign:review",
  "report:export",
  "diagnostic:run",
  "job:view",
]);

/**
 * Campaign managers run campaigns: they can pause/resume linked campaigns and
 * acknowledge alerts, but they cannot change detection rules or approve the
 * resumption of a campaign that a SERIOUS alert paused (`campaign:review`) —
 * that separation of duties is deliberate.
 */
const CAMPAIGN_MANAGER = new Set<Permission>([
  ...VIEW_ALL,
  "mailbox:connect",
  "event:export",
  "alert_rule:test",
  "alert:acknowledge",
  "campaign:manage",
  "campaign:pause",
  "campaign:resume",
  "report:export",
  "diagnostic:run",
]);

/** Read-only. Exports are allowed: an analyst's job is analysis; exports are audited. */
const ANALYST = new Set<Permission>([...VIEW_ALL, "event:export", "report:export"]);

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: ALL,
  admin: ADMIN,
  deliverability_manager: DELIVERABILITY_MANAGER,
  campaign_manager: CAMPAIGN_MANAGER,
  analyst: ANALYST,
};

export const ROLE_LABELS: Record<Role, { name: string; description: string }> = {
  owner: { name: "Owner", description: "Full control, including deleting the organization and managing other owners." },
  admin: { name: "Administrator", description: "Manages members, settings, integrations and every deliverability feature." },
  deliverability_manager: {
    name: "Deliverability Manager",
    description: "Manages domains, mailboxes, alert rules and diagnostics; approves campaign resumption after serious alerts.",
  },
  campaign_manager: {
    name: "Campaign Manager",
    description: "Monitors health, acknowledges alerts and pauses/resumes linked campaigns (not after serious alerts).",
  },
  analyst: { name: "Read-only Analyst", description: "Views dashboards, domains, mailboxes, events and reports; can export CSV. Cannot change anything." },
};

export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

export function permissionsFor(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]].sort();
}

/**
 * Who may assign which role. Only owners create or demote owners; admins manage
 * everyone below owner. Nobody else manages roles.
 */
export function canAssignRole(actor: Role, target: Role): boolean {
  if (actor === "owner") return true;
  if (actor === "admin") return target !== "owner";
  return false;
}
