/** Delivers queued email / webhook notifications. Status reflects reality: sent, failed or not_configured. */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { notifications } from "@/lib/db/schema";
import { sendEmail } from "@/lib/notify/email";
import { getIntegrationSecret } from "@/lib/integrations/service";
import { postSignedWebhook } from "@/lib/integrations/webhook";
import { JobError } from "@/lib/jobs/queue";

export async function deliverNotification(orgId: string, notificationId: string) {
  const [n] = await db.select().from(notifications).where(and(eq(notifications.id, notificationId), eq(notifications.orgId, orgId))).limit(1);
  if (!n || n.status === "sent") return { skipped: true };
  let status: "sent" | "failed" | "not_configured" = "failed";
  let error: string | null = null;

  if (n.channel === "email") {
    const r = await sendEmail({ to: n.target, subject: `[QuikReach] ${n.title}`, text: `${n.body}\n\nOpen QuikReach to see the evidence behind this alert.` });
    status = r.status;
    error = r.status === "failed" ? r.error : null;
  } else if (n.channel === "webhook") {
    try {
      const { row, secret } = await getIntegrationSecret(orgId, n.target);
      if (row.status !== "active" || !secret) {
        status = "failed";
        error = "Notification webhook is not active.";
      } else {
        const r = await postSignedWebhook({ url: String(row.config.endpointUrl ?? ""), secret, idempotencyKey: `notification:${n.id}`, body: { type: "alert.notification", notificationId: n.id, alertId: n.alertId, title: n.title, body: n.body } });
        status = r.ok ? "sent" : "failed";
        error = r.error;
      }
    } catch (e: unknown) {
      status = "failed";
      error = e instanceof Error ? e.message : "Delivery failed";
    }
  } else {
    status = "sent";
  }

  await db
    .update(notifications)
    .set({ status, lastError: error, attempts: n.attempts + 1, sentAt: status === "sent" ? new Date() : null })
    .where(eq(notifications.id, n.id));
  if (status === "failed" && n.attempts + 1 < 3) throw new JobError(`Notification delivery failed: ${error}`, { retryable: true });
  return { status };
}
