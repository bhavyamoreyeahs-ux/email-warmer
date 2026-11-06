/**
 * Serverless worker entry point, invoked every minute by Vercel Cron
 * (vercel.json). Runs the scheduler tick and processes queued jobs for up to
 * ~50 seconds. Vercel sends `Authorization: Bearer $CRON_SECRET`; without a
 * configured CRON_SECRET the endpoint refuses to run, so it can never be
 * triggered anonymously.
 */
import { runWorkerBatch } from "@/lib/jobs/worker";
import { safeEqual } from "@/lib/crypto/hash";
import { reportError } from "@/lib/observability/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ success: false, error: "CRON_SECRET is not configured.", code: "UNAVAILABLE" }, { status: 503 });
  if (!safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) return new Response("Unauthorized", { status: 401 });
  try {
    const summary = await runWorkerBatch({ budgetMs: 50_000, workerId: "vercel-cron" });
    return Response.json({ success: true, data: summary }, { headers: { "cache-control": "no-store" } });
  } catch (error: unknown) {
    reportError(error, { route: "cron.worker" });
    return Response.json({ success: false, error: "Worker batch failed (logged).", code: "INTERNAL_ERROR" }, { status: 500 });
  }
}
