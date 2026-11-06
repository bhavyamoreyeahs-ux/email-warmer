/**
 * Alert-rule management (create, edit, enable/disable, delete, dry-run test).
 * Every change is versioned and audited.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { alertRules, domains, integrations, mailboxConnections } from "@/lib/db/schema";
import { badRequest, notFound } from "@/lib/api/errors";
import { recordAudit, type AuditActor } from "@/lib/audit";
import { evaluateRule } from "@/lib/alerts/evaluate";
import type { AlertRuleInput } from "@/lib/alerts/schemas";

export async function listRules(orgId: string) {
  return db.select().from(alertRules).where(eq(alertRules.orgId, orgId)).orderBy(desc(alertRules.enabled), alertRules.name);
}

export async function getRule(orgId: string, ruleId: string) {
  const [r] = await db.select().from(alertRules).where(and(eq(alertRules.id, ruleId), eq(alertRules.orgId, orgId))).limit(1);
  if (!r) throw notFound("Alert rule");
  return r;
}

/** Scope ids and webhook targets must belong to the same organisation. */
async function validateReferences(orgId: string, input: AlertRuleInput) {
  if (input.scopeType === "domain" && input.scopeId) {
    const [d] = await db.select({ id: domains.id }).from(domains).where(and(eq(domains.id, input.scopeId), eq(domains.orgId, orgId))).limit(1);
    if (!d) throw badRequest("The selected domain does not exist in this organization.");
  }
  if (input.scopeType === "mailbox" && input.scopeId) {
    const [m] = await db.select({ id: mailboxConnections.id }).from(mailboxConnections).where(and(eq(mailboxConnections.id, input.scopeId), eq(mailboxConnections.orgId, orgId))).limit(1);
    if (!m) throw badRequest("The selected mailbox does not exist in this organization.");
  }
  if (input.notificationTargets.webhookIntegrationId) {
    const [i] = await db
      .select({ id: integrations.id })
      .from(integrations)
      .where(and(eq(integrations.id, input.notificationTargets.webhookIntegrationId), eq(integrations.orgId, orgId), eq(integrations.kind, "notification_webhook")))
      .limit(1);
    if (!i) throw badRequest("The selected notification webhook does not exist in this organization.");
  }
}

function toRow(input: AlertRuleInput) {
  return {
    ...input,
    scopeId: input.scopeType === "organization" ? null : (input.scopeId ?? null),
    notificationTargets: { inApp: input.notificationTargets.inApp, emails: input.notificationTargets.emails, webhookIntegrationId: input.notificationTargets.webhookIntegrationId ?? null },
  };
}

export async function createRule(orgId: string, input: AlertRuleInput, actor: AuditActor, requestId?: string) {
  await validateReferences(orgId, input);
  return db.transaction(async (tx) => {
    const [rule] = await tx.insert(alertRules).values({ ...toRow(input), orgId, createdByUserId: actor.userId ?? null, updatedByUserId: actor.userId ?? null }).returning();
    await recordAudit({ orgId, actor, action: "alert_rule.create", targetType: "alert_rule", targetId: rule!.id, outcome: "success", requestId, metadata: { rule: toRow(input) } }, tx);
    return rule!;
  });
}

export async function updateRule(orgId: string, ruleId: string, input: AlertRuleInput, actor: AuditActor, requestId?: string) {
  const before = await getRule(orgId, ruleId);
  await validateReferences(orgId, input);
  return db.transaction(async (tx) => {
    const [rule] = await tx
      .update(alertRules)
      .set({ ...toRow(input), version: before.version + 1, updatedByUserId: actor.userId ?? null, updatedAt: new Date() })
      .where(and(eq(alertRules.id, ruleId), eq(alertRules.orgId, orgId)))
      .returning();
    await recordAudit(
      {
        orgId,
        actor,
        action: before.enabled !== input.enabled ? (input.enabled ? "alert_rule.enable" : "alert_rule.disable") : "alert_rule.update",
        targetType: "alert_rule",
        targetId: ruleId,
        outcome: "success",
        requestId,
        metadata: { fromVersion: before.version, toVersion: rule!.version, before: { threshold: before.threshold, windowMinutes: before.windowMinutes, minSample: before.minSample, severity: before.severity, actionPolicy: before.actionPolicy, enabled: before.enabled }, after: toRow(input) },
      },
      tx,
    );
    return rule!;
  });
}

export async function deleteRule(orgId: string, ruleId: string, actor: AuditActor, requestId?: string) {
  const before = await getRule(orgId, ruleId);
  await db.transaction(async (tx) => {
    await tx.delete(alertRules).where(and(eq(alertRules.id, ruleId), eq(alertRules.orgId, orgId)));
    await recordAudit({ orgId, actor, action: "alert_rule.delete", targetType: "alert_rule", targetId: ruleId, outcome: "success", requestId, metadata: { name: before.name, metric: before.metric } }, tx);
  });
}

/**
 * Dry run: evaluates a (possibly unsaved) rule against current data. No alert,
 * notification or campaign action is created. Reports what WOULD happen,
 * including whether a pause is even possible.
 */
export async function testRule(orgId: string, input: AlertRuleInput, actor: AuditActor, requestId?: string) {
  await validateReferences(orgId, input);
  const results = await evaluateRule({ ...toRow(input), orgId });
  const campaignIntegrations = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(and(eq(integrations.orgId, orgId), eq(integrations.kind, "campaign_webhook"), eq(integrations.status, "active")));
  const triggered = results.filter((r) => r.status === "triggered");
  const action =
    input.actionPolicy === "notify_only"
      ? "Monitor-only: would notify; no campaign action."
      : campaignIntegrations.length
        ? `Would request a pause for campaigns linked to ${triggered.length} target(s). A pause counts only when the sending system confirms it.`
        : "Would NOT pause anything: no campaign integration is configured. QuikReach can alert but cannot pause campaigns.";
  const notify = [
    input.notificationTargets.inApp ? "in-app" : null,
    ...input.notificationTargets.emails.map((e) => `email ${e}`),
    input.notificationTargets.webhookIntegrationId ? "webhook" : null,
  ].filter(Boolean);
  await recordAudit({ orgId, actor, action: "alert_rule.test", targetType: "alert_rule", targetId: null, outcome: "success", requestId, metadata: { metric: input.metric, triggered: triggered.length } });
  return { dryRun: true as const, results, wouldTrigger: triggered.length, action, wouldNotify: triggered.length ? notify : [] };
}
