/**
 * SPF (RFC 7208) parsing and evaluation.
 *
 * parseSpf is a pure syntax parser. evaluateSpf fetches the domain's SPF
 * record and walks it the way a receiver would to find problems that only
 * show up at evaluation time:
 *   - includes and redirect= are resolved recursively (depth ≤ 10, cycle-safe),
 *   - every DNS-querying term (include, a, mx, ptr, exists, redirect) is
 *     counted against the 10-lookup limit (§4.6.4) across the whole tree,
 *   - a/mx targets are queried (A, MX) so void lookups (§4.6.4) can be counted.
 *     ptr and exists depend on the connecting IP / macros and are counted but
 *     not queried.
 * Any include/redirect that cannot be resolved (timeout, SERVFAIL) makes the
 * lookup count a lower bound and prevents a "pass".
 */
import { isIPv4, isIPv6 } from "node:net";
import {
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

export const SPF_RULE_VERSION = "spf-2026.10.1";
export const SPF_LOOKUP_LIMIT = 10;
export const SPF_VOID_LOOKUP_LIMIT = 2;
const MAX_INCLUDE_DEPTH = 10;
/** Far past the limit already; stop walking so a hostile include tree cannot fan out without bound. */
const TRACE_LOOKUP_CAP = 40;

/** The include each mailbox provider documents for authorising its servers. */
export const SPF_INCLUDE_BY_PROVIDER = {
  google: "_spf.google.com",
  microsoft: "spf.protection.outlook.com",
} as const;

const PROVIDER_NAME_BY_INCLUDE: Record<string, string> = {
  "_spf.google.com": "Google Workspace",
  "spf.protection.outlook.com": "Microsoft 365",
};

export function expectedSpfIncludesFor(providers: Iterable<keyof typeof SPF_INCLUDE_BY_PROVIDER>): string[] {
  const includes = new Set<string>();
  for (const provider of providers) includes.add(SPF_INCLUDE_BY_PROVIDER[provider]);
  return [...includes];
}

/* ─── Parsing ──────────────────────────────────────────────────────────── */

export type SpfQualifier = "+" | "-" | "~" | "?";
export const SPF_MECHANISMS = ["all", "include", "a", "mx", "ptr", "ip4", "ip6", "exists"] as const;
export type SpfMechanismName = (typeof SPF_MECHANISMS)[number];

export interface SpfMechanismTerm {
  kind: "mechanism";
  raw: string;
  qualifier: SpfQualifier;
  mechanism: SpfMechanismName;
  /** domain-spec (include/a/mx/ptr/exists) or network address (ip4/ip6); null when absent. */
  value: string | null;
  cidr4: number | null;
  cidr6: number | null;
}

export interface SpfModifierTerm {
  kind: "modifier";
  raw: string;
  /** Lowercased. redirect and exp are defined by RFC 7208; others are ignored by receivers. */
  name: string;
  value: string;
}

export type SpfTerm = SpfMechanismTerm | SpfModifierTerm;

export interface ParsedSpf {
  terms: SpfTerm[];
  /** Syntax errors; any error makes receivers return permerror. */
  errors: string[];
}

/** True for TXT strings that are SPF records ("v=spf1" followed by a space or the end). */
export function isSpfRecord(txt: string): boolean {
  return /^v=spf1(?:\s|$)/i.test(txt);
}

const DNS_LOOKUP_MECHANISMS: ReadonlySet<SpfMechanismName> = new Set(["include", "a", "mx", "ptr", "exists"]);

function isMechanismName(name: string): name is SpfMechanismName {
  return (SPF_MECHANISMS as readonly string[]).includes(name);
}

export function hasSpfMacro(spec: string): boolean {
  return spec.includes("%{");
}

function parseCidr(text: string, max: number): number | null {
  if (!/^(?:0|[1-9][0-9]{0,2})$/.test(text)) return null;
  const value = Number(text);
  return value <= max ? value : null;
}

/** Returns a description of what is wrong with a domain-spec, or null if it is acceptable. */
function domainSpecProblem(spec: string): string | null {
  if (spec === "") return "the domain is empty.";
  let hasMacro = false;
  for (let i = 0; i < spec.length; i++) {
    const ch = spec.charAt(i);
    if (ch === "%") {
      const next = spec.charAt(i + 1);
      if (next === "%" || next === "_" || next === "-") {
        i++;
        continue;
      }
      if (next === "{") {
        const close = spec.indexOf("}", i);
        if (close === -1) return "it contains an unterminated macro.";
        const body = spec.slice(i + 2, close);
        if (!/^[slodiphcrtv][0-9]*r?[.\-+,/_=]*$/i.test(body)) return `it contains an invalid macro "%{${body}}".`;
        hasMacro = true;
        i = close;
        continue;
      }
      return "it contains a stray % character (write %% for a literal percent sign).";
    }
    const code = ch.charCodeAt(0);
    if (code < 0x21 || code > 0x7e) return "it contains characters that are not allowed.";
  }
  if (hasMacro) return null; // the expanded name depends on the message; nothing more to check statically
  const name = spec.replace(/\.$/, "");
  if (name.length > 253) return "the domain is longer than 253 characters.";
  const labels = name.split(".");
  if (labels.length < 2) return "it is not a fully qualified domain name.";
  if (labels.some((label) => label === "" || label.length > 63)) return "it is not a valid domain name.";
  const top = labels[labels.length - 1] ?? "";
  if (!/^[a-z0-9-]+$/i.test(top) || /^[0-9-]+$/.test(top) || top.startsWith("-") || top.endsWith("-")) {
    return "it does not end in a valid top-level domain.";
  }
  return null;
}

function parseMechanism(raw: string, errors: string[]): SpfMechanismTerm | null {
  const match = /^([+\-~?]?)([a-z][a-z0-9]*)(.*)$/i.exec(raw);
  if (!match) {
    errors.push(`"${raw}" is not a valid SPF term.`);
    return null;
  }
  const qualifier = (match[1] || "+") as SpfQualifier;
  const name = (match[2] ?? "").toLowerCase();
  const rest = match[3] ?? "";
  if (!isMechanismName(name)) {
    errors.push(`"${raw}" uses an unknown mechanism "${name}".`);
    return null;
  }
  const term: SpfMechanismTerm = { kind: "mechanism", raw, qualifier, mechanism: name, value: null, cidr4: null, cidr6: null };
  const domainSpec = (spec: string) => {
    term.value = spec;
    const problem = domainSpecProblem(spec);
    if (problem) errors.push(`"${raw}": ${problem}`);
  };

  switch (name) {
    case "all":
      if (rest !== "") errors.push(`"${raw}": the all mechanism takes no value.`);
      break;
    case "include":
    case "exists":
      if (!rest.startsWith(":") || rest.length === 1) {
        errors.push(`"${raw}": ${name} needs a domain, for example ${name}:example.com.`);
      } else {
        domainSpec(rest.slice(1));
      }
      break;
    case "ptr":
      if (rest === "") break;
      if (!rest.startsWith(":") || rest.length === 1) errors.push(`"${raw}": invalid ptr syntax.`);
      else domainSpec(rest.slice(1));
      break;
    case "a":
    case "mx": {
      const parts = /^(?::([^/]*))?(?:\/([0-9]+))?(?:\/\/([0-9]+))?$/.exec(rest);
      if (!parts) {
        errors.push(`"${raw}": invalid ${name} syntax.`);
        break;
      }
      if (parts[1] !== undefined) {
        if (parts[1] === "") errors.push(`"${raw}": the domain after "${name}:" is empty.`);
        else domainSpec(parts[1]);
      }
      if (parts[2] !== undefined) {
        term.cidr4 = parseCidr(parts[2], 32);
        if (term.cidr4 === null) errors.push(`"${raw}": IPv4 prefix length must be 0–32.`);
      }
      if (parts[3] !== undefined) {
        term.cidr6 = parseCidr(parts[3], 128);
        if (term.cidr6 === null) errors.push(`"${raw}": IPv6 prefix length must be 0–128.`);
      }
      break;
    }
    case "ip4":
    case "ip6": {
      const isV4 = name === "ip4";
      if (!rest.startsWith(":") || rest.length === 1) {
        errors.push(`"${raw}": ${name} needs an address, for example ${isV4 ? "ip4:192.0.2.0/24" : "ip6:2001:db8::/32"}.`);
        break;
      }
      const [address = "", prefix, ...extra] = rest.slice(1).split("/");
      term.value = address;
      if (extra.length > 0 || !(isV4 ? isIPv4(address) : isIPv6(address))) {
        errors.push(`"${raw}": "${rest.slice(1)}" is not a valid ${isV4 ? "IPv4" : "IPv6"} address or network.`);
        break;
      }
      if (prefix !== undefined) {
        const max = isV4 ? 32 : 128;
        const value = parseCidr(prefix, max);
        if (value === null) errors.push(`"${raw}": prefix length must be 0–${max}.`);
        if (isV4) term.cidr4 = value;
        else term.cidr6 = value;
      }
      break;
    }
  }
  return term;
}

export function parseSpf(record: string): ParsedSpf {
  const terms: SpfTerm[] = [];
  const errors: string[] = [];
  if (!isSpfRecord(record)) return { terms, errors: ["The record does not start with v=spf1."] };

  const seenModifiers = new Set<string>();
  for (const raw of record.slice("v=spf1".length).split(/\s+/)) {
    if (raw === "") continue;
    const modifier = /^([a-z][a-z0-9_.-]*)=(.*)$/i.exec(raw);
    if (modifier) {
      const name = (modifier[1] ?? "").toLowerCase();
      const value = modifier[2] ?? "";
      if (name === "redirect" || name === "exp") {
        if (seenModifiers.has(name)) errors.push(`The ${name}= modifier appears more than once.`);
        seenModifiers.add(name);
        const problem = domainSpecProblem(value);
        if (problem) errors.push(`"${raw}": ${problem}`);
      }
      terms.push({ kind: "modifier", raw, name, value });
      continue;
    }
    const term = parseMechanism(raw, errors);
    if (term) terms.push(term);
  }
  return { terms, errors };
}

function mechanisms(parsed: ParsedSpf): SpfMechanismTerm[] {
  return parsed.terms.filter((t): t is SpfMechanismTerm => t.kind === "mechanism");
}

/** The redirect= modifier that receivers will actually follow (ignored when an all mechanism is present, §6.1). */
function effectiveRedirect(parsed: ParsedSpf): SpfModifierTerm | undefined {
  if (mechanisms(parsed).some((m) => m.mechanism === "all")) return undefined;
  return parsed.terms.find((t): t is SpfModifierTerm => t.kind === "modifier" && t.name === "redirect");
}

/** DNS-querying terms in one record (not counting nested records). */
export function countLookupTerms(parsed: ParsedSpf): number {
  const direct = mechanisms(parsed).filter((m) => DNS_LOOKUP_MECHANISMS.has(m.mechanism)).length;
  return direct + (effectiveRedirect(parsed) ? 1 : 0);
}

/* ─── Evaluation ───────────────────────────────────────────────────────── */

/** "unknown" = decided by a redirect target that could not be resolved. */
export type SpfEffectiveAll = SpfQualifier | null | "unknown";

export interface SpfIncludeNode {
  domain: string;
  via: "root" | "include" | "redirect";
  status: "ok" | "unresolved" | "missing" | "multiple" | "invalid" | "loop" | "truncated" | "macro";
  outcome?: DnsOutcome;
  record?: string;
  /** DNS-querying terms in this record itself. */
  lookups: number;
  /** The record's effective all qualifier (following its redirect). Only meaningful for the root/redirect chain. */
  all?: SpfEffectiveAll;
  children: SpfIncludeNode[];
}

export interface EvaluateSpfOptions {
  /** Includes the domain's mailbox providers require, e.g. "_spf.google.com". */
  expectedIncludes?: string[];
}

interface WalkContext {
  resolver: DnsResolver;
  txtCache: Map<string, Promise<DnsAnswer<string>>>;
  aCache: Map<string, Promise<DnsAnswer<string>>>;
  mxCache: Map<string, Promise<DnsAnswer<MxRecord>>>;
  lookupCount: number;
  voidLookups: number;
  unresolved: Map<string, DnsOutcome>;
  /** include/redirect targets containing macros: their nested lookups cannot be counted. */
  macroTargets: Set<string>;
  ptrDomains: Set<string>;
  truncated: boolean;
  findings: Map<string, CheckFinding>;
}

function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let pending = cache.get(key);
  if (!pending) {
    pending = load();
    cache.set(key, pending);
  }
  return pending;
}

function addFinding(ctx: WalkContext, finding: CheckFinding): void {
  ctx.findings.set(`${finding.code}|${finding.message}`, finding);
}

function normalizeTarget(spec: string): string {
  return spec.toLowerCase().replace(/\.$/, "");
}

async function probeA(ctx: WalkContext, target: string): Promise<void> {
  const answer = await cached(ctx.aCache, target, () => ctx.resolver.a(target));
  if (isEmptyOutcome(answer.outcome)) ctx.voidLookups++;
}

async function probeMx(ctx: WalkContext, target: string, raw: string): Promise<void> {
  const answer = await cached(ctx.mxCache, target, () => ctx.resolver.mx(target));
  if (isEmptyOutcome(answer.outcome)) ctx.voidLookups++;
  if (answer.records.length > 10) {
    addFinding(ctx, {
      code: "spf_mx_too_many_records",
      severity: "error",
      message: `"${raw}" refers to ${target}, which has ${answer.records.length} MX records. Receivers stop at 10 and return a permanent error (RFC 7208 §4.6.4).`,
      recommendation: `Replace "${raw}" with ip4:/ip6: ranges or an include for the servers that actually send mail.`,
    });
  }
}

async function walkRecord(
  ctx: WalkContext,
  domain: string,
  parsed: ParsedSpf,
  depth: number,
  ancestors: readonly string[],
): Promise<{ children: SpfIncludeNode[]; effectiveAll: SpfEffectiveAll }> {
  const terms = mechanisms(parsed);
  const includeTasks: Array<Promise<SpfIncludeNode>> = [];
  const probes: Array<Promise<void>> = [];

  for (const term of terms) {
    if (!DNS_LOOKUP_MECHANISMS.has(term.mechanism)) continue;
    ctx.lookupCount++;
    if (term.mechanism === "ptr") {
      ctx.ptrDomains.add(domain);
      continue;
    }
    const spec = term.value;
    // Macro targets expand per message. For a/mx/exists that only hides void
    // lookups; for include it hides the nested record's lookups too.
    if (spec !== null && hasSpfMacro(spec)) {
      if (term.mechanism === "include") {
        ctx.macroTargets.add(term.raw);
        includeTasks.push(Promise.resolve({ domain: spec, via: "include", status: "macro", lookups: 0, children: [] }));
      }
      continue;
    }
    const target = normalizeTarget(spec ?? domain);
    if (term.mechanism === "include") includeTasks.push(followTarget(ctx, target, "include", depth, ancestors));
    else if (term.mechanism === "a") probes.push(probeA(ctx, target));
    else if (term.mechanism === "mx") probes.push(probeMx(ctx, target, term.raw));
  }

  const redirect = effectiveRedirect(parsed);
  let redirectTask: Promise<SpfIncludeNode> | undefined;
  if (redirect) {
    ctx.lookupCount++;
    if (hasSpfMacro(redirect.value)) {
      ctx.macroTargets.add(redirect.raw);
      redirectTask = Promise.resolve({ domain: redirect.value, via: "redirect", status: "macro", lookups: 0, children: [] });
    } else {
      redirectTask = followTarget(ctx, normalizeTarget(redirect.value), "redirect", depth, ancestors);
    }
  }

  const [children] = await Promise.all([Promise.all(includeTasks), Promise.all(probes)]);
  const allTerm = terms.find((t) => t.mechanism === "all");
  let effectiveAll: SpfEffectiveAll = allTerm ? allTerm.qualifier : null;
  if (redirectTask) {
    const node = await redirectTask;
    children.push(node);
    effectiveAll = node.status === "ok" ? (node.all ?? null) : "unknown";
  }
  return { children, effectiveAll };
}

async function followTarget(
  ctx: WalkContext,
  target: string,
  via: "include" | "redirect",
  depth: number,
  ancestors: readonly string[],
): Promise<SpfIncludeNode> {
  const term = via === "include" ? `include:${target}` : `redirect=${target}`;
  if (ancestors.includes(target)) {
    addFinding(ctx, {
      code: "spf_include_loop",
      severity: "error",
      message: `${term} loops back to a record that is already being evaluated (${[...ancestors, target].join(" → ")}). Receivers that reach it exceed the ${SPF_LOOKUP_LIMIT}-lookup limit and return a permanent error.`,
      recommendation: `Remove ${term} from the record at ${ancestors[ancestors.length - 1] ?? target} so the chain does not repeat.`,
    });
    return { domain: target, via, status: "loop", lookups: 0, children: [] };
  }
  if (depth >= MAX_INCLUDE_DEPTH || ctx.lookupCount > TRACE_LOOKUP_CAP) {
    ctx.truncated = true;
    return { domain: target, via, status: "truncated", lookups: 0, children: [] };
  }

  const answer = await cached(ctx.txtCache, target, () => ctx.resolver.txt(target));
  if (isUncertainOutcome(answer.outcome)) {
    ctx.unresolved.set(target, answer.outcome);
    return { domain: target, via, status: "unresolved", outcome: answer.outcome, lookups: 0, children: [] };
  }
  const code = via === "include" ? "spf_include" : "spf_redirect";
  if (isEmptyOutcome(answer.outcome)) ctx.voidLookups++;
  const spfRecords = answer.records.filter(isSpfRecord);
  if (spfRecords.length === 0) {
    addFinding(ctx, {
      code: `${code}_no_record`,
      severity: "error",
      message:
        answer.outcome === "NXDOMAIN"
          ? `${term} points to a domain that does not exist. Receivers that evaluate it return a permanent error.`
          : `${term} points to a domain with no SPF record. Receivers that evaluate it return a permanent error.`,
      recommendation: `Check the spelling of ${target} with your mail provider, or remove ${term} if that service no longer sends your mail.`,
    });
    return { domain: target, via, status: "missing", outcome: answer.outcome, lookups: 0, children: [] };
  }
  if (spfRecords.length > 1) {
    addFinding(ctx, {
      code: `${code}_multiple_records`,
      severity: "error",
      message: `${target} (reached via ${term}) publishes more than one SPF record, which receivers treat as a permanent error.`,
      recommendation: `Contact the operator of ${target}; it is outside your domain's own SPF record.`,
    });
    return { domain: target, via, status: "multiple", outcome: answer.outcome, lookups: 0, children: [] };
  }

  const record = spfRecords[0] ?? "";
  const parsed = parseSpf(record);
  if (parsed.errors.length > 0) {
    addFinding(ctx, {
      code: `${code}_invalid`,
      severity: "error",
      message: `The SPF record at ${target} (reached via ${term}) has syntax errors: ${parsed.errors.join(" ")}`,
      recommendation: `Fix the record at ${target}, or remove ${term} if you do not control it and it is no longer needed.`,
    });
    return { domain: target, via, status: "invalid", outcome: answer.outcome, record, lookups: 0, children: [] };
  }

  const walked = await walkRecord(ctx, target, parsed, depth + 1, [...ancestors, target]);
  return {
    domain: target,
    via,
    status: "ok",
    outcome: answer.outcome,
    record,
    lookups: countLookupTerms(parsed),
    all: walked.effectiveAll,
    children: walked.children,
  };
}

function treeDomains(node: SpfIncludeNode, into = new Set<string>()): Set<string> {
  for (const child of node.children) {
    if (child.status !== "macro") into.add(child.domain);
    treeDomains(child, into);
  }
  return into;
}

function exampleRecord(expectedIncludes: readonly string[]): string {
  return ["v=spf1", ...expectedIncludes.map((i) => `include:${i}`), "~all"].join(" ");
}

function summarize(domain: string, status: CheckStatus, findings: CheckFinding[], lookups: number): string {
  if (status === "fail") {
    const code = findings.find((f) => f.severity === "error")?.code;
    if (code === "spf_missing") return `No SPF record is published for ${domain}, so receivers cannot tell which servers may send its mail.`;
    if (code === "spf_multiple_records") return `${domain} publishes more than one SPF record, which receivers treat as a permanent error.`;
    if (code === "spf_allows_all") return `The SPF record for ${domain} authorises every server on the internet to send its mail.`;
    if (code === "spf_too_many_lookups") {
      return `The SPF record for ${domain} needs more than ${SPF_LOOKUP_LIMIT} DNS lookups, so receivers may return a permanent error instead of a result.`;
    }
    return `The SPF record for ${domain} has errors that cause receivers to return a permanent error (permerror).`;
  }
  if (status === "warn") {
    const count = findings.filter((f) => f.severity === "warning").length;
    return `${domain} has an SPF record, but ${count} issue${count === 1 ? "" : "s"} could weaken how receivers evaluate it.`;
  }
  if (status === "inconclusive") {
    return `${domain} has an SPF record, but part of it could not be resolved, so it could not be fully evaluated.`;
  }
  return `${domain} has a valid SPF record that uses ${lookups} of the ${SPF_LOOKUP_LIMIT} allowed DNS lookups.`;
}

export async function evaluateSpf(
  domain: string,
  resolver: DnsResolver,
  opts: EvaluateSpfOptions = {},
): Promise<CheckResult> {
  const started = performance.now();
  const recorder = recordQueries(resolver);
  const findings: CheckFinding[] = [];
  const expectedIncludes = [...new Set((opts.expectedIncludes ?? []).map(normalizeTarget))];
  const finish = (status: CheckStatus, summary: string, parsed?: Record<string, unknown>): CheckResult => ({
    checkType: "spf",
    status,
    summary,
    findings,
    evidence: parsed ? { queries: recorder.queries, parsed } : { queries: recorder.queries },
    ruleVersion: SPF_RULE_VERSION,
    resolver: resolver.label,
    durationMs: Math.round(performance.now() - started),
  });

  const answer = await recorder.txt(domain);
  if (isUncertainOutcome(answer.outcome)) {
    findings.push(lookupFailureFinding("spf", domain, answer.outcome));
    return finish("inconclusive", `SPF for ${domain} could not be checked because the DNS lookup did not complete.`);
  }

  const spfRecords = answer.records.filter(isSpfRecord);
  if (spfRecords.length === 0) {
    findings.push({
      code: "spf_missing",
      severity: "error",
      message:
        answer.outcome === "NXDOMAIN"
          ? `${domain} does not exist in DNS, so it has no SPF record.`
          : `No TXT record starting with v=spf1 is published at ${domain}.`,
      recommendation: `Publish one TXT record at ${domain} listing the services that send its mail, for example: ${exampleRecord(expectedIncludes)}`,
    });
    return finish("fail", summarize(domain, "fail", findings, 0));
  }
  if (spfRecords.length > 1) {
    findings.push({
      code: "spf_multiple_records",
      severity: "error",
      message: `${domain} publishes ${spfRecords.length} SPF records. RFC 7208 allows only one, so receivers return a permanent error (permerror).`,
      recommendation: "Merge the records into a single TXT record that starts with v=spf1 and contains every include and ip4/ip6 term you need.",
    });
    return finish("fail", summarize(domain, "fail", findings, 0), { records: spfRecords });
  }

  const record = spfRecords[0] ?? "";
  const parsed = parseSpf(record);
  if (parsed.errors.length > 0) {
    findings.push({
      code: "spf_syntax_error",
      severity: "error",
      message: `The SPF record has syntax errors, so receivers return a permanent error: ${parsed.errors.join(" ")}`,
      recommendation: "Correct the listed terms in the TXT record at your DNS host.",
    });
    return finish("fail", summarize(domain, "fail", findings, 0), { record, terms: parsed.terms, errors: parsed.errors });
  }

  const ctx: WalkContext = {
    resolver: recorder,
    txtCache: new Map([[domain, Promise.resolve(answer)]]),
    aCache: new Map(),
    mxCache: new Map(),
    lookupCount: 0,
    voidLookups: 0,
    unresolved: new Map(),
    macroTargets: new Set(),
    ptrDomains: new Set(),
    truncated: false,
    findings: new Map(),
  };
  const walked = await walkRecord(ctx, domain, parsed, 0, [domain]);
  const tree: SpfIncludeNode = {
    domain,
    via: "root",
    status: "ok",
    outcome: answer.outcome,
    record,
    lookups: countLookupTerms(parsed),
    all: walked.effectiveAll,
    children: walked.children,
  };
  findings.push(...ctx.findings.values());

  // The "all" policy, following redirect= when the record has no all of its own.
  const effectiveAll = walked.effectiveAll;
  const rootTerms = mechanisms(parsed);
  const allIndex = rootTerms.findIndex((t) => t.mechanism === "all");
  const allRaw = rootTerms[allIndex]?.raw ?? (effectiveAll === "+" ? "+all" : `${effectiveAll ?? ""}all`);
  if (effectiveAll === "+") {
    findings.push({
      code: "spf_allows_all",
      severity: "error",
      message: `The SPF policy ends in "${allRaw}", which authorises every server on the internet to send mail as ${domain}.`,
      recommendation: `Replace "${allRaw}" with "~all" or "-all" after listing your real sending services.`,
    });
  } else if (effectiveAll === "?") {
    findings.push({
      code: "spf_neutral_all",
      severity: "warning",
      message: `The SPF policy ends in "?all" (neutral), so receivers get no guidance about servers that are not listed.`,
      recommendation: `Use "~all" (or "-all" once every sender is listed) so unlisted servers are marked as not authorised.`,
    });
  } else if (effectiveAll === "~") {
    findings.push({
      code: "spf_softfail_all",
      severity: "info",
      message: `The SPF policy ends in "~all" (soft fail). This is a common, acceptable setting; "-all" is stricter.`,
      recommendation: `Consider "-all" once you are sure every service that sends as ${domain} is listed.`,
    });
  } else if (effectiveAll === null) {
    findings.push({
      code: "spf_no_all",
      severity: "warning",
      message: "The SPF record has no all mechanism and no redirect, so unlisted servers get a neutral result.",
      recommendation: `End the record with "~all" or "-all".`,
    });
  }
  if (allIndex !== -1 && allIndex < rootTerms.length - 1) {
    findings.push({
      code: "spf_terms_after_all",
      severity: "info",
      message: `Terms after "${allRaw}" are never evaluated: ${rootTerms.slice(allIndex + 1).map((t) => t.raw).join(" ")}.`,
      recommendation: `Move these terms before "${allRaw}" or remove them.`,
    });
  }
  if (allIndex !== -1 && parsed.terms.some((t) => t.kind === "modifier" && t.name === "redirect")) {
    findings.push({
      code: "spf_redirect_ignored",
      severity: "info",
      message: "The record has both an all mechanism and redirect=; receivers ignore the redirect.",
      recommendation: "Remove whichever of the two you do not intend to use.",
    });
  }
  if (ctx.ptrDomains.size > 0) {
    findings.push({
      code: "spf_ptr_deprecated",
      severity: "warning",
      message: `The ptr mechanism is used (in ${[...ctx.ptrDomains].join(", ")}). It is deprecated (RFC 7208 §5.5): slow, unreliable, and some receivers ignore it.`,
      recommendation: "Replace ptr with ip4:/ip6: ranges or an include for the servers concerned.",
    });
  }

  const lowerBound = ctx.unresolved.size > 0 || ctx.macroTargets.size > 0 || ctx.truncated;
  const countText = `${lowerBound ? "at least " : ""}${ctx.lookupCount}`;
  if (ctx.lookupCount > SPF_LOOKUP_LIMIT) {
    findings.push({
      code: "spf_too_many_lookups",
      severity: "error",
      message: `Evaluating the SPF record takes ${countText} DNS lookups; the limit is ${SPF_LOOKUP_LIMIT}. Receivers that reach the limit return a permanent error (permerror).`,
      recommendation: "Remove includes for services that no longer send your mail, or replace includes with the provider's ip4:/ip6: ranges where the provider allows it.",
    });
  } else if (ctx.lookupCount >= SPF_LOOKUP_LIMIT - 1) {
    findings.push({
      code: "spf_lookups_near_limit",
      severity: "warning",
      message: `Evaluating the SPF record takes ${countText} of the ${SPF_LOOKUP_LIMIT} allowed DNS lookups, so adding one more include could break it.`,
      recommendation: "Remove includes you no longer need before adding new sending services.",
    });
  }
  if (ctx.voidLookups > SPF_VOID_LOOKUP_LIMIT) {
    findings.push({
      code: "spf_too_many_void_lookups",
      severity: "warning",
      message: `${ctx.voidLookups} lookups during SPF evaluation returned no records (the recommended limit is ${SPF_VOID_LOOKUP_LIMIT}). Receivers may return a permanent error (RFC 7208 §4.6.4).`,
      recommendation: "Remove a, mx and include terms that point at names with no records.",
    });
  }
  if (ctx.unresolved.size > 0) {
    const list = [...ctx.unresolved].map(([name, outcome]) => `${name} (${outcome})`).join(", ");
    findings.push({
      code: "spf_include_unresolved",
      severity: "info",
      message: `Could not resolve ${list}, so part of the SPF policy is unknown and the lookup count (${countText}) is a lower bound.`,
      recommendation: "Run the check again. If it persists, the included domain's nameservers may be unreliable, which also affects receivers.",
    });
  }
  if (ctx.macroTargets.size > 0) {
    findings.push({
      code: "spf_macro_not_expanded",
      severity: "info",
      message: `${[...ctx.macroTargets].join(" ")} uses macros that expand differently for each message, so the lookups inside the target record are not included in the count.`,
    });
  }

  const present = treeDomains(tree);
  const treeIncomplete = lowerBound;
  const missingExpected: string[] = [];
  for (const include of expectedIncludes) {
    if (present.has(include)) continue;
    missingExpected.push(include);
    const provider = PROVIDER_NAME_BY_INCLUDE[include] ?? "your mail provider";
    findings.push(
      treeIncomplete
        ? {
            code: "spf_expected_include_unverified",
            severity: "info",
            message: `Could not confirm that the SPF record includes ${include} (needed for ${provider}) because part of the record could not be resolved.`,
          }
        : {
            code: "spf_expected_include_missing",
            severity: "warning",
            message: `The SPF record does not include ${include}, which ${provider} uses to authorise its sending servers. Receivers may treat mail sent through ${provider} as not authorised by SPF.`,
            recommendation: `Add include:${include} before the all mechanism, keeping the total under ${SPF_LOOKUP_LIMIT} DNS lookups.`,
          },
    );
  }

  const status = statusFromFindings(findings, ctx.unresolved.size > 0);
  return finish(status, summarize(domain, status, findings, ctx.lookupCount), {
    record,
    terms: parsed.terms,
    lookupCount: ctx.lookupCount,
    lookupCountIsLowerBound: lowerBound,
    voidLookups: ctx.voidLookups,
    effectiveAll,
    includeTree: tree,
    unresolvedIncludes: [...ctx.unresolved.keys()],
    expectedIncludes,
    missingExpectedIncludes: missingExpected,
  });
}
