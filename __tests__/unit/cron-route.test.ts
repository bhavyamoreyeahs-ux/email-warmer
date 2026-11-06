import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/jobs/worker", () => ({ runWorkerBatch: vi.fn().mockResolvedValue({ processed: 0 }) }));
import { GET } from "@/app/api/cron/worker/route";

describe("cron worker endpoint", () => {
  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("refuses to run without a configured secret, and rejects wrong tokens", async () => {
    expect((await GET(new Request("http://x/api/cron/worker"))).status).toBe(503);
    process.env.CRON_SECRET = "s3cret-value";
    expect((await GET(new Request("http://x/api/cron/worker", { headers: { authorization: "Bearer nope" } }))).status).toBe(401);
    expect((await GET(new Request("http://x/api/cron/worker", { headers: { authorization: "Bearer s3cret-value" } }))).status).toBe(200);
  });
});
