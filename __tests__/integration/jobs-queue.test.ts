import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/db";
import { makeOrg } from "../helpers/factories";
import { db } from "@/lib/db";
import { backgroundJobs } from "@/lib/db/schema";
import { claimJobs, completeJob, enqueueJob, failJob, JobError, retryDeadJob } from "@/lib/jobs/queue";

describe("postgres job queue", () => {
  let orgId: string;
  beforeAll(async () => {
    await createTestDb();
    orgId = (await makeOrg()).id;
  });

  it("de-duplicates pending jobs by idempotency key", async () => {
    const a = await enqueueJob({ type: "domain.scan", orgId, idempotencyKey: "scan:x" });
    const b = await enqueueJob({ type: "domain.scan", orgId, idempotencyKey: "scan:x" });
    expect(a.deduplicated).toBe(false);
    expect(b.deduplicated).toBe(true);
  });

  it("claims, completes, and allows re-enqueue after completion", async () => {
    const claimed = await claimJobs("w1", 10);
    expect(claimed.length).toBeGreaterThan(0);
    for (const j of claimed) await completeJob(j.id, { ok: true });
    const again = await enqueueJob({ type: "domain.scan", orgId, idempotencyKey: "scan:x" });
    expect(again.deduplicated).toBe(false);
  });

  it("retries with backoff, then dead-letters after max attempts", async () => {
    const { id } = await enqueueJob({ type: "mailbox.sync", orgId, maxAttempts: 2, idempotencyKey: "sync:dl" });
    // Drain everything else first.
    let [job] = (await claimJobs("w1", 50)).filter((j) => j.id === id);
    expect(job).toBeDefined();
    expect(await failJob(job!, new Error("boom"))).toBe("queued");
    await db.update(backgroundJobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(backgroundJobs.id, id!));
    [job] = (await claimJobs("w1", 50)).filter((j) => j.id === id);
    expect(job!.attempts).toBe(2);
    expect(await failJob(job!, new Error("boom again"))).toBe("dead");
    const [row] = await db.select().from(backgroundJobs).where(eq(backgroundJobs.id, id!));
    expect(row!.status).toBe("dead");
    expect(row!.lastError).toContain("boom again");
  });

  it("non-retryable errors dead-letter immediately; admins can retry dead jobs in their org only", async () => {
    const { id } = await enqueueJob({ type: "mailbox.sync", orgId, idempotencyKey: "sync:nr" });
    const [job] = (await claimJobs("w1", 50)).filter((j) => j.id === id);
    expect(await failJob(job!, new JobError("revoked", { retryable: false }))).toBe("dead");
    const otherOrg = await makeOrg();
    expect(await retryDeadJob(otherOrg.id, id!)).toBe(false);
    expect(await retryDeadJob(orgId, id!)).toBe(true);
  });
});
