/**
 * Background job execution, in two shapes that share `processJob`:
 *  - `createWorker()` — the always-on loop (scripts/worker.ts): heartbeat,
 *    scheduler tick, claim → run → complete/fail, stale-lock reaping, graceful
 *    shutdown.
 *  - `runWorkerBatch()` — one bounded pass for serverless hosts (Vercel Cron →
 *    app/api/cron/worker): same scheduler tick and job processing, stopping
 *    before the time budget runs out. Jobs cut off by a platform timeout are
 *    reclaimed by the stale-lock reaper and retried.
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workerHeartbeats } from "@/lib/db/schema";
import { claimJobs, completeJob, failJob, reapStaleJobs, type JobType } from "@/lib/jobs/queue";
import { handlers } from "@/lib/jobs/handlers";
import { schedulerTick } from "@/lib/jobs/scheduler";
import { env } from "@/lib/env";
import { logger, reportError } from "@/lib/observability/logger";
import { incCounter, setGauge } from "@/lib/observability/metrics";

export interface WorkerState {
  id: string;
  running: boolean;
  inFlight: number;
  lastTickAt: Date | null;
  lastHeartbeatAt: Date | null;
}

type ClaimedJob = Awaited<ReturnType<typeof claimJobs>>[number];

/** Run one claimed job to completion, recording success, retry or dead-letter. */
export async function processJob(job: ClaimedJob, log = logger): Promise<"succeeded" | "queued" | "dead"> {
  const started = Date.now();
  const handler = handlers[job.type as JobType];
  try {
    if (!handler) throw new Error(`No handler for job type ${job.type}`);
    const result = await handler(job);
    await completeJob(job.id, result);
    incCounter("quikreach_jobs_total", { type: job.type, outcome: "succeeded" }, 1, "Background jobs by outcome");
    log.info("job_succeeded", { jobId: job.id, type: job.type, orgId: job.orgId, ms: Date.now() - started, attempt: job.attempts });
    return "succeeded";
  } catch (error: unknown) {
    const outcome = await failJob(job, error);
    incCounter("quikreach_jobs_total", { type: job.type, outcome: outcome === "dead" ? "dead" : "retry" }, 1, "Background jobs by outcome");
    if (outcome === "dead") reportError(error, { jobId: job.id, type: job.type, orgId: job.orgId, deadLettered: true });
    else log.warn("job_failed_will_retry", { jobId: job.id, type: job.type, orgId: job.orgId, attempt: job.attempts, error });
    return outcome;
  }
}

/**
 * One bounded worker pass (serverless). The heartbeat row doubles as the
 * scheduler's "previous tick" so period boundaries are detected across runs.
 */
export async function runWorkerBatch(opts: { budgetMs: number; workerId?: string }) {
  const e = env();
  const workerId = opts.workerId ?? "serverless-cron";
  const deadline = Date.now() + opts.budgetMs;
  const log = logger.child({ worker: workerId });
  const summary = { scheduled: { syncs: 0, scans: 0, evaluations: 0 }, reaped: 0, processed: 0, succeeded: 0, retried: 0, dead: 0 };

  const [prev] = await db.select({ lastSeenAt: workerHeartbeats.lastSeenAt }).from(workerHeartbeats).where(sql`${workerHeartbeats.workerId} = ${workerId}`).limit(1);
  const now = new Date();
  await db
    .insert(workerHeartbeats)
    .values({ workerId, lastSeenAt: now, info: { mode: "batch", budgetMs: opts.budgetMs } })
    .onConflictDoUpdate({ target: workerHeartbeats.workerId, set: { lastSeenAt: now, info: { mode: "batch", budgetMs: opts.budgetMs } } });

  summary.scheduled = await schedulerTick(now, prev?.lastSeenAt ?? null);
  summary.reaped = await reapStaleJobs();

  // Leave headroom: a single job (a DNS scan, a sync page) can take several seconds.
  while (Date.now() < deadline - 15_000) {
    const jobs = await claimJobs(`${workerId}:${randomUUID().slice(0, 6)}`, e.WORKER_CONCURRENCY);
    if (!jobs.length) break;
    const outcomes = await Promise.all(jobs.map((j) => processJob(j, log)));
    summary.processed += outcomes.length;
    summary.succeeded += outcomes.filter((o) => o === "succeeded").length;
    summary.retried += outcomes.filter((o) => o === "queued").length;
    summary.dead += outcomes.filter((o) => o === "dead").length;
  }
  return summary;
}

export function createWorker() {
  const e = env();
  const state: WorkerState = { id: `${hostname()}:${process.pid}:${randomUUID().slice(0, 6)}`, running: false, inFlight: 0, lastTickAt: null, lastHeartbeatAt: null };
  const log = logger.child({ worker: state.id });

  async function heartbeat() {
    await db
      .insert(workerHeartbeats)
      .values({ workerId: state.id, lastSeenAt: new Date(), info: { inFlight: state.inFlight, concurrency: e.WORKER_CONCURRENCY } })
      .onConflictDoUpdate({ target: workerHeartbeats.workerId, set: { lastSeenAt: new Date(), info: { inFlight: state.inFlight, concurrency: e.WORKER_CONCURRENCY } } });
    state.lastHeartbeatAt = new Date();
  }

  async function runOne(job: ClaimedJob) {
    try {
      await processJob(job, log);
    } finally {
      state.inFlight -= 1;
    }
  }

  async function loop() {
    let lastTick = 0;
    let lastBeat = 0;
    let lastReap = 0;
    while (state.running) {
      try {
        const now = Date.now();
        if (now - lastBeat > 15_000) {
          await heartbeat();
          lastBeat = now;
        }
        if (now - lastTick > 60_000) {
          const r = await schedulerTick(new Date(), state.lastTickAt);
          state.lastTickAt = new Date();
          lastTick = now;
          if (r.syncs || r.scans) log.info("scheduler_tick", r);
        }
        if (now - lastReap > 120_000) {
          const reaped = await reapStaleJobs();
          if (reaped) log.warn("reaped_stale_jobs", { reaped });
          lastReap = now;
        }
        const free = e.WORKER_CONCURRENCY - state.inFlight;
        if (free > 0) {
          const jobs = await claimJobs(state.id, free);
          for (const job of jobs) {
            state.inFlight += 1;
            void runOne(job);
          }
          if (jobs.length === free) continue; // more work is likely waiting
        }
        const depth = await db.execute<{ n: number }>(sql`select count(*)::int as n from background_jobs where status = 'queued' and run_at <= now()`);
        setGauge("quikreach_jobs_ready", Number((depth as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0), undefined, "Jobs ready to run");
      } catch (error: unknown) {
        reportError(error, { where: "worker_loop" });
      }
      await new Promise((r) => setTimeout(r, e.WORKER_POLL_MS));
    }
  }

  return {
    state,
    start() {
      state.running = true;
      log.info("worker_started", { concurrency: e.WORKER_CONCURRENCY, pollMs: e.WORKER_POLL_MS });
      return loop();
    },
    async stop(timeoutMs = 25_000) {
      state.running = false;
      const deadline = Date.now() + timeoutMs;
      while (state.inFlight > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      log.info("worker_stopped", { abandoned: state.inFlight });
    },
  };
}
