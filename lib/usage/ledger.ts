/**
 * Append-only usage ledger. Idempotent per (org, idempotency key), so a retried
 * job can never double-count usage.
 */
import { sql } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import type { UsageMetric } from "@/lib/db/schema";

export async function recordUsage(
  input: { orgId: string; metric: UsageMetric; quantity: number; idempotencyKey: string; source: string; metadata?: Record<string, unknown> },
  executor: Executor = db,
): Promise<boolean> {
  if (input.quantity <= 0) return false;
  const result = await executor.execute(sql`
    insert into usage_ledger (org_id, metric, quantity, idempotency_key, source, metadata)
    values (${input.orgId}, ${input.metric}, ${input.quantity}, ${input.idempotencyKey}, ${input.source}, ${JSON.stringify(input.metadata ?? {})}::jsonb)
    on conflict (org_id, idempotency_key) do nothing
    returning id
  `);
  return ((result as unknown as { rows?: unknown[] }).rows ?? []).length === 1;
}
