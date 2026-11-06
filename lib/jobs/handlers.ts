/**
 * Job handlers. Each handler re-loads its target scoped by the job's org id —
 * a payload id from another organisation simply resolves to "not found".
 */
import type { JobRow, JobType } from "@/lib/jobs/queue";
import { JobError } from "@/lib/jobs/queue";
import { markScanFailed, runScan } from "@/lib/domains/service";
import { runSync, runValidate } from "@/lib/mailboxes/sync";
import { evaluateOrgRules } from "@/lib/alerts/evaluate";
import { storeHealthSnapshots } from "@/lib/health/service";
import { deliverNotification } from "@/lib/notify/deliver";
import { executeCampaignAction, markCampaignActionFailed } from "@/lib/campaigns/service";
import { purgeAll } from "@/lib/retention/purge";

type Handler = (job: JobRow) => Promise<Record<string, unknown>>;

const requireOrg = (job: JobRow): string => {
  if (!job.orgId) throw new JobError(`Job ${job.type} requires an organization`, { retryable: false });
  return job.orgId;
};
const str = (job: JobRow, key: string): string => {
  const v = job.payload[key];
  if (typeof v !== "string" || !v) throw new JobError(`Job ${job.type} missing payload.${key}`, { retryable: false });
  return v;
};

export const handlers: Record<JobType, Handler> = {
  "domain.scan": async (job) => {
    const orgId = requireOrg(job);
    const scanId = str(job, "scanId");
    try {
      return await runScan(orgId, scanId);
    } catch (error: unknown) {
      if (job.attempts >= job.maxAttempts) await markScanFailed(orgId, scanId, error instanceof Error ? error.message : "scan failed");
      throw error;
    }
  },
  "domain.verify": async () => ({ skipped: "verification runs inline" }),
  "mailbox.validate": async (job) => runValidate(requireOrg(job), str(job, "connectionId")),
  "mailbox.sync": async (job) => {
    const trigger = job.payload.trigger === "initial" || job.payload.trigger === "manual" ? job.payload.trigger : "scheduled";
    return runSync(requireOrg(job), str(job, "connectionId"), trigger, job.id);
  },
  "alerts.evaluate": async (job) => evaluateOrgRules(requireOrg(job)),
  "health.compute": async (job) => storeHealthSnapshots(requireOrg(job)),
  "notification.deliver": async (job) => deliverNotification(requireOrg(job), str(job, "notificationId")),
  "campaign.action": async (job) => {
    const orgId = requireOrg(job);
    const actionId = str(job, "actionId");
    try {
      return await executeCampaignAction(orgId, actionId);
    } catch (error: unknown) {
      if (job.attempts >= job.maxAttempts) await markCampaignActionFailed(orgId, actionId, error instanceof Error ? error.message : "failed");
      throw error;
    }
  },
  "retention.purge": async () => purgeAll(),
};
