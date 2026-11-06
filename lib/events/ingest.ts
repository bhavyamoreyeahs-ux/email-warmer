/**
 * Idempotent ingestion of normalised provider signals.
 *
 * - dedupe key = provider : connection : provider message id : category, with a
 *   unique (org_id, dedupe_key) constraint. Re-running a sync, retrying a job or
 *   replaying a page can never create duplicates.
 * - Counterparty addresses are reduced to their domain + a keyed hash before
 *   storage; the address itself is discarded here.
 * - Subjects and bodies never reach this layer (adapters strip them).
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { providerEvents, type Provider } from "@/lib/db/schema";
import type { NormalizedSignal } from "@/lib/mailboxes/providers/types";
import { recipientHash } from "@/lib/crypto/hash";

export function dedupeKeyFor(provider: Provider, connectionId: string, signal: Pick<NormalizedSignal, "providerMessageRef" | "category">): string {
  return `${provider}:${connectionId}:${signal.providerMessageRef}:${signal.category}`;
}

function domainOf(address: string | null): string | null {
  if (!address) return null;
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(at + 1).trim().toLowerCase() || null : null;
}

export interface IngestTarget {
  orgId: string;
  connectionId: string;
  domainId: string | null;
  provider: Provider;
  source: string;
  isDemo?: boolean;
}

export async function ingestSignals(target: IngestTarget, signals: NormalizedSignal[]): Promise<{ created: number; duplicate: number; createdIds: string[] }> {
  let created = 0;
  let duplicate = 0;
  const createdIds: string[] = [];
  // Small batches keep statements bounded; each row is independently idempotent.
  for (let i = 0; i < signals.length; i += 200) {
    const batch = signals.slice(i, i + 200);
    const values = batch.map((s) => ({
      orgId: target.orgId,
      connectionId: target.connectionId,
      domainId: target.domainId,
      provider: target.provider,
      source: target.source,
      category: s.category,
      dedupeKey: dedupeKeyFor(target.provider, target.connectionId, s),
      providerMessageRef: s.providerMessageRef,
      occurredAt: s.occurredAt,
      recipientDomain: domainOf(s.counterpartyAddress),
      recipientHash: s.counterpartyAddress ? recipientHash(target.orgId, s.counterpartyAddress) : null,
      confidence: s.confidence,
      classificationBasis: s.classificationBasis,
      diagnosticCode: s.diagnosticCode,
      metadata: s.metadata,
      isDemo: target.isDemo ?? false,
    }));
    const rows = await db
      .insert(providerEvents)
      .values(values)
      .onConflictDoNothing({ target: [providerEvents.orgId, providerEvents.dedupeKey] })
      .returning({ id: providerEvents.id });
    created += rows.length;
    duplicate += batch.length - rows.length;
    createdIds.push(...rows.map((r) => r.id));
  }
  return { created, duplicate, createdIds };
}

/** Counts by category over a window, for a set of connections (or the whole org). */
export async function countEventsByCategory(orgId: string, since: Date, until: Date, connectionIds?: string[]) {
  const connFilter = connectionIds?.length ? sql`and connection_id in (${sql.join(connectionIds.map((c) => sql`${c}`), sql`, `)})` : sql``;
  const result = await db.execute<{ category: string; n: number }>(sql`
    select category, count(*)::int as n
      from provider_events
     where org_id = ${orgId} and occurred_at >= ${since.toISOString()} and occurred_at < ${until.toISOString()} ${connFilter}
     group by category
  `);
  const rows = (result as unknown as { rows: Array<{ category: string; n: number }> }).rows ?? [];
  return Object.fromEntries(rows.map((r) => [r.category, Number(r.n)])) as Record<string, number>;
}
