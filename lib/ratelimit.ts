/**
 * Fixed-window rate limiting backed by PostgreSQL, so the limit is global
 * across every app instance without requiring Redis. One upsert per check.
 *
 * Keys must not contain raw secrets; prefer `ip-hash` or ids.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export async function checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStartMs = Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000;
  const windowStart = new Date(windowStartMs);
  const rows = await db.execute<{ count: number }>(sql`
    insert into rate_limit_buckets (key, window_start, count)
    values (${key}, ${windowStart.toISOString()}, 1)
    on conflict (key, window_start) do update set count = rate_limit_buckets.count + 1
    returning count
  `);
  const count = Number((rows as unknown as { rows: Array<{ count: number }> }).rows?.[0]?.count ?? 1);
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStartMs + windowSeconds * 1000 - now) / 1000));
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfterSeconds };
}

/** Housekeeping: drop expired windows (run by the retention job). */
export async function purgeRateLimitBuckets(olderThan: Date): Promise<void> {
  await db.execute(sql`delete from rate_limit_buckets where window_start < ${olderThan.toISOString()}`);
}
