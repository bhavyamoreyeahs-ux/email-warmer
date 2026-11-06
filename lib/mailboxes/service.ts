/**
 * Mailbox connections: listing, detail, disconnect, pause/resume monitoring,
 * manual sync requests. Tokens are never selected here.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { mailboxConnections, providerCapabilities, providerEvents, providerSyncs, domains } from "@/lib/db/schema";
import { notFound, badRequest, rateLimited } from "@/lib/api/errors";
import { recordAudit, type AuditActor } from "@/lib/audit";
import { enqueueJob } from "@/lib/jobs/queue";
import { deleteTokens, loadTokens } from "@/lib/mailboxes/tokens";
import { getAdapter } from "@/lib/mailboxes/providers/registry";
import { checkRateLimit } from "@/lib/ratelimit";
import { logger } from "@/lib/observability/logger";
import { countEventsByCategory } from "@/lib/events/ingest";

/** Public columns only — never credentials. */
const publicColumns = {
  id: mailboxConnections.id,
  orgId: mailboxConnections.orgId,
  domainId: mailboxConnections.domainId,
  provider: mailboxConnections.provider,
  emailAddress: mailboxConnections.emailAddress,
  displayName: mailboxConnections.displayName,
  state: mailboxConnections.state,
  stateReason: mailboxConnections.stateReason,
  grantedScopes: mailboxConnections.grantedScopes,
  lastSuccessfulSyncAt: mailboxConnections.lastSuccessfulSyncAt,
  lastSyncAttemptAt: mailboxConnections.lastSyncAttemptAt,
  lastErrorCode: mailboxConnections.lastErrorCode,
  lastErrorMessage: mailboxConnections.lastErrorMessage,
  consecutiveFailures: mailboxConnections.consecutiveFailures,
  nextSyncAt: mailboxConnections.nextSyncAt,
  isDemo: mailboxConnections.isDemo,
  disconnectedAt: mailboxConnections.disconnectedAt,
  createdAt: mailboxConnections.createdAt,
};

export type MailboxSummary = Awaited<ReturnType<typeof listMailboxes>>[number];

export async function listMailboxes(orgId: string) {
  const rows = await db
    .select({ ...publicColumns, domainName: domains.name })
    .from(mailboxConnections)
    .leftJoin(domains, eq(domains.id, mailboxConnections.domainId))
    .where(eq(mailboxConnections.orgId, orgId))
    .orderBy(mailboxConnections.emailAddress);
  return rows;
}

export async function getMailbox(orgId: string, connectionId: string) {
  const [row] = await db
    .select({ ...publicColumns, domainName: domains.name })
    .from(mailboxConnections)
    .leftJoin(domains, eq(domains.id, mailboxConnections.domainId))
    .where(and(eq(mailboxConnections.id, connectionId), eq(mailboxConnections.orgId, orgId)))
    .limit(1);
  if (!row) throw notFound("Mailbox connection");
  return row;
}

export async function getMailboxDetail(orgId: string, connectionId: string) {
  const mailbox = await getMailbox(orgId, connectionId);
  const [capabilities, syncs, events] = await Promise.all([
    db.select().from(providerCapabilities).where(and(eq(providerCapabilities.orgId, orgId), eq(providerCapabilities.connectionId, connectionId))).orderBy(providerCapabilities.capability),
    db.select().from(providerSyncs).where(and(eq(providerSyncs.orgId, orgId), eq(providerSyncs.connectionId, connectionId))).orderBy(desc(providerSyncs.startedAt)).limit(15),
    db
      .select()
      .from(providerEvents)
      .where(and(eq(providerEvents.orgId, orgId), eq(providerEvents.connectionId, connectionId), sql`${providerEvents.category} <> 'sent'`))
      .orderBy(desc(providerEvents.occurredAt))
      .limit(50),
  ]);
  const now = new Date();
  const since7 = new Date(now.getTime() - 7 * 86_400_000);
  const counts7d = await countEventsByCategory(orgId, since7, now, [connectionId]);
  return { mailbox, capabilities, syncs, events, counts7d };
}

export async function requestSync(orgId: string, connectionId: string, actor: AuditActor, requestId?: string) {
  const mailbox = await getMailbox(orgId, connectionId);
  if (!["connected", "degraded", "pending"].includes(mailbox.state)) {
    throw badRequest(
      mailbox.state === "reauth_required"
        ? "This mailbox needs to be reconnected before it can sync."
        : mailbox.state === "demo"
          ? "Demo mailboxes contain seeded sample data and never sync."
          : `A ${mailbox.state} mailbox cannot sync.`,
    );
  }
  const rl = await checkRateLimit(`manual-sync:${connectionId}`, 4, 300);
  if (!rl.allowed) throw rateLimited(rl.retryAfterSeconds);
  const res = await enqueueJob({ type: "mailbox.sync", orgId, payload: { connectionId, trigger: "manual" }, idempotencyKey: `sync:${connectionId}`, priority: 50 });
  await recordAudit({ orgId, actor, action: "mailbox.sync.request", targetType: "mailbox", targetId: connectionId, outcome: "pending", requestId, metadata: { deduplicated: res.deduplicated } });
  return res;
}

export async function setMonitoringPaused(orgId: string, connectionId: string, paused: boolean, reason: string, actor: AuditActor, requestId?: string) {
  const mailbox = await getMailbox(orgId, connectionId);
  if (mailbox.state === "disconnected" || mailbox.state === "demo") throw badRequest(`A ${mailbox.state} mailbox cannot be ${paused ? "paused" : "resumed"}.`);
  if (paused && mailbox.state === "paused") return mailbox;
  if (!paused && mailbox.state !== "paused") return mailbox;
  await db.transaction(async (tx) => {
    await tx
      .update(mailboxConnections)
      .set(
        paused
          ? { state: "paused", stateReason: `Monitoring paused: ${reason}`, nextSyncAt: null, updatedAt: new Date() }
          : { state: "connected", stateReason: "Monitoring resumed; next sync queued.", nextSyncAt: new Date(), updatedAt: new Date() },
      )
      .where(and(eq(mailboxConnections.id, connectionId), eq(mailboxConnections.orgId, orgId)));
    await recordAudit({ orgId, actor, action: paused ? "mailbox.pause" : "mailbox.resume", targetType: "mailbox", targetId: connectionId, reason, outcome: "success", requestId }, tx);
  });
  return getMailbox(orgId, connectionId);
}

/**
 * Disconnect: best-effort provider revocation, then local token deletion
 * (always), then state → disconnected. Events are kept until retention unless
 * `deleteEvents` is set.
 */
export async function disconnectMailbox(orgId: string, connectionId: string, opts: { reason: string; deleteEvents: boolean }, actor: AuditActor, requestId?: string) {
  const mailbox = await getMailbox(orgId, connectionId);
  if (mailbox.state === "demo") throw badRequest("Demo mailboxes cannot be disconnected; they are part of the sample workspace.");
  let revocation = { revoked: false, detail: "No stored credentials." };
  if (mailbox.provider === "google" || mailbox.provider === "microsoft") {
    try {
      const tokens = await loadTokens(orgId, connectionId);
      if (tokens) revocation = await getAdapter(mailbox.provider).revoke(tokens);
    } catch (error: unknown) {
      revocation = { revoked: false, detail: "Provider revocation failed; stored tokens were still deleted." };
      logger.warn("mailbox_revoke_failed", { connectionId, error });
    }
  }
  let deletedEvents = 0;
  await db.transaction(async (tx) => {
    await deleteTokens(orgId, connectionId, tx);
    await tx
      .update(mailboxConnections)
      .set({ state: "disconnected", stateReason: `Disconnected: ${opts.reason}`, nextSyncAt: null, syncCursor: null, disconnectedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(mailboxConnections.id, connectionId), eq(mailboxConnections.orgId, orgId)));
    if (opts.deleteEvents) {
      const deleted = await tx
        .delete(providerEvents)
        .where(and(eq(providerEvents.orgId, orgId), eq(providerEvents.connectionId, connectionId)))
        .returning({ id: providerEvents.id });
      deletedEvents = deleted.length;
    }
    await recordAudit(
      {
        orgId,
        actor,
        action: "mailbox.disconnect",
        targetType: "mailbox",
        targetId: connectionId,
        reason: opts.reason,
        outcome: "success",
        requestId,
        metadata: { email: mailbox.emailAddress, providerRevoked: revocation.revoked, revocationDetail: revocation.detail, deletedEvents },
      },
      tx,
    );
  });
  return { revocation, deletedEvents };
}

/** Mailbox ids → address, for display. */
export async function mailboxLabels(orgId: string, ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = await db
    .select({ id: mailboxConnections.id, email: mailboxConnections.emailAddress })
    .from(mailboxConnections)
    .where(and(eq(mailboxConnections.orgId, orgId), inArray(mailboxConnections.id, ids)));
  return new Map(rows.map((r) => [r.id, r.email]));
}

export async function recentSyncFailures(orgId: string, since: Date) {
  return db
    .select()
    .from(providerSyncs)
    .where(and(eq(providerSyncs.orgId, orgId), eq(providerSyncs.status, "failed"), gte(providerSyncs.startedAt, since)))
    .orderBy(desc(providerSyncs.startedAt))
    .limit(20);
}
