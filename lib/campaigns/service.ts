/**
 * Campaign safety: campaign references, pause/resume requests and their
 * execution through a customer-authorised campaign-control integration.
 *
 * TRUTHFULNESS RULES
 *  - QuikReach does not send campaigns and has no built-in pause capability.
 *  - A pause/resume is only marked `confirmed` when the execution system's
 *    response explicitly confirms the new state for that campaign. Anything
 *    else is `unconfirmed` or `failed` and is shown as such.
 *  - Without an active campaign integration every action is unavailable, and
 *    the UI says "QuikReach can alert but cannot pause the campaign".
 *  - A campaign paused because of a CRITICAL alert whose rule requires manual
 *    review can only be resumed by someone with `campaign:review`.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { alertRules, alerts, campaignActions, campaignReferences, domains, integrations, mailboxConnections } from "@/lib/db/schema";
import { badRequest, conflict, forbidden, notFound } from "@/lib/api/errors";
import { recordAudit, automationActor, type AuditActor } from "@/lib/audit";
import { enqueueJob, JobError } from "@/lib/jobs/queue";
import { getIntegrationSecret } from "@/lib/integrations/service";
import { postSignedWebhook } from "@/lib/integrations/webhook";
import { can } from "@/lib/rbac";
import type { Principal } from "@/lib/api/principal";

export const campaignInput = z.object({
  integrationId: z.string().uuid(),
  externalId: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  mailboxConnectionId: z.string().uuid().nullable().optional(),
  domainId: z.string().uuid().nullable().optional(),
});

export async function listCampaigns(orgId: string) {
  return db
    .select({
      id: campaignReferences.id,
      externalId: campaignReferences.externalId,
      name: campaignReferences.name,
      status: campaignReferences.status,
      statusConfirmedAt: campaignReferences.statusConfirmedAt,
      pausedByQuikreach: campaignReferences.pausedByQuikreach,
      requiresReview: campaignReferences.requiresReview,
      integrationId: campaignReferences.integrationId,
      integrationName: integrations.name,
      integrationStatus: integrations.status,
      mailboxConnectionId: campaignReferences.mailboxConnectionId,
      domainId: campaignReferences.domainId,
    })
    .from(campaignReferences)
    .innerJoin(integrations, eq(integrations.id, campaignReferences.integrationId))
    .where(eq(campaignReferences.orgId, orgId))
    .orderBy(campaignReferences.name);
}

export async function listCampaignActions(orgId: string, limit = 50) {
  return db
    .select({
      id: campaignActions.id,
      action: campaignActions.action,
      status: campaignActions.status,
      reason: campaignActions.reason,
      requestedByType: campaignActions.requestedByType,
      error: campaignActions.error,
      createdAt: campaignActions.createdAt,
      completedAt: campaignActions.completedAt,
      campaignName: campaignReferences.name,
    })
    .from(campaignActions)
    .innerJoin(campaignReferences, eq(campaignReferences.id, campaignActions.campaignId))
    .where(eq(campaignActions.orgId, orgId))
    .orderBy(desc(campaignActions.createdAt))
    .limit(limit);
}

export async function createCampaignReference(orgId: string, input: z.infer<typeof campaignInput>, actor: AuditActor, requestId?: string) {
  const [integration] = await db
    .select({ id: integrations.id, kind: integrations.kind })
    .from(integrations)
    .where(and(eq(integrations.id, input.integrationId), eq(integrations.orgId, orgId)))
    .limit(1);
  if (!integration || integration.kind !== "campaign_webhook") throw badRequest("Choose a campaign-control integration from this organization.");
  if (input.mailboxConnectionId) {
    const [m] = await db.select({ id: mailboxConnections.id }).from(mailboxConnections).where(and(eq(mailboxConnections.id, input.mailboxConnectionId), eq(mailboxConnections.orgId, orgId))).limit(1);
    if (!m) throw badRequest("Mailbox not found in this organization.");
  }
  if (input.domainId) {
    const [d] = await db.select({ id: domains.id }).from(domains).where(and(eq(domains.id, input.domainId), eq(domains.orgId, orgId))).limit(1);
    if (!d) throw badRequest("Domain not found in this organization.");
  }
  const [dupe] = await db
    .select({ id: campaignReferences.id })
    .from(campaignReferences)
    .where(and(eq(campaignReferences.orgId, orgId), eq(campaignReferences.integrationId, input.integrationId), eq(campaignReferences.externalId, input.externalId)))
    .limit(1);
  if (dupe) throw conflict("This campaign is already linked through that integration.");
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(campaignReferences)
      .values({ orgId, integrationId: input.integrationId, externalId: input.externalId, name: input.name, mailboxConnectionId: input.mailboxConnectionId ?? null, domainId: input.domainId ?? null })
      .returning();
    await recordAudit({ orgId, actor, action: "campaign.link", targetType: "campaign", targetId: row!.id, outcome: "success", requestId, metadata: { externalId: input.externalId, name: input.name } }, tx);
    return row!;
  });
}

export async function requestCampaignAction(principal: Principal, campaignId: string, action: "pause" | "resume", reason: string, requestId?: string) {
  const [campaign] = await db
    .select({ ref: campaignReferences, integrationStatus: integrations.status })
    .from(campaignReferences)
    .innerJoin(integrations, eq(integrations.id, campaignReferences.integrationId))
    .where(and(eq(campaignReferences.id, campaignId), eq(campaignReferences.orgId, principal.orgId)))
    .limit(1);
  if (!campaign) throw notFound("Campaign");
  if (campaign.integrationStatus !== "active") {
    throw badRequest("The campaign integration is not active (it must pass a test first). QuikReach cannot pause or resume this campaign until it is.");
  }
  if (action === "pause" && !can(principal.role, "campaign:pause")) throw forbidden();
  if (action === "resume") {
    if (!can(principal.role, "campaign:resume") && !can(principal.role, "campaign:review")) throw forbidden();
    if (campaign.ref.requiresReview && !can(principal.role, "campaign:review")) {
      throw forbidden("This campaign was paused by a critical alert and needs a Deliverability Manager, Administrator or Owner to review it before resuming.");
    }
  }
  const actor: AuditActor = { type: "user", userId: principal.userId, label: principal.email };
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(campaignActions)
      .values({ orgId: principal.orgId, campaignId, action, requestedByType: "user", requestedByUserId: principal.userId, reason, idempotencyKey: `user:${crypto.randomUUID()}:${action}:${campaignId}` })
      .returning();
    await enqueueJob({ type: "campaign.action", orgId: principal.orgId, payload: { actionId: row!.id }, idempotencyKey: `campaign-action:${row!.id}`, priority: 10, maxAttempts: 3 }, tx);
    await recordAudit(
      { orgId: principal.orgId, actor, action: `campaign.${action}.request`, targetType: "campaign", targetId: campaignId, reason, outcome: "pending", requestId, metadata: { actionId: row!.id, reviewedResume: action === "resume" && campaign.ref.requiresReview } },
      tx,
    );
    return row!;
  });
}

/** Called when the job has exhausted its retries: the action is failed, never left "queued". */
export async function markCampaignActionFailed(orgId: string, actionId: string, error: string) {
  const [row] = await db
    .update(campaignActions)
    .set({ status: "failed", error: error.slice(0, 500), completedAt: new Date() })
    .where(and(eq(campaignActions.id, actionId), eq(campaignActions.orgId, orgId), inArray(campaignActions.status, ["queued", "sent"])))
    .returning();
  if (!row) return;
  if (row.alertId && row.action === "pause") {
    await db.update(alerts).set({ actionOutcome: "pause_failed" }).where(and(eq(alerts.id, row.alertId), eq(alerts.orgId, orgId)));
  }
  await recordAudit({ orgId, actor: automationActor("campaign-safety"), action: `campaign.${row.action}`, targetType: "campaign", targetId: row.campaignId, outcome: "failure", reason: `Gave up after retries: ${error.slice(0, 200)}`, metadata: { actionId } });
}

/** Worker: execute one action through the integration and record the CONFIRMED outcome. */
export async function executeCampaignAction(orgId: string, actionId: string, fetchImpl?: typeof fetch) {
  const [row] = await db
    .select({ action: campaignActions, campaign: campaignReferences })
    .from(campaignActions)
    .innerJoin(campaignReferences, eq(campaignReferences.id, campaignActions.campaignId))
    .where(and(eq(campaignActions.id, actionId), eq(campaignActions.orgId, orgId)))
    .limit(1);
  if (!row) return { skipped: "action not found" };
  if (["confirmed", "failed", "unconfirmed"].includes(row.action.status)) return { skipped: `already ${row.action.status}` };

  const { row: integration, secret } = await getIntegrationSecret(orgId, row.campaign.integrationId);
  const actor = row.action.requestedByType === "automation" ? automationActor("campaign-safety") : { type: "user" as const, userId: row.action.requestedByUserId, label: "user" };
  const desired = row.action.action === "pause" ? "paused" : "active";

  const finish = async (status: "confirmed" | "failed" | "unconfirmed", error: string | null, response: Record<string, unknown> | null) => {
    await db.transaction(async (tx) => {
      await tx.update(campaignActions).set({ status, error, externalResponse: response, completedAt: new Date() }).where(eq(campaignActions.id, actionId));
      if (status === "confirmed") {
        let requiresReview = false;
        if (row.action.action === "pause" && row.action.alertId) {
          const [a] = await tx
            .select({ severity: alerts.severity, requireManualResume: alertRules.requireManualResume })
            .from(alerts)
            .leftJoin(alertRules, eq(alertRules.id, alerts.ruleId))
            .where(and(eq(alerts.id, row.action.alertId), eq(alerts.orgId, orgId)))
            .limit(1);
          requiresReview = a?.severity === "critical" && a.requireManualResume !== false;
        }
        await tx
          .update(campaignReferences)
          .set({
            status: desired,
            statusConfirmedAt: new Date(),
            pausedByQuikreach: row.action.action === "pause",
            requiresReview: row.action.action === "pause" ? requiresReview : false,
            updatedAt: new Date(),
          })
          .where(eq(campaignReferences.id, row.campaign.id));
      }
      if (row.action.alertId && row.action.action === "pause") {
        await tx
          .update(alerts)
          .set({ actionOutcome: status === "confirmed" ? "pause_confirmed" : status === "failed" ? "pause_failed" : "pause_requested" })
          .where(and(eq(alerts.id, row.action.alertId), eq(alerts.orgId, orgId)));
      }
      await recordAudit(
        {
          orgId,
          actor,
          action: `campaign.${row.action.action}`,
          targetType: "campaign",
          targetId: row.campaign.id,
          reason: row.action.reason,
          outcome: status === "confirmed" ? "success" : status === "failed" ? "failure" : "pending",
          metadata: { actionId, externalId: row.campaign.externalId, status, error },
        },
        tx,
      );
    });
  };

  if (integration.status !== "active" || !secret) {
    await finish("failed", "Campaign integration is not active.", null);
    return { status: "failed" };
  }
  await db.update(campaignActions).set({ status: "sent" }).where(eq(campaignActions.id, actionId));
  const result = await postSignedWebhook({
    url: String(integration.config.endpointUrl ?? ""),
    secret,
    idempotencyKey: row.action.idempotencyKey,
    body: { type: `campaign.${row.action.action}`, actionId, campaign: { externalId: row.campaign.externalId, name: row.campaign.name }, reason: row.action.reason, requestedBy: row.action.requestedByType },
    fetchImpl,
  });

  if (!result.ok && (result.status === null || result.status >= 500)) {
    // Transient — let the queue retry (bounded). Receivers de-duplicate on Idempotency-Key.
    await db.update(campaignActions).set({ status: "queued", error: result.error }).where(eq(campaignActions.id, actionId));
    throw new JobError(`Campaign integration unreachable: ${result.error}`, { retryable: true });
  }
  const camp = (result.json?.campaign ?? null) as { externalId?: unknown; status?: unknown } | null;
  const sanitized = { httpStatus: result.status, ok: result.json?.ok ?? null, campaign: camp ? { externalId: camp.externalId, status: camp.status } : null };
  if (!result.ok) {
    await finish("failed", result.error ?? "Rejected by integration", sanitized);
    return { status: "failed" };
  }
  if (result.json?.ok === true && camp?.externalId === row.campaign.externalId && camp?.status === desired) {
    await finish("confirmed", null, sanitized);
    return { status: "confirmed" };
  }
  await finish("unconfirmed", "The integration responded but did not confirm the new campaign state.", sanitized);
  return { status: "unconfirmed" };
}
