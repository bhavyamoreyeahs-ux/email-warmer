/**
 * Integrations: campaign-control webhooks, notification webhooks, and the
 * QuikCRM / QuikPilot placeholders (not available in this MVP — never shown as
 * connected).
 *
 * The signing secret is generated server-side, shown exactly once, stored
 * encrypted and never returned again.
 */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { integrations, type IntegrationKind } from "@/lib/db/schema";
import { activeKeyId, decryptSecret, encryptSecret } from "@/lib/crypto/encryption";
import { randomToken } from "@/lib/crypto/hash";
import { badRequest, notFound } from "@/lib/api/errors";
import { recordAudit, type AuditActor } from "@/lib/audit";
import { assertSafeWebhookUrl, postSignedWebhook } from "@/lib/integrations/webhook";

export const integrationInput = z.object({
  kind: z.enum(["campaign_webhook", "notification_webhook"]),
  name: z.string().trim().min(2).max(80),
  endpointUrl: z.string().trim().url().max(2000),
});

const publicCols = {
  id: integrations.id,
  kind: integrations.kind,
  name: integrations.name,
  status: integrations.status,
  config: integrations.config,
  lastTestedAt: integrations.lastTestedAt,
  lastTestOutcome: integrations.lastTestOutcome,
  createdAt: integrations.createdAt,
  revokedAt: integrations.revokedAt,
};

export const ROADMAP_INTEGRATIONS: Array<{ kind: IntegrationKind; name: string; description: string }> = [
  { kind: "quikcrm", name: "QuikCRM", description: "Planned: link deliverability health to accounts and contacts. Not available in this release." },
  { kind: "quikpilot", name: "QuikPilot", description: "Planned: native campaign pause/resume through QuikPilot. Not available in this release." },
];

export async function listIntegrations(orgId: string) {
  return db.select(publicCols).from(integrations).where(eq(integrations.orgId, orgId)).orderBy(desc(integrations.createdAt));
}

export async function getIntegrationSecret(orgId: string, integrationId: string) {
  const [row] = await db.select().from(integrations).where(and(eq(integrations.id, integrationId), eq(integrations.orgId, orgId))).limit(1);
  if (!row) throw notFound("Integration");
  return { row, secret: row.encryptedSecret ? decryptSecret(row.encryptedSecret) : null };
}

export async function createIntegration(orgId: string, input: z.infer<typeof integrationInput>, actor: AuditActor, requestId?: string) {
  try {
    await assertSafeWebhookUrl(input.endpointUrl);
  } catch (error: unknown) {
    throw badRequest(error instanceof Error ? error.message : "Invalid webhook URL.");
  }
  const secret = `qrwh_${randomToken(32)}`;
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(integrations)
      .values({
        orgId,
        kind: input.kind,
        name: input.name,
        status: "pending_setup",
        config: { endpointUrl: input.endpointUrl },
        encryptedSecret: encryptSecret(secret),
        keyId: activeKeyId(),
        createdByUserId: actor.userId ?? null,
      })
      .returning(publicCols);
    await recordAudit({ orgId, actor, action: "integration.create", targetType: "integration", targetId: created!.id, outcome: "success", requestId, metadata: { kind: input.kind, name: input.name, endpointHost: new URL(input.endpointUrl).host } }, tx);
    return created!;
  });
  return { integration: row, signingSecret: secret };
}

/** Sends a signed `ping`. A campaign integration becomes `active` only after a successful test. */
export async function testIntegration(orgId: string, integrationId: string, actor: AuditActor, requestId?: string, fetchImpl?: typeof fetch) {
  const { row, secret } = await getIntegrationSecret(orgId, integrationId);
  if (row.status === "revoked") throw badRequest("This integration was revoked.");
  if (!secret) throw badRequest("Integration has no signing secret.");
  const result = await postSignedWebhook({
    url: String(row.config.endpointUrl ?? ""),
    secret,
    idempotencyKey: `test:${integrationId}:${Date.now()}`,
    body: { type: "ping", integrationId, sentAt: new Date().toISOString() },
    fetchImpl,
  });
  const success = result.ok && (row.kind !== "campaign_webhook" || result.json?.ok === true);
  const outcome = success ? `Success (HTTP ${result.status}, ${result.durationMs} ms)` : `Failed: ${result.error ?? (result.json?.ok !== true ? "endpoint did not reply {\"ok\": true}" : "unknown")}`;
  await db
    .update(integrations)
    .set({ lastTestedAt: new Date(), lastTestOutcome: outcome, status: success ? "active" : row.status === "active" ? "error" : row.status, updatedAt: new Date() })
    .where(eq(integrations.id, integrationId));
  await recordAudit({ orgId, actor, action: "integration.test", targetType: "integration", targetId: integrationId, outcome: success ? "success" : "failure", reason: outcome, requestId });
  return { success, outcome };
}

export async function setIntegrationStatus(orgId: string, integrationId: string, status: "disabled" | "revoked", reason: string, actor: AuditActor, requestId?: string) {
  const [row] = await db
    .update(integrations)
    .set({ status, revokedAt: status === "revoked" ? new Date() : null, ...(status === "revoked" ? { encryptedSecret: null } : {}), updatedAt: new Date() })
    .where(and(eq(integrations.id, integrationId), eq(integrations.orgId, orgId)))
    .returning(publicCols);
  if (!row) throw notFound("Integration");
  await recordAudit({ orgId, actor, action: status === "revoked" ? "integration.revoke" : "integration.disable", targetType: "integration", targetId: integrationId, reason, outcome: "success", requestId });
  return row;
}
