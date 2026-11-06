/**
 * Outbound email for QuikReach's OWN notifications (alerts, invitations).
 * Requires SMTP_URL + EMAIL_FROM. When not configured the caller records the
 * notification as `not_configured` — it is never reported as sent.
 */
import nodemailer from "nodemailer";
import { env } from "@/lib/env";
import { logger } from "@/lib/observability/logger";

export type EmailResult = { status: "sent" } | { status: "not_configured" } | { status: "failed"; error: string };

export function emailConfigured(): boolean {
  const e = env();
  return Boolean(e.SMTP_URL && e.EMAIL_FROM);
}

export async function sendEmail(input: { to: string; subject: string; text: string }): Promise<EmailResult> {
  const e = env();
  if (!e.SMTP_URL || !e.EMAIL_FROM) return { status: "not_configured" };
  try {
    const transport = nodemailer.createTransport(e.SMTP_URL);
    await transport.sendMail({ from: e.EMAIL_FROM, to: input.to, subject: input.subject, text: input.text });
    return { status: "sent" };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "SMTP error";
    logger.warn("email_send_failed", { error: message });
    return { status: "failed", error: message };
  }
}
