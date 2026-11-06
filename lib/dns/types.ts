/**
 * Contracts for the DNS / email-authentication checker.
 *
 * Everything in lib/dns is PURE with respect to the database: it takes a
 * resolver, returns results with evidence, and never writes anywhere. The
 * domains service (lib/domains/service.ts) persists results.
 */
import type { CheckEvidence, CheckFinding, CheckStatus, CheckType, DnsQueryEvidence } from "@/lib/db/schema";

export type DnsOutcome = "NOERROR" | "NXDOMAIN" | "NODATA" | "TIMEOUT" | "SERVFAIL" | "REFUSED" | "ERROR";

export interface DnsAnswer<T> {
  outcome: DnsOutcome;
  /** Empty unless outcome === "NOERROR". */
  records: T[];
  durationMs: number;
}

export interface MxRecord {
  exchange: string;
  priority: number;
}

/**
 * A resolver never throws. Failures are reported through `outcome` so that a
 * timeout becomes an INCONCLUSIVE check, never a "fail" and never a "pass".
 */
export interface DnsResolver {
  /** Human-readable identity recorded with every check, e.g. "system" or "1.1.1.1,8.8.8.8". */
  readonly label: string;
  /** TXT records with each record's character-strings joined (RFC 7208 §3.3). */
  txt(name: string): Promise<DnsAnswer<string>>;
  mx(name: string): Promise<DnsAnswer<MxRecord>>;
  a(name: string): Promise<DnsAnswer<string>>;
  aaaa(name: string): Promise<DnsAnswer<string>>;
}

export interface CheckResult {
  checkType: CheckType;
  status: CheckStatus;
  /** One sentence, plain language, no jargon-only output. */
  summary: string;
  findings: CheckFinding[];
  evidence: CheckEvidence;
  ruleVersion: string;
  resolver: string;
  durationMs: number;
}

export interface DkimSelectorInput {
  selector: string;
  /** customer = supplied by the user; provider_default = a well-known default we probe. */
  source: "customer" | "provider_default";
}

export interface DomainCheckOptions {
  /** Customer-supplied DKIM selectors. */
  dkimSelectors?: string[];
  /** Providers of mailboxes connected for this domain — used for expected SPF includes / default DKIM selectors. */
  mailboxProviders?: Array<"google" | "microsoft">;
  /** Overall budget for one check type, ms. */
  timeoutMs?: number;
}

export type { CheckEvidence, CheckFinding, CheckStatus, CheckType, DnsQueryEvidence };

/* ─── Shared runtime helpers (pure, no I/O) ─────────────────────────────
 * Added alongside the contract so every check module records evidence and
 * derives status the same way. No node-only imports here, so type-only
 * importers (UI) are unaffected. */

/** Outcomes that mean "we could not find out" — they lead to INCONCLUSIVE, never pass/fail. */
export function isUncertainOutcome(outcome: DnsOutcome): boolean {
  return outcome === "TIMEOUT" || outcome === "SERVFAIL" || outcome === "REFUSED" || outcome === "ERROR";
}

/** Outcomes that definitively mean "nothing is published here". */
export function isEmptyOutcome(outcome: DnsOutcome): boolean {
  return outcome === "NXDOMAIN" || outcome === "NODATA";
}

export function formatMxRecord(record: MxRecord): string {
  return `${record.priority} ${record.exchange === "" ? "." : record.exchange}`;
}

export function toQueryEvidence(
  name: string,
  type: DnsQueryEvidence["type"],
  answer: DnsAnswer<string> | DnsAnswer<MxRecord>,
): DnsQueryEvidence {
  const answers = (answer.records as Array<string | MxRecord>).map((record) =>
    typeof record === "string" ? record : formatMxRecord(record),
  );
  return { name, type, answers, outcome: answer.outcome, durationMs: answer.durationMs };
}

/** A resolver wrapper that records every query as evidence, in completion order. */
export interface RecordingResolver extends DnsResolver {
  readonly queries: DnsQueryEvidence[];
}

export function recordQueries(inner: DnsResolver): RecordingResolver {
  const queries: DnsQueryEvidence[] = [];
  const track = async <T extends string | MxRecord>(
    name: string,
    type: DnsQueryEvidence["type"],
    run: () => Promise<DnsAnswer<T>>,
  ): Promise<DnsAnswer<T>> => {
    const answer = await run();
    queries.push(toQueryEvidence(name, type, answer as DnsAnswer<string> | DnsAnswer<MxRecord>));
    return answer;
  };
  return {
    label: inner.label,
    queries,
    txt: (name) => track(name, "TXT", () => inner.txt(name)),
    mx: (name) => track(name, "MX", () => inner.mx(name)),
    a: (name) => track(name, "A", () => inner.a(name)),
    aaaa: (name) => track(name, "AAAA", () => inner.aaaa(name)),
  };
}

/**
 * Status from findings: any error → fail, any warning → warn, otherwise
 * inconclusive when something could not be determined, else pass.
 */
export function statusFromFindings(findings: readonly CheckFinding[], uncertain = false): CheckStatus {
  if (findings.some((f) => f.severity === "error")) return "fail";
  if (findings.some((f) => f.severity === "warning")) return "warn";
  return uncertain ? "inconclusive" : "pass";
}

/** Finding for a lookup that did not complete (TIMEOUT/SERVFAIL/REFUSED/ERROR). */
export function lookupFailureFinding(codePrefix: string, name: string, outcome: DnsOutcome): CheckFinding {
  if (outcome === "TIMEOUT") {
    return {
      code: `${codePrefix}_lookup_timeout`,
      severity: "info",
      message: `The DNS lookup for ${name} timed out, so this could not be checked.`,
      recommendation: "Run the check again. If it keeps timing out, confirm the domain's nameservers are reachable.",
    };
  }
  if (outcome === "SERVFAIL" || outcome === "REFUSED") {
    return {
      code: `${codePrefix}_lookup_failed`,
      severity: "info",
      message: `The DNS lookup for ${name} failed (${outcome}), so this could not be checked.`,
      recommendation:
        "Run the check again. A persistent SERVFAIL or REFUSED usually points to a nameserver or DNSSEC problem at your DNS host.",
    };
  }
  return {
    code: `${codePrefix}_lookup_error`,
    severity: "info",
    message: `The DNS lookup for ${name} could not be completed (${outcome}), so this could not be checked.`,
    recommendation: "Run the check again.",
  };
}
