/**
 * Readiness: configuration valid, database reachable and migrated. Reports
 * worker heartbeat freshness (no worker = "degraded": pages work, but syncs,
 * scans and alerts do not run). Each check reports its own failure.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

type Check = { ok: boolean; detail: string };

export async function GET() {
  const checks: Record<string, Check> = {};
  try {
    env();
    checks.config = { ok: true, detail: "valid" };
  } catch {
    checks.config = { ok: false, detail: "invalid configuration (see server logs)" };
  }
  if (checks.config.ok) {
    try {
      await db.execute(sql`select 1`);
      checks.database = { ok: true, detail: "reachable" };
    } catch {
      checks.database = { ok: false, detail: "unreachable" };
    }
  }
  if (checks.database?.ok) {
    try {
      const mig = await db.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
      const n = Number((mig as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0);
      checks.migrations = { ok: n > 0, detail: `${n} applied` };
    } catch {
      checks.migrations = { ok: false, detail: "migrations have not been applied (run npm run db:migrate)" };
    }
    try {
      const hb = await db.execute<{ last: string | null }>(sql`select max(last_seen_at) as last from worker_heartbeats`);
      const last = (hb as unknown as { rows: Array<{ last: string | null }> }).rows[0]?.last;
      const fresh = last ? Date.now() - new Date(last).getTime() < 90_000 : false;
      checks.worker = { ok: fresh, detail: last ? `last heartbeat ${new Date(last).toISOString()}` : "no worker heartbeat recorded" };
    } catch {
      checks.worker = { ok: false, detail: "worker heartbeat unavailable" };
    }
  }
  const ready = Boolean(checks.config?.ok && checks.database?.ok && checks.migrations?.ok);
  const status = !ready ? "unavailable" : checks.worker?.ok ? "ready" : "degraded";
  return Response.json({ status, checks }, { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } });
}
