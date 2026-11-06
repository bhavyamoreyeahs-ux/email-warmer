/**
 * Header-based message classification shared by the Gmail and Graph adapters.
 *
 * Pure function of message METADATA (sender, recipients, a few headers, and
 * the subject line). The subject is read only to match fixed patterns; it is
 * never copied into the returned signal — `classificationBasis` names the
 * pattern ("subject-pattern:delivery-failure"), not the text.
 *
 * Ordinary mail is not an event: anything that matches no rule returns null.
 * A "sent" signal records that the provider sent a message, which is NOT
 * proof that it reached an inbox.
 */
import type { EventCategory } from "@/lib/db/schema";
import type { NormalizedSignal } from "@/lib/mailboxes/providers/types";

export interface ClassifyInput {
  providerMessageRef: string;
  occurredAt: Date;
  direction: "outbound" | "inbound";
  from: string | null;
  /** Recipient addresses (already extracted). */
  to: string[];
  /** Used only for pattern matching; never copied into the output. */
  subject: string | null;
  /** Lower-cased header names; may be empty when the provider does not expose headers. */
  headers: Record<string, string>;
  mailboxAddress: string;
  /**
   * true: the thread contains a message this mailbox sent.
   * false: confirmed it does not (the message is then not treated as a reply).
   * undefined: not determined.
   */
  isReplyToOurThread?: boolean;
}

type Confidence = NormalizedSignal["confidence"];

/* ─── Address helpers ─────────────────────────────────────────────────── */

const ADDR_IN_ANGLE = /<\s*([^<>\s@]+@[^<>\s@]+)\s*>/;
const BARE_ADDR = /([^\s<>"',;:()[\]]+@[^\s<>"',;:()[\]]+)/;

/** Extract one address from `"Name" <a@b>`, `Name <a@b>`, `<a@b>` or `a@b`. Lower-cased; null if none. */
export function extractAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const candidate = ADDR_IN_ANGLE.exec(value)?.[1] ?? BARE_ADDR.exec(value)?.[1];
  if (!candidate) return null;
  return candidate.trim().replace(/\.+$/, "").toLowerCase();
}

/** Extract every address from an address-list header, splitting on commas/semicolons outside quotes and <>. */
export function extractAddresses(value: string | null | undefined): string[] {
  if (!value) return [];
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let angleDepth = 0;
  let escaped = false;
  for (const ch of value) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && inQuote) {
      escaped = true;
      current += ch;
      continue;
    }
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === "<") angleDepth++;
    else if (!inQuote && ch === ">") angleDepth = Math.max(0, angleDepth - 1);
    if ((ch === "," || ch === ";") && !inQuote && angleDepth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  const out: string[] = [];
  for (const part of parts) {
    const address = extractAddress(part);
    if (address && !out.includes(address)) out.push(address);
  }
  return out;
}

export function isFromMailbox(from: string | null | undefined, mailboxAddress: string): boolean {
  const address = extractAddress(from);
  const mailbox = extractAddress(mailboxAddress) ?? mailboxAddress.trim().toLowerCase();
  return address !== null && address === mailbox;
}

/** Display name of `"Name" <a@b>` / `Name <a@b>`, lower-cased; null for bare addresses. */
function displayNameOf(value: string | null): string | null {
  if (!value) return null;
  const lt = value.indexOf("<");
  if (lt <= 0) return null;
  const name = value
    .slice(0, lt)
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .trim();
  return name === "" ? null : name.toLowerCase();
}

/* ─── Patterns ────────────────────────────────────────────────────────── */

const SENDING_LIMIT_SUBJECT = /reached a limit for sending mail/i;
const BLOCKED_SUBJECT = /^\s*message blocked\b/i;
// Checked before FAILURE: Sendmail's "Returned mail: Warning: could not send message for past 4 hours" is a delay.
const DELAY_SUBJECT = /\(delay\)|delivery delayed|delayed mail|warning: could not send message for past/i;
const FAILURE_SUBJECT =
  /delivery status notification \(failure\)|^\s*undeliverable\b|undelivered mail returned to sender|mail delivery failed|returned mail|failure notice/i;
// Delivery/relay receipts and recall reports come from the same system senders but are not bounces.
const NOT_A_BOUNCE_SUBJECT = /\((success|relay)\)|^\s*(delivered|relayed|expanded):|message recall/i;
const AUTO_REPLY_SUBJECT = /^\s*(automatic reply:|auto:|out of office|autoreply)/i;
const REPLY_PREFIX = /^\s*(re|aw|sv)\s*:\s*/i;
const UNSUBSCRIBE_SUBJECT = /^unsubscribe\b/i;
const STATUS_CODE = /\b([245]\.\d{1,3}\.\d{1,3})\b/;

const NDR_DISPLAY_NAMES = new Set(["mail delivery subsystem", "mail delivery system", "microsoft outlook"]);
const GOOGLE_NOTICE_DOMAINS = new Set(["google.com", "googlemail.com", "gmail.com"]);

type DsnSubjectClass = "blocked" | "delay" | "failure" | "not_bounce" | null;

function dsnSubjectClass(subject: string): DsnSubjectClass {
  if (NOT_A_BOUNCE_SUBJECT.test(subject)) return "not_bounce";
  if (BLOCKED_SUBJECT.test(subject)) return "blocked";
  if (DELAY_SUBJECT.test(subject)) return "delay";
  if (FAILURE_SUBJECT.test(subject)) return "failure";
  return null;
}

function stripReplyPrefixes(subject: string): string {
  let s = subject.trim();
  for (let i = 0; i < 10 && REPLY_PREFIX.test(s); i++) s = s.replace(REPLY_PREFIX, "");
  return s.trim();
}

/** A short, safe token for the basis string (header values are attacker-controlled). */
function safeToken(value: string): string {
  const token = value
    .toLowerCase()
    .split(";")[0]
    ?.trim()
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 40);
  return token ? token : "present";
}

function statusCodeFrom(headers: Record<string, string>): string | null {
  for (const name of ["diagnostic-code", "status"]) {
    const value = headers[name];
    if (!value) continue;
    const match = STATUS_CODE.exec(value)?.[1];
    if (match) return match;
  }
  return null;
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (out[key] === undefined) out[key] = value;
  }
  return out;
}

/* ─── Classification ──────────────────────────────────────────────────── */

export function classifyMessage(input: ClassifyInput): NormalizedSignal | null {
  const signal = (
    category: EventCategory,
    confidence: Confidence,
    basis: string[],
    counterpartyAddress: string | null = null,
    diagnosticCode: string | null = null,
    metadata: Record<string, unknown> = {},
  ): NormalizedSignal => ({
    providerMessageRef: input.providerMessageRef,
    category,
    occurredAt: input.occurredAt,
    counterpartyAddress,
    confidence,
    classificationBasis: basis.join(" + "),
    diagnosticCode,
    metadata,
  });

  if (input.direction === "outbound") {
    return signal("sent", "high", ["folder:sent"], null, null, { recipientCount: input.to.length });
  }

  const headers = normalizeHeaders(input.headers);
  const subject = (input.subject ?? "").trim();
  const fromAddress = extractAddress(input.from);
  // The mailbox's own copies (e.g. a note to self) are not deliverability events.
  if (fromAddress !== null && isFromMailbox(fromAddress, input.mailboxAddress)) return null;

  const at = fromAddress?.lastIndexOf("@") ?? -1;
  const localPart = fromAddress && at > 0 ? fromAddress.slice(0, at) : null;
  const domain = fromAddress && at > 0 ? fromAddress.slice(at + 1) : null;
  const displayName = displayNameOf(input.from);

  const contentType = (headers["content-type"] ?? "").toLowerCase();
  const isReport = /^\s*multipart\/report\b/.test(contentType);
  const reportType = isReport ? (/report-type\s*=\s*"?([a-z0-9._-]+)"?/.exec(contentType)?.[1] ?? null) : null;

  // 1. ARF feedback report (RFC 5965).
  if (isReport && reportType === "feedback-report") {
    return signal("complaint", "high", ["header:Content-Type report-type=feedback-report"]);
  }

  const isDaemonSender = localPart === "mailer-daemon" || localPart === "postmaster";
  const isGoogleNotice =
    fromAddress === "mail-noreply@google.com" ||
    (localPart === "mailer-daemon" && domain !== null && GOOGLE_NOTICE_DOMAINS.has(domain));

  // 2. Google sending-limit notice. (Exchange reports its limits inside NDR bodies; those stay bounces.)
  if (SENDING_LIMIT_SUBJECT.test(subject) && (isGoogleNotice || isDaemonSender)) {
    return isGoogleNotice
      ? signal("sending_limit", "high", ["sender:google-notice", "subject-pattern:sending-limit"])
      : signal("sending_limit", "medium", [`sender:${localPart ?? "system"}`, "subject-pattern:sending-limit"]);
  }

  // 3. DSN / NDR.
  const subjectClass = dsnSubjectClass(subject);
  const hasNdrSubject = subjectClass === "failure" || subjectClass === "delay" || subjectClass === "blocked";
  const isDsnReport = isReport && reportType === "delivery-status";
  // Exchange's system sender also sends quota warnings etc., so it needs an NDR subject too.
  const isExchangeNdr = localPart !== null && localPart.startsWith("microsoftexchange") && hasNdrSubject;
  const isNamedNdr = displayName !== null && NDR_DISPLAY_NAMES.has(displayName) && hasNdrSubject;

  if (isDsnReport || isDaemonSender || isExchangeNdr || isNamedNdr) {
    if (subjectClass === "not_bounce") return null;
    const senderBasis = isDsnReport
      ? "header:Content-Type report-type=delivery-status"
      : isDaemonSender
        ? `sender:${localPart}`
        : isExchangeNdr
          ? "sender:microsoft-exchange"
          : "sender-name:delivery-system";
    const failedRecipients = extractAddresses(headers["x-failed-recipients"]);
    const counterparty = failedRecipients[0] ?? null;
    const diagnostic = statusCodeFrom(headers);
    const basis = [senderBasis];
    const metadata: Record<string, unknown> = {};
    if (failedRecipients.length > 0) {
      basis.push("header:X-Failed-Recipients");
      metadata.failedRecipientCount = failedRecipients.length;
    }

    switch (subjectClass) {
      case "blocked":
        // Google refused to relay the message (policy), not a recipient-side bounce.
        return signal("provider_error", "medium", [...basis, "subject-pattern:message-blocked"], counterparty, diagnostic, metadata);
      case "delay":
        return signal("soft_bounce", "medium", [...basis, "subject-pattern:delivery-delayed"], counterparty, diagnostic, metadata);
      case "failure":
        return signal(
          "hard_bounce",
          counterparty !== null ? "high" : "medium",
          [...basis, "subject-pattern:delivery-failure"],
          counterparty,
          diagnostic,
          metadata,
        );
      default:
        if (diagnostic?.startsWith("5")) {
          return signal("hard_bounce", "medium", [...basis, "header:status-code"], counterparty, diagnostic, metadata);
        }
        if (diagnostic?.startsWith("4")) {
          return signal("soft_bounce", "medium", [...basis, "header:status-code"], counterparty, diagnostic, metadata);
        }
        if (diagnostic?.startsWith("2")) return null; // a success DSN
        return signal("bounce_unclassified", "low", basis, counterparty, null, metadata);
    }
  }

  // 4. Other machine-generated reports (read receipts, etc.): observed, but not classifiable.
  if (isReport) {
    return signal("unknown", "low", [`header:Content-Type report-type=${reportType ? safeToken(reportType) : "unspecified"}`]);
  }

  const hasReplyHeaders = Boolean(headers["in-reply-to"]?.trim() || headers["references"]?.trim());

  // 5. Auto-replies (RFC 3834 and common vendor headers). Never counted as replies.
  const autoSubmitted = headers["auto-submitted"]?.trim();
  const autoSubmittedToken = autoSubmitted ? safeToken(autoSubmitted) : null;
  const autoBasis: string[] = [];
  let strongAutoHeader = false;
  if (autoSubmittedToken && autoSubmittedToken !== "no") {
    autoBasis.push(`header:Auto-Submitted=${autoSubmittedToken}`);
    if (autoSubmittedToken === "auto-replied") strongAutoHeader = true;
  }
  const xAutoreply = headers["x-autoreply"]?.trim().toLowerCase();
  if (xAutoreply && xAutoreply !== "no" && xAutoreply !== "false") {
    autoBasis.push("header:X-Autoreply");
    strongAutoHeader = true;
  }
  const xAutorespond = headers["x-autorespond"]?.trim().toLowerCase();
  if (xAutorespond && xAutorespond !== "no" && xAutorespond !== "false") {
    autoBasis.push("header:X-Autorespond");
    strongAutoHeader = true;
  }
  if (headers["precedence"]?.trim().toLowerCase() === "auto_reply") {
    autoBasis.push("header:Precedence=auto_reply");
    strongAutoHeader = true;
  }
  const autoSubject = AUTO_REPLY_SUBJECT.test(subject);
  if (autoBasis.length > 0) {
    if (autoSubject) autoBasis.push("subject-pattern:auto-reply");
    // "auto-generated" alone also covers ordinary notifications; corroboration lifts it to high.
    const confidence: Confidence =
      strongAutoHeader || autoSubject || hasReplyHeaders || input.isReplyToOurThread === true ? "high" : "medium";
    return signal("auto_reply", confidence, autoBasis, fromAddress);
  }
  if (autoSubject) return signal("auto_reply", "medium", ["subject-pattern:auto-reply"], fromAddress);

  // 6. Unsubscribe request sent by email (mailto: List-Unsubscribe or a human writing "unsubscribe").
  if (UNSUBSCRIBE_SUBJECT.test(stripReplyPrefixes(subject))) {
    return signal("unsubscribe", "medium", ["subject-pattern:unsubscribe"], fromAddress);
  }

  // 7. Human reply.
  if (input.isReplyToOurThread === false) return null;
  if (hasReplyHeaders || input.isReplyToOurThread === true) {
    const basis: string[] = [];
    if (headers["in-reply-to"]?.trim()) basis.push("header:In-Reply-To");
    if (headers["references"]?.trim()) basis.push("header:References");
    if (input.isReplyToOurThread === true) basis.push("thread:contains-sent-message");
    const confidence: Confidence = hasReplyHeaders && input.isReplyToOurThread === true ? "high" : "medium";
    return signal("reply", confidence, basis, fromAddress);
  }

  return null;
}
