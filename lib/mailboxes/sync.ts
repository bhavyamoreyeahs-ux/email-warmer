/**
 * Worker-side mailbox operations: capability validation and incremental sync.
 *
 * Failure handling (no infinite retries)
 *  - auth_revoked / insufficient_scope / admin_consent_required → state
 *    `reauth_required`, user notified, job dead-lettered as non-retryable,
 *    scheduler stops syncing this mailbox until it is reconnected.
 *  - rate_limited / quota_exceeded / provider_unavailable / network_error →
 *    consecutive_failures++, exponential next_sync_at (capped at 6h), state
 *    `degraded` after 3 consecutive failures; the job itself retries within its
 *    bounded attempts.
 *  - history_expired → cursor reset and one bounded resync window.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { mailboxConnections, notifications, organizations, providerCapabilities, providerSyncs } from "@/lib/db/schema";
import { getAdapter } from "@/lib/mailboxes/providers/registry";
import { ProviderError, type CapabilityResult } from "@/lib/mailboxes/providers/types";
import { getValidAccessToken, REAUTH_CODES } from "@/lib/mailboxes/tokens";
import { ingestSignals } from "@/lib/events/ingest";
import { enqueueJob, JobError } from "@/lib/jobs/queue";
import { recordUsage } from "@/lib/usage/ledger";
import { remainingEventAllowance } from "@/lib/usage/entitlements";
import { recordAudit, automationActor } from "@/lib/audit";
import { env } from "@/lib/env";
import { incCounter } from "@/lib/observability/metrics";
import { logger } from "@/lib/observability/logger";

const SYNCABLE = new Set(["connected", "degraded", "pending"]);

async function loadConnection(orgId: string, connectionId: string) {
  const [conn] = await db
    .select()
    .from(mailboxConnections)
    .where(and(eq(mailboxConnections.id, connectionId), eq(mailboxConnections.orgId, orgId)))
    .limit(1);
  return conn ?? null;
}

async function notifyReauth(orgId: string, connectionId: string, email: string, reason: string) {
  await db.insert(notifications).values({
    orgId,
    channel: "in_app",
    target: "org",
    status: "sent",
    sentAt: new Date(),
    title: `Reconnect ${email}`,
    body: `QuikReach can no longer read metadata for ${email}: ${reason} Monitoring for this mailbox is stopped until it is reconnected.`,
  });
  await recordAudit({ orgId, actor: automationActor("mailbox.sync"), action: "mailbox.reauth_required", targetType: "mailbox", targetId: connectionId, reason, outcome: "failure" });
}

export async function storeCapabilities(orgId: string, connectionId: string, results: CapabilityResult[]) {
  const now = new Date();
  for (const r of results) {
    await db
      .insert(providerCapabilities)
      .values({ orgId, connectionId, capability: r.capability, status: r.status, detail: r.detail, checkedAt: now })
      .onConflictDoUpdate({ target: [providerCapabilities.connectionId, providerCapabilities.capability], set: { status: r.status, detail: r.detail, checkedAt: now } });
  }
}

export async function runValidate(orgId: string, connectionId: string) {
  const conn = await loadConnection(orgId, connectionId);
  if (!conn) return { skipped: "connection not found" };
  if (conn.provider === "demo" || !SYNCABLE.has(conn.state)) return { skipped: `state ${conn.state}` };
  const adapter = getAdapter(conn.provider);
  try {
    const token = await getValidAccessToken(orgId, connectionId, conn.provider);
    const caps = await adapter.validateCapabilities(token, conn.grantedScopes);
    await storeCapabilities(orgId, connectionId, caps);
    const missingCore = caps.filter((c) => ["bounce_detection", "sent_volume"].includes(c.capability) && c.status === "unavailable");
    await db
      .update(mailboxConnections)
      .set(
        missingCore.length
          ? { state: "reauth_required", stateReason: "Required read-only permission was not granted. Reconnect and approve all requested permissions.", lastErrorCode: "insufficient_scope", updatedAt: new Date() }
          : { state: "connected", stateReason: null, nextSyncAt: new Date(), updatedAt: new Date() },
      )
      .where(eq(mailboxConnections.id, connectionId));
    if (!missingCore.length) {
      await enqueueJob({ type: "mailbox.sync", orgId, payload: { connectionId, trigger: "initial" }, idempotencyKey: `sync:${connectionId}`, priority: 60 });
    }
    return { capabilities: caps.length, missingCore: missingCore.map((c) => c.capability) };
  } catch (error: unknown) {
    return handleProviderFailure(orgId, conn, error, "validate");
  }
}

function nextBackoffAt(failures: number): Date {
  const minutes = Math.min(env().SYNC_INTERVAL_MINUTES * 2 ** Math.max(0, failures - 1), 360);
  return new Date(Date.now() + minutes * 60_000);
}

async function handleProviderFailure(orgId: string, conn: typeof mailboxConnections.$inferSelect, error: unknown, phase: "validate" | "sync"): Promise<never> {
  if (error instanceof ProviderError) {
    incCounter("quikreach_provider_errors_total", { provider: conn.provider, code: error.code, phase }, 1, "Provider API errors");
    if (REAUTH_CODES.has(error.code)) {
      // tokens.ts already moved the state when the failure happened during refresh;
      // make sure it is set for failures on data calls too.
      await db
        .update(mailboxConnections)
        .set({ state: "reauth_required", stateReason: error.message, lastErrorCode: error.code, lastErrorMessage: error.message, nextSyncAt: null, updatedAt: new Date() })
        .where(eq(mailboxConnections.id, conn.id));
      await notifyReauth(orgId, conn.id, conn.emailAddress, error.message);
      throw new JobError(`${error.code}: ${error.message}`, { retryable: false });
    }
    const failures = conn.consecutiveFailures + 1;
    await db
      .update(mailboxConnections)
      .set({
        state: failures >= 3 && conn.state !== "pending" ? "degraded" : conn.state,
        stateReason: failures >= 3 ? `Provider problem (${error.code.replace(/_/g, " ")}). Retrying with backoff; data may be stale.` : conn.stateReason,
        lastErrorCode: error.code,
        lastErrorMessage: error.message,
        consecutiveFailures: failures,
        nextSyncAt: nextBackoffAt(failures),
        updatedAt: new Date(),
      })
      .where(eq(mailboxConnections.id, conn.id));
    throw new JobError(`${error.code}: ${error.message}`, { retryable: error.retryable, retryAfterMs: error.retryAfterMs });
  }
  throw error;
}

export async function runSync(orgId: string, connectionId: string, trigger: "initial" | "scheduled" | "manual" = "scheduled", jobId?: string) {
  const conn = await loadConnection(orgId, connectionId);
  if (!conn) return { skipped: "connection not found" };
  if (conn.provider === "demo" || !SYNCABLE.has(conn.state)) return { skipped: `state ${conn.state}` };
  if (trigger === "scheduled") {
    const [org] = await db.select({ paused: organizations.automationPaused }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (org?.paused) return { skipped: "automation paused for this organization" };
  }

  const allowance = await remainingEventAllowance(orgId);
  if (allowance <= 0) {
    // Never drop data silently: we do not collect, and we say so.
    await db
      .update(mailboxConnections)
      .set({ stateReason: "Monthly event allowance reached — syncing is paused (no events are being collected) until the allowance resets or the plan changes.", nextSyncAt: new Date(Date.now() + 6 * 3_600_000), updatedAt: new Date() })
      .where(eq(mailboxConnections.id, connectionId));
    return { skipped: "event allowance exhausted" };
  }

  const e = env();
  const adapter = getAdapter(conn.provider);
  const [syncRow] = await db.insert(providerSyncs).values({ orgId, connectionId, trigger }).returning();
  await db.update(mailboxConnections).set({ lastSyncAttemptAt: new Date() }).where(eq(mailboxConnections.id, connectionId));

  const since = conn.lastSuccessfulSyncAt ?? new Date(Date.now() - e.INITIAL_SYNC_DAYS * 86_400_000);
  try {
    const token = await getValidAccessToken(orgId, connectionId, conn.provider);
    let page;
    try {
      page = await adapter.syncSince({ accessToken: token, cursor: conn.syncCursor, since, mailboxAddress: conn.emailAddress, maxMessages: e.SYNC_MAX_MESSAGES });
    } catch (error: unknown) {
      if (error instanceof ProviderError && error.code === "history_expired") {
        logger.info("sync_cursor_reset", { connectionId });
        page = await adapter.syncSince({ accessToken: token, cursor: null, since: new Date(Date.now() - e.INITIAL_SYNC_DAYS * 86_400_000), mailboxAddress: conn.emailAddress, maxMessages: e.SYNC_MAX_MESSAGES });
      } else {
        throw error;
      }
    }

    const ingested = await ingestSignals(
      { orgId, connectionId, domainId: conn.domainId, provider: conn.provider, source: conn.provider === "google" ? "gmail_api" : "graph_api" },
      page.signals,
    );
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(providerSyncs)
        .set({ status: page.hasMore ? "partial" : "succeeded", finishedAt: now, messagesExamined: page.messagesExamined, eventsCreated: ingested.created, eventsDuplicate: ingested.duplicate })
        .where(eq(providerSyncs.id, syncRow!.id));
      await tx
        .update(mailboxConnections)
        .set({
          state: "connected",
          stateReason: null,
          syncCursor: page.nextCursor,
          lastSuccessfulSyncAt: now,
          lastErrorCode: null,
          lastErrorMessage: null,
          consecutiveFailures: 0,
          nextSyncAt: page.hasMore ? new Date(now.getTime() + 30_000) : new Date(now.getTime() + e.SYNC_INTERVAL_MINUTES * 60_000),
          updatedAt: now,
        })
        .where(eq(mailboxConnections.id, connectionId));
      await recordUsage({ orgId, metric: "event_ingested", quantity: ingested.created, idempotencyKey: `sync-events:${syncRow!.id}`, source: "mailbox.sync" }, tx);
      if (ingested.created > 0) {
        await enqueueJob({ type: "alerts.evaluate", orgId, idempotencyKey: `alerts:${orgId}`, runAt: new Date(now.getTime() + 10_000) }, tx);
      }
    });
    incCounter("quikreach_sync_runs_total", { provider: conn.provider, status: "succeeded" }, 1, "Mailbox sync runs");
    incCounter("quikreach_events_ingested_total", { provider: conn.provider }, ingested.created, "Events ingested");
    return { examined: page.messagesExamined, created: ingested.created, duplicate: ingested.duplicate, hasMore: page.hasMore, jobId };
  } catch (error: unknown) {
    const code = error instanceof ProviderError ? error.code : "internal_error";
    const message = error instanceof ProviderError ? error.message : "Unexpected sync failure (logged).";
    await db.update(providerSyncs).set({ status: "failed", finishedAt: new Date(), errorCode: code, errorMessage: message }).where(eq(providerSyncs.id, syncRow!.id));
    incCounter("quikreach_sync_runs_total", { provider: conn.provider, status: "failed" }, 1, "Mailbox sync runs");
    return handleProviderFailure(orgId, conn, error, "sync");
  }
}
