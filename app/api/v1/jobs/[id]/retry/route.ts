import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { badRequest } from "@/lib/api/errors";
import { retryDeadJob } from "@/lib/jobs/queue";

export const POST = withOrgAuth<{ id: string }>(
  async ({ params, principal, audit }) => {
    const done = await retryDeadJob(principal.orgId, params.id);
    if (!done) throw badRequest("Only dead-lettered jobs in this organization can be retried.");
    await audit({ action: "job.retry", targetType: "background_job", targetId: params.id, outcome: "success" });
    return ok({ id: params.id, status: "queued" });
  },
  { permission: "job:retry" },
);
