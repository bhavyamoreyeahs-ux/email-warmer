/**
 * Deterministic diagnosis engine — used when no AI model is configured, and as
 * the fallback when the model call fails. Produces the same structured shape
 * as the LLM path, from the same evidence, with explicit rule-based wording.
 * It is labelled "rules engine (no AI model)" everywhere it is shown.
 */
import type { Diagnosis, EvidenceItem } from "@/lib/ai/schema";

export const RULES_ENGINE_VERSION = "rules-2026.10.1";

const num = (v: unknown) => (typeof v === "number" ? v : null);

export function diagnoseWithRules(evidence: EvidenceItem[]): Diagnosis {
  const confirmed: Diagnosis["confirmedFindings"] = [];
  const hypotheses: Diagnosis["hypotheses"] = [];
  const recommendations: Diagnosis["recommendations"] = [];
  const insufficient: Diagnosis["insufficientEvidence"] = [];

  const checks = evidence.filter((e) => e.kind === "dns_check" && e.ref.startsWith("check:"));
  for (const c of checks) {
    const status = c.facts.status;
    const type = String(c.facts.checkType ?? "").toUpperCase();
    if (status === "fail") {
      confirmed.push({ statement: `${type} for ${c.facts.domain} is failing: ${c.facts.summary}`, evidenceRefs: [c.ref] });
      recommendations.push({
        action: `Fix the ${type} record for ${c.facts.domain} at your DNS host, then re-run the scan.`,
        rationale: "Failing authentication can cause receivers to reject or filter mail. QuikReach does not change DNS for you.",
        evidenceRefs: [c.ref],
        kind: "dns_change",
      });
    } else if (status === "warn") {
      confirmed.push({ statement: `${type} for ${c.facts.domain} has warnings: ${c.facts.summary}`, evidenceRefs: [c.ref] });
    } else if (status === "inconclusive") {
      insufficient.push({ question: `Is ${type} for ${c.facts.domain} correctly configured?`, missingData: String(c.facts.summary ?? "The check was inconclusive.") });
    }
  }
  if (!checks.length && evidence.some((e) => e.ref.startsWith("domain:"))) {
    insufficient.push({ question: "Is domain authentication configured?", missingData: "No completed DNS scan yet." });
  }

  for (const e of evidence.filter((x) => x.kind === "event_summary")) {
    const sent = num(e.facts.sent) ?? 0;
    const rate = num(e.facts.bounceRate);
    const connRef = e.ref.split(":").slice(0, 2).join(":").replace("events", "conn");
    if (sent < 20) {
      insufficient.push({ question: `What is the bounce rate for ${e.title.replace("Observed events for ", "").split(",")[0]}?`, missingData: `Only ${sent} provider-recorded sends in the window (minimum 20).` });
    } else if (rate !== null && rate >= 0.02) {
      confirmed.push({ statement: `Observed bounce rate is ${(rate * 100).toFixed(1)}% over ${sent} sends.`, evidenceRefs: [e.ref] });
      const dnsProblems = checks.filter((c) => c.facts.status === "fail" || c.facts.status === "warn");
      if (dnsProblems.length) {
        hypotheses.push({
          statement: "Authentication problems may be contributing to the bounces.",
          rationale: "DNS checks show failures or warnings, and some receivers reject unauthenticated mail. The bounce messages' SMTP details are not read by QuikReach, so this is not confirmed.",
          evidenceRefs: [e.ref, ...dnsProblems.map((c) => c.ref)],
          confidence: "medium",
        });
      }
      hypotheses.push({
        statement: "Recipient list quality may be contributing (invalid or stale addresses).",
        rationale: `Bounces concentrate in: ${(e.facts.topBouncingRecipientDomains as string[] | undefined)?.join(", ") || "unknown recipient domains"}. Hard-bounce share helps distinguish invalid addresses from temporary deferrals.`,
        evidenceRefs: [e.ref],
        confidence: "low",
      });
      recommendations.push({ action: "Remove hard-bounced addresses and validate the list before the next send.", rationale: "Repeated sends to invalid addresses can worsen outcomes.", evidenceRefs: [e.ref], kind: "list_hygiene" });
      recommendations.push({ action: "Reduce sending volume from this mailbox in your sending tool while you investigate.", rationale: "Limits further impact. QuikReach cannot do this unless a campaign integration is configured.", evidenceRefs: [e.ref], kind: "sending_change" });
    }
    if ((num(e.facts.providerErrors) ?? 0) + (num(e.facts.sendingLimitNotices) ?? 0) > 0) {
      confirmed.push({ statement: `Provider rejection or sending-limit notices were observed (${(num(e.facts.providerErrors) ?? 0) + (num(e.facts.sendingLimitNotices) ?? 0)}).`, evidenceRefs: [e.ref] });
    }
    if ((num(e.facts.complaints) ?? 0) > 0) confirmed.push({ statement: `${e.facts.complaints} complaint feedback report(s) observed.`, evidenceRefs: [e.ref] });
    void connRef;
  }

  for (const m of evidence.filter((x) => x.kind === "mailbox")) {
    if (m.facts.state === "reauth_required") {
      confirmed.push({ statement: `${m.title.split(" (")[0]} needs to be reconnected; monitoring is stopped for it.`, evidenceRefs: [m.ref] });
      recommendations.push({ action: "Reconnect the mailbox from the Mailboxes page.", rationale: String(m.facts.stateReason ?? "Access was revoked or expired."), evidenceRefs: [m.ref], kind: "mailbox_reconnect" });
    } else if (m.facts.state === "degraded") {
      confirmed.push({ statement: `${m.title.split(" (")[0]} is syncing with errors (${m.facts.lastErrorCode ?? "unknown error"}); its data may be stale.`, evidenceRefs: [m.ref] });
    }
  }
  for (const g of evidence.filter((x) => x.kind === "capability_gap")) {
    insufficient.push({ question: `Which signals are missing for ${g.title.replace("Signals not fully observable for ", "")}?`, missingData: Object.keys(g.facts).join(", ") });
  }
  insufficient.push({ question: "Are messages reaching recipients' inboxes?", missingData: "Inbox placement is not measured by QuikReach in this release." });

  const overallConfidence: Diagnosis["overallConfidence"] = confirmed.length >= 2 ? "medium" : confirmed.length === 1 ? "low" : "low";
  const summary = confirmed.length
    ? `Rules-based review found ${confirmed.length} confirmed issue(s) and ${hypotheses.length} hypothesis(es) from the available evidence. ${insufficient.length} question(s) cannot be answered with current data.`
    : `No confirmed issues were found in the available evidence. ${insufficient.length} question(s) cannot be answered with current data, so this is not a clean bill of health.`;
  return { summary, overallConfidence, confirmedFindings: confirmed, hypotheses, recommendations, insufficientEvidence: insufficient };
}
