/**
 * MX evaluation: can this domain receive mail (bounces, replies), and which
 * provider handles it?
 *
 * Covers null MX (RFC 7505), the implicit-MX fallback to A/AAAA when no MX
 * exists (RFC 5321 §5.1), and whether the lowest-priority exchanges resolve.
 * The detected provider also feeds the SPF/DKIM expectations in checker.ts.
 */
import {
  formatMxRecord,
  isEmptyOutcome,
  isUncertainOutcome,
  lookupFailureFinding,
  recordQueries,
  statusFromFindings,
  type CheckFinding,
  type CheckResult,
  type CheckStatus,
  type DnsAnswer,
  type DnsOutcome,
  type DnsResolver,
  type MxRecord,
} from "@/lib/dns/types";

export const MX_RULE_VERSION = "mx-2026.10.1";
/** How many of the lowest-priority exchanges get A/AAAA lookups. */
const MAX_TARGETS_TO_RESOLVE = 3;

export type MxProvider = "google" | "microsoft" | "other";

const PROVIDER_NAMES: Record<MxProvider, string> = {
  google: "Google Workspace",
  microsoft: "Microsoft 365",
  other: "another mail provider",
};

function hasSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** Provider for one exchange host (dot-boundary suffix match, so "notgoogle.com" is not Google). */
export function providerForExchange(exchange: string): MxProvider {
  const host = exchange.toLowerCase().replace(/\.$/, "");
  if (hasSuffix(host, "google.com") || hasSuffix(host, "googlemail.com")) return "google";
  // mx.microsoft is Microsoft 365's newer (DNSSEC-signed) MX namespace.
  if (hasSuffix(host, "mail.protection.outlook.com") || hasSuffix(host, "mx.microsoft")) return "microsoft";
  return "other";
}

export function sortMxRecords(records: readonly MxRecord[]): MxRecord[] {
  return [...records].sort((a, b) => a.priority - b.priority || a.exchange.localeCompare(b.exchange));
}

/** Provider of the most-preferred (lowest priority value) exchange, or null without usable MX records. */
export function detectMxProvider(records: readonly MxRecord[]): MxProvider | null {
  const primary = sortMxRecords(records).find((r) => r.exchange !== "" && r.exchange !== ".");
  return primary ? providerForExchange(primary.exchange) : null;
}

export interface MxResolvedTarget {
  exchange: string;
  a: string[];
  aaaa: string[];
  aOutcome: DnsOutcome;
  aaaaOutcome: DnsOutcome;
  resolved: boolean;
}

export interface EvaluateMxOptions {
  /**
   * An MX answer already in flight for this domain (the checker starts it
   * early to learn the provider); avoids querying twice.
   */
  mxAnswer?: Promise<DnsAnswer<MxRecord>>;
}

function isNullExchange(record: MxRecord): boolean {
  return record.exchange === "" || record.exchange === ".";
}

function summarize(domain: string, status: CheckStatus, findings: CheckFinding[], provider: MxProvider | null, count: number, primary: string | null): string {
  const codes = new Set(findings.map((f) => f.code));
  if (status === "inconclusive") return `Mail routing for ${domain} could not be checked because a DNS lookup did not complete.`;
  if (codes.has("mx_domain_not_found")) return `${domain} does not exist in DNS, so it cannot receive mail.`;
  if (codes.has("mx_missing")) return `${domain} has no MX records and no address records, so it cannot receive mail.`;
  if (codes.has("mx_null_mx")) return `${domain} publishes a null MX record, declaring that it accepts no mail.`;
  if (codes.has("mx_implicit_fallback")) {
    return `${domain} has no MX records, so senders fall back to its address record, which may not be set up to receive mail.`;
  }
  if (codes.has("mx_targets_unresolvable")) {
    return `${domain} has MX records, but none of the checked mail servers resolve to an address.`;
  }
  const handler = provider === "other" || provider === null ? (primary ?? PROVIDER_NAMES.other) : PROVIDER_NAMES[provider];
  const base = `Mail for ${domain} is handled by ${handler} (${count} MX record${count === 1 ? "" : "s"})`;
  if (status === "warn") return `${base}, but some settings need attention.`;
  return `${base}.`;
}

export async function evaluateMx(domain: string, resolver: DnsResolver, opts: EvaluateMxOptions = {}): Promise<CheckResult> {
  const started = performance.now();
  const recorder = recordQueries(resolver);
  const findings: CheckFinding[] = [];
  const finish = (status: CheckStatus, summary: string, parsed: Record<string, unknown>): CheckResult => ({
    checkType: "mx",
    status,
    summary,
    findings,
    evidence: { queries: recorder.queries, parsed },
    ruleVersion: MX_RULE_VERSION,
    resolver: resolver.label,
    durationMs: Math.round(performance.now() - started),
  });

  let answer: DnsAnswer<MxRecord>;
  if (opts.mxAnswer) {
    answer = await opts.mxAnswer;
    recorder.queries.push({
      name: domain,
      type: "MX",
      answers: answer.records.map(formatMxRecord),
      outcome: answer.outcome,
      durationMs: answer.durationMs,
    });
  } else {
    answer = await recorder.mx(domain);
  }

  if (isUncertainOutcome(answer.outcome)) {
    findings.push(lookupFailureFinding("mx", domain, answer.outcome));
    return finish("inconclusive", summarize(domain, "inconclusive", findings, null, 0, null), { records: [], provider: null });
  }

  if (answer.outcome === "NXDOMAIN") {
    findings.push({
      code: "mx_domain_not_found",
      severity: "error",
      message: `${domain} does not exist in DNS (NXDOMAIN).`,
      recommendation: "Check the domain spelling, and that the domain is registered and delegated to working nameservers.",
    });
    return finish("fail", summarize(domain, "fail", findings, null, 0, null), { records: [], provider: null });
  }

  if (answer.outcome === "NODATA" || answer.records.length === 0) {
    // RFC 5321 §5.1: with no MX, senders deliver to the domain's A/AAAA address.
    const [a, aaaa] = await Promise.all([recorder.a(domain), recorder.aaaa(domain)]);
    const parsed = { records: [], provider: null, implicitMx: { a: a.records, aaaa: aaaa.records } };
    if (a.records.length > 0 || aaaa.records.length > 0) {
      findings.push({
        code: "mx_implicit_fallback",
        severity: "warning",
        message: `${domain} has no MX records. Senders fall back to its address record (${[...a.records, ...aaaa.records].join(", ")}), which may not accept mail.`,
        recommendation: `Publish MX records for ${domain} pointing at your mail provider, or a null MX ("0 .") if it should never receive mail.`,
      });
      return finish("warn", summarize(domain, "warn", findings, null, 0, null), parsed);
    }
    if (isUncertainOutcome(a.outcome) || isUncertainOutcome(aaaa.outcome)) {
      findings.push(lookupFailureFinding("mx", domain, isUncertainOutcome(a.outcome) ? a.outcome : aaaa.outcome));
      return finish("inconclusive", summarize(domain, "inconclusive", findings, null, 0, null), parsed);
    }
    findings.push({
      code: "mx_missing",
      severity: "error",
      message: `${domain} has no MX records and no A/AAAA records, so bounces and replies to this domain cannot be delivered.`,
      recommendation: `Publish MX records for ${domain} pointing at your mail provider.`,
    });
    return finish("fail", summarize(domain, "fail", findings, null, 0, null), parsed);
  }

  const records = sortMxRecords(answer.records);
  const nullRecords = records.filter(isNullExchange);
  if (nullRecords.length > 0 && records.length === 1) {
    findings.push({
      code: "mx_null_mx",
      severity: "warning",
      message: `${domain} publishes a null MX record (RFC 7505): the domain declares it accepts no mail — bounces and replies to this domain cannot be received.`,
      recommendation: `If ${domain} sends mail, replace the null MX with MX records for your mail provider.`,
    });
    return finish("warn", summarize(domain, "warn", findings, null, 1, null), {
      records,
      provider: null,
      nullMx: true,
      resolvedTargets: [],
    });
  }
  if (nullRecords.length > 0) {
    findings.push({
      code: "mx_null_mx_with_others",
      severity: "warning",
      message: `${domain} mixes a null MX record (".") with other MX records; RFC 7505 requires a null MX to be the only one, so senders may behave unpredictably.`,
      recommendation: "Remove the null MX record if the domain receives mail, or remove the other MX records if it does not.",
    });
  }

  const provider = detectMxProvider(records);
  const exchanges = [...new Set(records.filter((r) => !isNullExchange(r)).map((r) => r.exchange))].slice(
    0,
    MAX_TARGETS_TO_RESOLVE,
  );
  const resolvedTargets: MxResolvedTarget[] = await Promise.all(
    exchanges.map(async (exchange) => {
      const [a, aaaa] = await Promise.all([recorder.a(exchange), recorder.aaaa(exchange)]);
      return {
        exchange,
        a: a.records,
        aaaa: aaaa.records,
        aOutcome: a.outcome,
        aaaaOutcome: aaaa.outcome,
        resolved: a.records.length > 0 || aaaa.records.length > 0,
      };
    }),
  );

  let uncertain = false;
  const unresolvedDefinitely = resolvedTargets.filter(
    (t) => !t.resolved && isEmptyOutcome(t.aOutcome) && isEmptyOutcome(t.aaaaOutcome),
  );
  if (!resolvedTargets.some((t) => t.resolved)) {
    if (unresolvedDefinitely.length === resolvedTargets.length) {
      findings.push({
        code: "mx_targets_unresolvable",
        severity: "warning",
        message: `None of the checked mail servers (${exchanges.join(", ")}) have an A or AAAA record, so senders cannot connect to deliver mail.`,
        recommendation: "Correct the MX records so they name your mail provider's servers exactly as documented.",
      });
    } else {
      uncertain = true;
      findings.push({
        code: "mx_targets_unverified",
        severity: "info",
        message: `Could not confirm that the mail servers (${exchanges.join(", ")}) resolve, because some lookups did not complete.`,
        recommendation: "Run the check again.",
      });
    }
  } else if (unresolvedDefinitely.length > 0) {
    findings.push({
      code: "mx_target_unresolvable",
      severity: "info",
      message: `Some mail servers have no A or AAAA record: ${unresolvedDefinitely.map((t) => t.exchange).join(", ")}. Senders skip them and use the others.`,
      recommendation: "Remove or correct MX records that point at names without addresses.",
    });
  }

  const status = statusFromFindings(findings, uncertain);
  const primary = records.find((r) => !isNullExchange(r))?.exchange ?? null;
  return finish(status, summarize(domain, status, findings, provider, records.length, primary), {
    records,
    provider,
    nullMx: false,
    resolvedTargets,
  });
}
