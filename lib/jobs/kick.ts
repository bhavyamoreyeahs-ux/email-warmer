/**
 * Serverless only: start a short worker pass right after the response is sent
 * (Next.js `after()`), so user-triggered work — a manual scan, a sync, a new
 * mailbox's validation — runs within seconds instead of waiting for the next
 * scheduled trigger. With an always-on worker (`npm run worker`) this is a
 * no-op. Concurrent passes are safe: jobs are claimed with SKIP LOCKED.
 */
import { after } from "next/server";
import { runWorkerBatch } from "@/lib/jobs/worker";
import { reportError } from "@/lib/observability/logger";

export function kickWorker(): void {
  const enabled = process.env.INLINE_JOB_KICK === "true" || (process.env.VERCEL === "1" && process.env.INLINE_JOB_KICK !== "false");
  if (!enabled) return;
  after(async () => {
    try {
      await runWorkerBatch({ budgetMs: 40_000, workerId: "inline-kick" });
    } catch (error: unknown) {
      reportError(error, { where: "inline_worker_kick" });
    }
  });
}
