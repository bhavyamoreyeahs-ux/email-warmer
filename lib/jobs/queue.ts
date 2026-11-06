/**
 * Durable background-job queue on PostgreSQL.
 *
 * WHY NOT REDIS/BULLMQ (decision recorded in docs/decisions.md, ADR-003)
 * The workload is low-volume and correctness-sensitive. Keeping jobs in the
 * same database as the data they act on gives a transactional outbox for free:
 * a job is enqueued in the SAME transaction as the change that requires it, so
 * there is no "row committed but job lost" window and no extra infrastructure.
 * `JobQueue` is the seam if volume ever justifies BullMQ.
 *
 * Guarantees
 *  - At-least-once execution; handlers are written to be idempotent.
 *  - Claiming uses `FOR UPDATE SKIP LOCKED`, so many workers can poll safely.
 *  - Bounded retries with exponential backoff + jitter (or provider Retry-After).
 *  - Exhausted or non-retryable jobs move to `dead` (the dead-letter state),
 *    are visible in Settings → Jobs, and can be retried by an administrator.
 *  - Optional idempotency key de-duplicates enqueues while a job is pending.
 *  - Jobs locked by a crashed worker are reclaimed after LOCK_TIMEOUT.
 */
import { sql } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import type { backgroundJobs } from "@/lib/db/schema";

export const JOB_TYPES = [
  "domain.scan",
  "domain.verify",
  "mailbox.validate",
  "mailbox.sync",
  "alerts.evaluate",
  "health.compute",
  "notification.deliver",
  "campaign.action",
  "retention.purge",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export type JobRow = typeof backgroundJobs.$inferSelect;

export interface EnqueueInput {
  type: JobType;
  orgId: string | null;
  payload?: Record<string, unknown>;
  runAt?: Date;
  idempotencyKey?: string;
  maxAttempts?: number;
  priority?: number;
}

/** Thrown by handlers to control retry behaviour. */
export class JobError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  constructor(message: string, opts: { retryable?: boolean; retryAfterMs?: number | null } = {}) {
    super(message);
    this.name = "JobError";
    this.retryable = opts.retryable ?? true;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

const LOCK_TIMEOUT_MINUTES = 10;

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/** snake_case row from raw SQL → the drizzle row shape. */
function mapJob(r: Record<string, unknown>): JobRow {
  const d = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string));
  return {
    id: r.id as string,
    orgId: (r.org_id as string | null) ?? null,
    type: r.type as string,
    payload: (r.payload as Record<string, unknown>) ?? {},
    status: r.status as JobRow["status"],
    priority: Number(r.priority),
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    runAt: d(r.run_at)!,
    lockedAt: d(r.locked_at),
    lockedBy: (r.locked_by as string | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    idempotencyKey: (r.idempotency_key as string | null) ?? null,
    result: (r.result as Record<string, unknown> | null) ?? null,
    createdAt: d(r.created_at)!,
    updatedAt: d(r.updated_at)!,
    completedAt: d(r.completed_at),
  };
}

export async function enqueueJob(input: EnqueueInput, executor: Executor = db): Promise<{ id: string | null; deduplicated: boolean }> {
  const result = await executor.execute(sql`
    insert into background_jobs (org_id, type, payload, run_at, idempotency_key, max_attempts, priority)
    values (
      ${input.orgId},
      ${input.type},
      ${JSON.stringify(input.payload ?? {})}::jsonb,
      ${(input.runAt ?? new Date()).toISOString()},
      ${input.idempotencyKey ?? null},
      ${input.maxAttempts ?? 5},
      ${input.priority ?? 100}
    )
    on conflict (idempotency_key) where status in ('queued', 'running') do nothing
    returning id
  `);
  const id = rowsOf<{ id: string }>(result)[0]?.id ?? null;
  return { id, deduplicated: id === null };
}

export async function claimJobs(workerId: string, limit: number): Promise<JobRow[]> {
  const result = await db.execute(sql`
    update background_jobs
       set status = 'running', locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1, updated_at = now()
     where id in (
       select id from background_jobs
        where status = 'queued' and run_at <= now()
        order by priority asc, run_at asc
        limit ${limit}
        for update skip locked
     )
    returning *
  `);
  return rowsOf<Record<string, unknown>>(result).map(mapJob);
}

export async function completeJob(id: string, result: Record<string, unknown> = {}): Promise<void> {
  await db.execute(sql`
    update background_jobs
       set status = 'succeeded', result = ${JSON.stringify(result)}::jsonb, completed_at = now(),
           locked_at = null, locked_by = null, updated_at = now(), last_error = null
     where id = ${id}
  `);
}

export function backoffMs(attempts: number): number {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 60 * 60 * 1000);
  return base + Math.floor(Math.random() * Math.min(base * 0.2, 30_000));
}

/** Returns the resulting status ("queued" for retry, "dead" when exhausted / non-retryable). */
export async function failJob(job: Pick<JobRow, "id" | "attempts" | "maxAttempts">, error: unknown): Promise<"queued" | "dead"> {
  const retryable = error instanceof JobError ? error.retryable : true;
  const retryAfter = error instanceof JobError ? error.retryAfterMs : null;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  const exhausted = job.attempts >= job.maxAttempts;
  if (!retryable || exhausted) {
    await db.execute(sql`
      update background_jobs
         set status = 'dead', last_error = ${message}, locked_at = null, locked_by = null, completed_at = now(), updated_at = now()
       where id = ${job.id}
    `);
    return "dead";
  }
  const runAt = new Date(Date.now() + Math.max(retryAfter ?? 0, backoffMs(job.attempts)));
  await db.execute(sql`
    update background_jobs
       set status = 'queued', last_error = ${message}, run_at = ${runAt.toISOString()}, locked_at = null, locked_by = null, updated_at = now()
     where id = ${job.id}
  `);
  return "queued";
}

/** Reclaim jobs whose worker died mid-flight. */
export async function reapStaleJobs(): Promise<number> {
  const result = await db.execute(sql`
    update background_jobs
       set status = case when attempts >= max_attempts then 'dead' else 'queued' end,
           last_error = coalesce(last_error, '') || ' [reclaimed: worker lock expired]',
           locked_at = null, locked_by = null, updated_at = now(),
           completed_at = case when attempts >= max_attempts then now() else null end
     where status = 'running' and locked_at < now() - make_interval(mins => ${LOCK_TIMEOUT_MINUTES})
    returning id
  `);
  return rowsOf(result).length;
}

/** Administrator action: move a dead job back to the queue (tenant-scoped). */
export async function retryDeadJob(orgId: string, jobId: string): Promise<boolean> {
  const result = await db.execute(sql`
    update background_jobs
       set status = 'queued', attempts = 0, run_at = now(), last_error = null, completed_at = null, updated_at = now()
     where id = ${jobId} and org_id = ${orgId} and status = 'dead'
    returning id
  `);
  return rowsOf(result).length === 1;
}

export interface JobQueue {
  enqueue: typeof enqueueJob;
  claim: typeof claimJobs;
  complete: typeof completeJob;
  fail: typeof failJob;
}

export const postgresJobQueue: JobQueue = { enqueue: enqueueJob, claim: claimJobs, complete: completeJob, fail: failJob };
