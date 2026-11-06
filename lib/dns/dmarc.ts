/**
 * DMARC (RFC 7489) parsing and evaluation.
 *
 * Policy discovery follows §6.6.3: query _dmarc.<domain>; if no DMARC record
 * is found there, fall back to _dmarc.<organizational domain> and report that
 * the policy is inherited (receivers then apply sp=, or p= when sp is absent).
 * For aggregate/failure report addresses at a different organizational
 * domain, the external-destination authorization record (§7.1) is checked.
 */
import { normalizeDomain, organizationalDomain } from "@/lib/dns/domain-name";
import {
  isUncertainOutcome,
  lookupFailureFinding,
  recordQueries,
  statusFromFindings,
  type CheckFinding,
  type CheckResult,
  type CheckStatus,
  type DnsResolver,
} from "@/lib/dns/types";

export const DMARC_RULE_VERSION = "dmarc-2026.10.1";

export type DmarcPolicy = "none" | "quarantine" | "reject";
export type DmarcAlignment = "r" | "s";

export interface DmarcReportUri {
  raw: string;
  scheme: string | null;
  /** mailto address (local@domain) when scheme is mailto. */
  address: string | null;
  /** Normalised destination domain for mailto URIs. */
  domain: string | null;
  valid: boolean;
  error?: string;
}

export interface DmarcIssue {
  code: string;
  severity: CheckFinding["severity"];
  message: string;
  recommendation?: string;
}

export interface ParsedDmarc {
  /** Tag names lowercased; first occurrence wins. */
  tags: Record<string, string>;
  tagOrder: string[];
  policy: DmarcPolicy | null;
  subdomainPolicy: DmarcPolicy | null;
  pct: number | null;
  rua: DmarcReportUri[];
  ruf: DmarcReportUri[];
  /** Effective modes: "r" when the tag is absent (the default), null when the value is invalid. */
  adkim: DmarcAlignment | null;
  aspf: DmarcAlignment | null;
  /** Problems found while parsing; errors make the record unusable. */
  issues: DmarcIssue[];
}

const POLICIES: readonly string[] = ["none", "quarantine", "reject"];

/** True for TXT strings that carry a v=DMARC1 tag anywhere (used to count candidate records). */
export function looksLikeDmarc(txt: string): boolean {
  return txt.split(";").some((part) => /^\s*v\s*=\s*dmarc1\s*$/i.test(part));
}

function parsePolicy(value: string | undefined): DmarcPolicy | null {
  const lower = value?.toLowerCase();
  return lower !== undefined && POLICIES.includes(lower) ? (lower as DmarcPolicy) : null;
}

function parseReportUri(raw: string): DmarcReportUri {
  const match = /^([a-z][a-z0-9+.-]*):(.+)$/i.exec(raw);
  if (!match) {
    return { raw, scheme: null, address: null, domain: null, valid: false, error: "missing a URI scheme such as mailto:" };
  }
  const scheme = (match[1] ?? "").toLowerCase();
  const rest = (match[2] ?? "").replace(/!\d+[kmgt]?$/i, ""); // optional size limit, e.g. !10m
  if (scheme !== "mailto") return { raw, scheme, address: null, domain: null, valid: true };
  let address: string;
  try {
    address = decodeURIComponent(rest.split("?", 1)[0] ?? "");
  } catch (error: unknown) {
    void error;
    return { raw, scheme, address: null, domain: null, valid: false, error: "contains invalid percent-encoding" };
  }
  const at = address.lastIndexOf("@");
  if (at <= 0) return { raw, scheme, address, domain: null, valid: false, error: "is not a valid email address" };
  const normalized = normalizeDomain(address.slice(at + 1));
  if (!normalized.ok) return { raw, scheme, address, domain: null, valid: false, error: "has an invalid domain" };
  return { raw, scheme, address, domain: normalized.domain, valid: true };
}

export function parseDmarc(record: string): ParsedDmarc {
  const issues: DmarcIssue[] = [];
  // Null prototype: tag names come from DNS, so "__proto__" must be an ordinary key.
  const tags = Object.create(null) as Record<string, string>;
  const tagOrder: string[] = [];

  for (const part of record.split(";")) {
    const piece = part.trim();
    if (piece === "") continue;
    const eq = piece.indexOf("=");
    if (eq === -1) {
      issues.push({
        code: "dmarc_malformed_tag",
        severity: "warning",
        message: `"${piece}" is not a valid DMARC tag (expected name=value).`,
        recommendation: "Remove or correct this part of the record; some receivers reject records with syntax errors.",
      });
      continue;
    }
    const name = piece.slice(0, eq).trim().toLowerCase();
    const value = piece.slice(eq + 1).trim();
    tagOrder.push(name);
    if (Object.hasOwn(tags, name)) {
      issues.push({
        code: "dmarc_duplicate_tag",
        severity: "warning",
        message: `The ${name}= tag appears more than once; receivers may use either value.`,
        recommendation: `Keep a single ${name}= tag.`,
      });
      continue;
    }
    tags[name] = value;
  }

  if (tagOrder[0] !== "v") {
    issues.push({
      code: "dmarc_version_not_first",
      severity: "error",
      message: "The record must start with v=DMARC1; receivers discard records where it is not the first tag.",
      recommendation: "Move v=DMARC1; to the start of the record.",
    });
  } else if (tags.v !== "DMARC1") {
    issues.push({
      code: "dmarc_invalid_version",
      severity: "error",
      message: `The version tag must be exactly "v=DMARC1" (found "v=${tags.v ?? ""}"); receivers discard the record otherwise.`,
      recommendation: "Start the record with v=DMARC1; followed by the other tags.",
    });
  }

  const policy = parsePolicy(tags.p);
  if (tags.p === undefined) {
    issues.push({
      code: "dmarc_policy_missing",
      severity: "error",
      message: "The record has no p= tag, which is required.",
      recommendation: "Add p=none to start monitoring, then move to p=quarantine or p=reject.",
    });
  } else if (policy === null) {
    issues.push({
      code: "dmarc_policy_invalid",
      severity: "error",
      message: `p=${tags.p} is not a valid policy; it must be none, quarantine or reject.`,
      recommendation: "Set p= to none, quarantine or reject.",
    });
  }

  const subdomainPolicy = parsePolicy(tags.sp);
  if (tags.sp !== undefined && subdomainPolicy === null) {
    issues.push({
      code: "dmarc_subdomain_policy_invalid",
      severity: "warning",
      message: `sp=${tags.sp} is not valid; it must be none, quarantine or reject.`,
      recommendation: "Correct sp= or remove it so subdomains use the p= policy.",
    });
  }

  let pct: number | null = null;
  if (tags.pct !== undefined) {
    if (/^\d{1,3}$/.test(tags.pct) && Number(tags.pct) <= 100) {
      pct = Number(tags.pct);
    } else {
      issues.push({
        code: "dmarc_pct_invalid",
        severity: "warning",
        message: `pct=${tags.pct} is not a whole number from 0 to 100.`,
        recommendation: "Remove pct= (the default is 100) or set it to a value from 0 to 100.",
      });
    }
  }

  const alignment = (tag: "adkim" | "aspf"): DmarcAlignment | null => {
    const value = tags[tag];
    if (value === undefined) return "r";
    const lower = value.toLowerCase();
    if (lower === "r" || lower === "s") return lower;
    issues.push({
      code: "dmarc_alignment_invalid",
      severity: "warning",
      message: `${tag}=${value} is not valid; it must be r (relaxed) or s (strict).`,
      recommendation: `Set ${tag}=r or ${tag}=s, or remove it to use relaxed alignment.`,
    });
    return null;
  };
  const adkim = alignment("adkim");
  const aspf = alignment("aspf");

  const uris = (tag: "rua" | "ruf"): DmarcReportUri[] =>
    tags[tag] === undefined
      ? []
      : (tags[tag] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
          .map(parseReportUri);

  return { tags, tagOrder, policy, subdomainPolicy, pct, rua: uris("rua"), ruf: uris("ruf"), adkim, aspf, issues };
}

function summarize(domain: string, status: CheckStatus, findings: CheckFinding[], policy: DmarcPolicy | null): string {
  if (status === "fail") {
    const code = findings.find((f) => f.severity === "error")?.code;
    if (code === "dmarc_missing") {
      return `No DMARC policy is published for ${domain}, so receivers get no instructions for mail that fails SPF and DKIM checks.`;
    }
    if (code === "dmarc_multiple_records") {
      return `${domain} publishes more than one DMARC record, so receivers ignore DMARC for this domain.`;
    }
    return `The DMARC record for ${domain} is invalid, so receivers may ignore it.`;
  }
  if (status === "inconclusive") {
    return `DMARC for ${domain} could not be fully checked because a DNS lookup did not complete.`;
  }
  if (policy === "none") {
    return `DMARC for ${domain} is in monitoring mode (p=none), so receivers are not asked to act on mail that fails authentication.`;
  }
  if (status === "warn") {
    const count = findings.filter((f) => f.severity === "warning").length;
    return `DMARC for ${domain} uses p=${policy ?? "?"}, but ${count} setting${count === 1 ? " needs" : "s need"} attention.`;
  }
  return `DMARC for ${domain} asks receivers to ${policy === "reject" ? "reject" : "quarantine"} mail that fails authentication.`;
}

const ALIGNMENT_NAMES = { adkim: "DKIM", aspf: "SPF" } as const;

export async function evaluateDmarc(domain: string, resolver: DnsResolver): Promise<CheckResult> {
  const started = performance.now();
  const recorder = recordQueries(resolver);
  const findings: CheckFinding[] = [];
  const finish = (status: CheckStatus, summary: string, parsed?: Record<string, unknown>): CheckResult => ({
    checkType: "dmarc",
    status,
    summary,
    findings,
    evidence: parsed ? { queries: recorder.queries, parsed } : { queries: recorder.queries },
    ruleVersion: DMARC_RULE_VERSION,
    resolver: resolver.label,
    durationMs: Math.round(performance.now() - started),
  });

  const directName = `_dmarc.${domain}`;
  const direct = await recorder.txt(directName);
  if (isUncertainOutcome(direct.outcome)) {
    findings.push(lookupFailureFinding("dmarc", directName, direct.outcome));
    return finish("inconclusive", summarize(domain, "inconclusive", findings, null));
  }

  let candidates = direct.records.filter(looksLikeDmarc);
  let policyDomain = domain;
  let inherited = false;
  const orgDomain = organizationalDomain(domain);
  if (candidates.length === 0 && orgDomain !== null && orgDomain !== domain) {
    const orgName = `_dmarc.${orgDomain}`;
    const fallback = await recorder.txt(orgName);
    if (isUncertainOutcome(fallback.outcome)) {
      findings.push(lookupFailureFinding("dmarc", orgName, fallback.outcome));
      return finish("inconclusive", summarize(domain, "inconclusive", findings, null), { policyDomain: null, inherited: false });
    }
    const orgCandidates = fallback.records.filter(looksLikeDmarc);
    if (orgCandidates.length > 0) {
      candidates = orgCandidates;
      policyDomain = orgDomain;
      inherited = true;
    }
  }

  if (candidates.length === 0) {
    findings.push({
      code: "dmarc_missing",
      severity: "error",
      message:
        orgDomain !== null && orgDomain !== domain
          ? `No DMARC record is published at ${directName} or at _dmarc.${orgDomain}.`
          : `No DMARC record is published at ${directName}.`,
      recommendation: `Publish a TXT record at _dmarc.${orgDomain ?? domain}, starting with monitoring: v=DMARC1; p=none; rua=mailto:dmarc-reports@${orgDomain ?? domain}`,
    });
    return finish("fail", summarize(domain, "fail", findings, null));
  }
  if (candidates.length > 1) {
    findings.push({
      code: "dmarc_multiple_records",
      severity: "error",
      message: `_dmarc.${policyDomain} has ${candidates.length} DMARC records. With more than one, receivers apply no DMARC policy (RFC 7489 §6.6.3).`,
      recommendation: "Merge them into a single TXT record that starts with v=DMARC1.",
    });
    return finish("fail", summarize(domain, "fail", findings, null), { records: candidates, policyDomain, inherited });
  }

  const record = candidates[0] ?? "";
  const parsed = parseDmarc(record);
  findings.push(...parsed.issues);
  const recordValid = !parsed.issues.some((i) => i.severity === "error");

  // A subdomain that inherits the organizational policy gets sp= (or p= when sp is absent).
  const effectivePolicy = inherited ? (parsed.subdomainPolicy ?? parsed.policy) : parsed.policy;
  if (inherited) {
    findings.push({
      code: "dmarc_policy_inherited",
      severity: "info",
      message: `${domain} has no DMARC record of its own; receivers apply the policy published at _dmarc.${policyDomain}${
        effectivePolicy ? ` (${parsed.subdomainPolicy ? "sp" : "p"}=${effectivePolicy} for subdomains)` : ""
      }.`,
    });
  } else if (parsed.subdomainPolicy !== null) {
    findings.push({
      code: "dmarc_subdomain_policy",
      severity: "info",
      message:
        parsed.subdomainPolicy === "none" && parsed.policy !== "none"
          ? `Subdomains of ${domain} use sp=none, so receivers are not asked to act on failing mail from subdomains.`
          : `Subdomains of ${domain} use sp=${parsed.subdomainPolicy}.`,
    });
  }

  if (recordValid && effectivePolicy === "none") {
    findings.push({
      code: "dmarc_policy_none",
      severity: "warning",
      message: "The policy is p=none (monitoring only): receivers report on failing mail but are not asked to quarantine or reject it.",
      recommendation: "Once reports show your legitimate mail passes SPF or DKIM alignment, move to p=quarantine and then p=reject.",
    });
  }
  if (recordValid && effectivePolicy !== "none" && parsed.pct !== null && parsed.pct < 100) {
    findings.push({
      code: "dmarc_pct_partial",
      severity: "warning",
      message: `pct=${parsed.pct}: the ${effectivePolicy} policy is applied to only ${parsed.pct}% of failing mail.`,
      recommendation: "Raise pct to 100 (or remove it) once you are confident in the policy.",
    });
  }

  if (parsed.rua.length === 0) {
    findings.push({
      code: "dmarc_no_rua",
      severity: "warning",
      message: "No rua= address is set, so you receive no aggregate reports showing who sends mail as this domain.",
      recommendation: `Add rua=mailto:<address> (for example rua=mailto:dmarc-reports@${policyDomain}) to receive daily aggregate reports.`,
    });
  }
  for (const [tag, uris] of [["rua", parsed.rua], ["ruf", parsed.ruf]] as const) {
    for (const uri of uris) {
      if (!uri.valid) {
        findings.push({
          code: "dmarc_malformed_report_uri",
          severity: "warning",
          message: `${tag}= entry "${uri.raw}" ${uri.error ?? "is malformed"}, so receivers cannot send reports to it.`,
          recommendation: `Use the form ${tag}=mailto:reports@example.com (separate several addresses with commas).`,
        });
      } else if (uri.scheme !== "mailto") {
        findings.push({
          code: "dmarc_report_uri_unsupported_scheme",
          severity: "info",
          message: `${tag}= entry "${uri.raw}" uses the ${uri.scheme ?? "?"}: scheme; most receivers only send reports to mailto: addresses.`,
        });
      }
    }
  }

  // External report destinations must opt in (RFC 7489 §7.1).
  const policyOrg = organizationalDomain(policyDomain) ?? policyDomain;
  const externalByDomain = new Map<string, Set<"rua" | "ruf">>();
  for (const [tag, uris] of [["rua", parsed.rua], ["ruf", parsed.ruf]] as const) {
    for (const uri of uris) {
      if (!uri.valid || uri.domain === null) continue;
      if ((organizationalDomain(uri.domain) ?? uri.domain) === policyOrg) continue;
      const tagsForDomain = externalByDomain.get(uri.domain) ?? new Set<"rua" | "ruf">();
      tagsForDomain.add(tag);
      externalByDomain.set(uri.domain, tagsForDomain);
    }
  }
  let uncertain = false;
  const authorizations = await Promise.all(
    [...externalByDomain].map(async ([destination, usedBy]) => {
      const name = `${policyDomain}._report._dmarc.${destination}`;
      const answer = await recorder.txt(name);
      const authorized = answer.records.some((r) => /^v\s*=\s*DMARC1(?:\s*;|\s*$)/i.test(r.trim()));
      const tagsText = [...usedBy].join("/");
      if (isUncertainOutcome(answer.outcome)) {
        uncertain = true;
        findings.push({
          code: "dmarc_external_report_unverified",
          severity: "info",
          message: `Could not check whether ${destination} accepts DMARC reports for ${policyDomain} (${answer.outcome} looking up ${name}).`,
          recommendation: "Run the check again.",
        });
      } else if (!authorized) {
        findings.push({
          code: "dmarc_external_report_unauthorized",
          severity: "warning",
          message: `The ${tagsText} address at ${destination} is outside ${policyOrg}, and ${destination} does not publish the authorization record ${name}. Receivers may not send reports there (RFC 7489 §7.1).`,
          recommendation: `Ask the operator of ${destination} to publish a TXT record "v=DMARC1" at ${name}, or use a reporting address at your own domain.`,
        });
      }
      return { destination, name, authorized, outcome: answer.outcome };
    }),
  );

  for (const tag of ["adkim", "aspf"] as const) {
    if (parsed[tag] === "s") {
      findings.push({
        code: "dmarc_strict_alignment",
        severity: "info",
        message: `${tag}=s: ${ALIGNMENT_NAMES[tag]} alignment is strict, so mail authenticated by a subdomain or parent domain of ${policyDomain} does not align.`,
      });
    }
  }

  const status = statusFromFindings(findings, uncertain);
  return finish(status, summarize(domain, status, findings, recordValid ? effectivePolicy : null), {
    record,
    tags: parsed.tags,
    policyDomain,
    inherited,
    policy: parsed.policy,
    subdomainPolicy: parsed.subdomainPolicy,
    effectivePolicy,
    pct: parsed.pct ?? 100,
    alignment: { adkim: parsed.adkim, aspf: parsed.aspf },
    rua: parsed.rua,
    ruf: parsed.ruf,
    externalReportAuthorizations: authorizations,
  });
}
