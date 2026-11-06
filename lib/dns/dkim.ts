/**
 * DKIM key-record (RFC 6376 §3.6.1) parsing and evaluation.
 *
 * DKIM selectors cannot be enumerated from DNS, so this check only looks at
 * selectors it is given: customer-supplied ones (a missing key there is a
 * real problem) and well-known provider defaults (probed opportunistically;
 * absence is not a failure). With nothing to look at, the result is
 * INCONCLUSIVE rather than pass or fail.
 */
import { createPublicKey } from "node:crypto";
import {
  isEmptyOutcome,
  isUncertainOutcome,
  recordQueries,
  statusFromFindings,
  type CheckFinding,
  type CheckResult,
  type CheckStatus,
  type DkimSelectorInput,
  type DnsOutcome,
  type DnsResolver,
} from "@/lib/dns/types";

export const DKIM_RULE_VERSION = "dkim-2026.10.1";
export const DKIM_RECOMMENDED_BITS = 2048;
export const DKIM_MINIMUM_BITS = 1024;

/** Selectors each provider uses by default (Microsoft 365 publishes them as CNAMEs to the tenant). */
export const DEFAULT_DKIM_SELECTORS = {
  google: ["google"],
  microsoft: ["selector1", "selector2"],
} as const;

export function defaultSelectorsFor(providers: Iterable<keyof typeof DEFAULT_DKIM_SELECTORS>): DkimSelectorInput[] {
  const selectors = new Set<string>();
  for (const provider of providers) for (const selector of DEFAULT_DKIM_SELECTORS[provider]) selectors.add(selector);
  return [...selectors].map((selector) => ({ selector, source: "provider_default" }));
}

export function dkimRecordName(selector: string, domain: string): string {
  return `${selector}._domainkey.${domain}`;
}

/* ─── Parsing ──────────────────────────────────────────────────────────── */

export interface ParsedDkim {
  /** Tag names are case-sensitive in DKIM (RFC 6376 §3.2). */
  tags: Record<string, string>;
  version: string | null;
  /** k=, lowercased; "rsa" when absent. */
  keyType: string;
  /** p= with whitespace removed; "" means the key is revoked; null means no p= tag. */
  publicKey: string | null;
  /** t=y */
  testing: boolean;
  /** t=s */
  strictSubdomains: boolean;
  hashAlgorithms: string[] | null;
  serviceTypes: string[] | null;
  /** Problems found while parsing; errors make the key unusable. */
  issues: CheckFinding[];
}

/** True for TXT strings that look like a DKIM key record. */
export function looksLikeDkim(txt: string): boolean {
  return /^\s*v\s*=\s*DKIM1\b/i.test(txt) || /(?:^|;)\s*p\s*=/.test(txt);
}

function colonList(value: string): string[] {
  return value
    .split(":")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
}

export function parseDkim(record: string): ParsedDkim {
  const issues: CheckFinding[] = [];
  // Null prototype: tag names come from DNS.
  const tags = Object.create(null) as Record<string, string>;
  const order: string[] = [];

  for (const part of record.split(";")) {
    const piece = part.trim();
    if (piece === "") continue;
    const eq = piece.indexOf("=");
    if (eq === -1) {
      issues.push({
        code: "dkim_malformed_tag",
        severity: "warning",
        message: `"${piece}" is not a valid tag (expected name=value).`,
        recommendation: "Republish the key record exactly as your mail provider supplies it.",
      });
      continue;
    }
    const name = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    order.push(name);
    if (Object.hasOwn(tags, name)) {
      issues.push({
        code: "dkim_duplicate_tag",
        severity: "error",
        message: `The ${name}= tag appears more than once, which makes the key record invalid (RFC 6376 §3.2).`,
        recommendation: "Republish the key record exactly as your mail provider supplies it.",
      });
      continue;
    }
    tags[name] = value;
  }

  const version = tags.v ?? null;
  if (version !== null && version !== "DKIM1") {
    issues.push({
      code: "dkim_invalid_version",
      severity: "error",
      message: `v=${version} is not valid; if present it must be v=DKIM1, otherwise receivers discard the key.`,
      recommendation: "Set v=DKIM1 or remove the v= tag.",
    });
  } else if (version !== null && order[0] !== "v") {
    issues.push({
      code: "dkim_version_not_first",
      severity: "warning",
      message: "v=DKIM1 must be the first tag in the key record; some receivers may reject the key.",
      recommendation: "Move v=DKIM1; to the start of the record.",
    });
  }

  const keyType = (tags.k ?? "rsa").toLowerCase();
  if (keyType !== "rsa" && keyType !== "ed25519") {
    issues.push({
      code: "dkim_unknown_key_type",
      severity: "error",
      message: `k=${tags.k ?? ""} is not a supported key type (rsa or ed25519).`,
      recommendation: "Republish the key record exactly as your mail provider supplies it.",
    });
  }

  const publicKey = tags.p === undefined ? null : tags.p.replace(/\s+/g, "");
  if (publicKey === null) {
    issues.push({
      code: "dkim_key_missing",
      severity: "error",
      message: "The record has no p= tag, so it does not contain a public key.",
      recommendation: "Republish the key record exactly as your mail provider supplies it.",
    });
  }

  const flags = colonList(tags.t ?? "");
  const hashAlgorithms = tags.h === undefined ? null : colonList(tags.h);
  if (hashAlgorithms !== null && !hashAlgorithms.includes("sha256")) {
    issues.push({
      code: "dkim_sha1_only",
      severity: "warning",
      message: `h=${tags.h ?? ""} does not allow sha256; signatures restricted to sha1 are not considered valid by current receivers (RFC 8301).`,
      recommendation: "Remove the h= tag or set h=sha256.",
    });
  }
  const serviceTypes = tags.s === undefined ? null : colonList(tags.s);
  if (serviceTypes !== null && !serviceTypes.includes("*") && !serviceTypes.includes("email")) {
    issues.push({
      code: "dkim_not_for_email",
      severity: "error",
      message: `s=${tags.s ?? ""} restricts this key to non-email services, so receivers will not use it for email.`,
      recommendation: "Remove the s= tag or set s=email.",
    });
  }

  return {
    tags,
    version,
    keyType,
    publicKey,
    testing: flags.includes("y"),
    strictSubdomains: flags.includes("s"),
    hashAlgorithms,
    serviceTypes,
    issues,
  };
}

export type DkimKeyType = "rsa" | "ed25519" | "unknown";

/**
 * Decodes a p= value. RSA keys are SubjectPublicKeyInfo DER (PKCS#1
 * RSAPublicKey accepted as a fallback); Ed25519 keys (RFC 8463) are the raw
 * 32-byte key, though SPKI-wrapped ones are recognised too.
 */
export function inspectDkimKey(p: string, keyType = "rsa"): { keyType: DkimKeyType; bits: number | null } {
  const clean = p.replace(/\s+/g, "");
  if (clean === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return { keyType: "unknown", bits: null };
  const der = Buffer.from(clean, "base64");
  if (keyType.toLowerCase() === "ed25519" && der.length === 32) return { keyType: "ed25519", bits: 256 };
  for (const type of ["spki", "pkcs1"] as const) {
    try {
      const key = createPublicKey({ key: der, format: "der", type });
      if (key.asymmetricKeyType === "ed25519") return { keyType: "ed25519", bits: 256 };
      const bits = key.asymmetricKeyDetails?.modulusLength;
      if (key.asymmetricKeyType === "rsa" && bits !== undefined) return { keyType: "rsa", bits };
      return { keyType: "unknown", bits: bits ?? null };
    } catch (error: unknown) {
      void error; // not this encoding; try the next one
    }
  }
  return { keyType: "unknown", bits: null };
}

/** Key size in bits for a p= value (RSA modulus length; 256 for Ed25519), or null if it cannot be decoded. */
export function estimateKeyBits(p: string): number | null {
  return inspectDkimKey(p).bits;
}

/* ─── Evaluation ───────────────────────────────────────────────────────── */

export type DkimSelectorState = "valid" | "weak" | "too_weak" | "revoked" | "invalid" | "not_found" | "inconclusive";

export interface DkimSelectorResult {
  selector: string;
  source: DkimSelectorInput["source"];
  name: string;
  outcome: DnsOutcome;
  state: DkimSelectorState;
  record: string | null;
  keyType: DkimKeyType | null;
  bits: number | null;
  testing: boolean;
}

function selectorLabel(input: DkimSelectorInput): string {
  return input.source === "customer" ? `selector "${input.selector}"` : `default selector "${input.selector}"`;
}

async function evaluateSelector(
  domain: string,
  input: DkimSelectorInput,
  resolver: DnsResolver,
  findings: CheckFinding[],
): Promise<DkimSelectorResult> {
  const name = dkimRecordName(input.selector, domain);
  const isCustomer = input.source === "customer";
  const answer = await resolver.txt(name);
  const result: DkimSelectorResult = {
    selector: input.selector,
    source: input.source,
    name,
    outcome: answer.outcome,
    state: "inconclusive",
    record: null,
    keyType: null,
    bits: null,
    testing: false,
  };

  if (isUncertainOutcome(answer.outcome)) {
    findings.push({
      code: "dkim_selector_lookup_failed",
      severity: "info",
      message: `The DNS lookup for ${name} did not complete (${answer.outcome}), so ${selectorLabel(input)} could not be checked.`,
      recommendation: "Run the check again.",
    });
    return result;
  }

  const keyRecords = answer.records.filter(looksLikeDkim);
  if (isEmptyOutcome(answer.outcome) || keyRecords.length === 0) {
    const nonKey = keyRecords.length === 0 && answer.records.length > 0;
    result.state = isCustomer && nonKey ? "invalid" : "not_found";
    if (isCustomer) {
      findings.push(
        nonKey
          ? {
              code: "dkim_not_a_key",
              severity: "error",
              message: `The TXT record at ${name} is not a DKIM key record, so receivers cannot verify signatures made with this selector.`,
              recommendation: "Replace it with the DKIM key record (v=DKIM1; k=rsa; p=…) supplied by your mail provider.",
            }
          : {
              code: "dkim_selector_not_found",
              severity: "error",
              message: `No DKIM key is published at ${name}. If this selector is correct, receivers cannot verify signatures made with it — check the selector spelling.`,
              recommendation: `Publish the DKIM key your mail provider gives you for selector "${input.selector}", or correct the selector.`,
            },
      );
    } else {
      findings.push({
        code: "dkim_default_selector_not_found",
        severity: "info",
        message: `No DKIM key at the provider default ${name}. This is not a problem if your mail is signed with a different selector.`,
      });
    }
    return result;
  }

  if (keyRecords.length > 1) {
    findings.push({
      code: "dkim_multiple_records",
      severity: "warning",
      message: `${name} has ${keyRecords.length} DKIM key records; receivers may pick either one.`,
      recommendation: "Keep a single key record per selector.",
    });
  }

  const record = keyRecords[0] ?? "";
  result.record = record;
  const parsed = parseDkim(record);
  result.testing = parsed.testing;
  for (const issue of parsed.issues) findings.push({ ...issue, message: `${name}: ${issue.message}` });
  if (parsed.issues.some((i) => i.severity === "error")) {
    result.state = "invalid";
    return result;
  }

  if (parsed.publicKey === "") {
    result.state = "revoked";
    findings.push(
      isCustomer
        ? {
            code: "dkim_key_revoked",
            severity: "error",
            message: `The key at ${name} is revoked (empty p=), so signatures made with selector "${input.selector}" fail verification.`,
            recommendation: "Sign with an active selector, or publish a new key for this one and update your mail provider.",
          }
        : {
            code: "dkim_default_selector_revoked",
            severity: "info",
            message: `The provider default ${name} holds a revoked key (empty p=). This is not a problem if your mail is signed with a different selector.`,
          },
    );
    return result;
  }

  const key = inspectDkimKey(parsed.publicKey ?? "", parsed.keyType);
  result.keyType = key.keyType;
  result.bits = key.bits;
  if (key.bits === null) {
    result.state = "invalid";
    findings.push({
      code: "dkim_key_unparseable",
      severity: "error",
      message: `The public key at ${name} could not be decoded, so receivers cannot verify signatures made with ${selectorLabel(input)}.`,
      recommendation: "Republish the key exactly as your mail provider supplies it; a missing or extra character breaks it.",
    });
    return result;
  }

  if (key.keyType === "ed25519") {
    result.state = "valid";
    findings.push({
      code: "dkim_ed25519_key",
      severity: "info",
      message: `${name} publishes an Ed25519 key. Not all receivers verify Ed25519 signatures yet, so RFC 8463 suggests also signing with an RSA key.`,
    });
  } else if (key.bits < DKIM_MINIMUM_BITS) {
    result.state = "too_weak";
    findings.push({
      code: "dkim_key_too_weak",
      severity: "error",
      message: `The key at ${name} is only ${key.bits} bits. Receivers may treat signatures from keys under ${DKIM_MINIMUM_BITS} bits as failing (RFC 8301).`,
      recommendation: `Generate a new ${DKIM_RECOMMENDED_BITS}-bit key with your mail provider and publish it.`,
    });
  } else if (key.bits < DKIM_RECOMMENDED_BITS) {
    result.state = "weak";
    findings.push({
      code: "dkim_key_weak",
      severity: "warning",
      message: `The key at ${name} is ${key.bits} bits; ${DKIM_RECOMMENDED_BITS} bits is the current recommendation.`,
      recommendation: `Rotate to a ${DKIM_RECOMMENDED_BITS}-bit key with your mail provider when convenient.`,
    });
  } else {
    result.state = "valid";
  }

  if (parsed.testing) {
    findings.push({
      code: "dkim_testing_mode",
      severity: "warning",
      message: `${name} has t=y (testing mode), so receivers may treat its signatures as unverified.`,
      recommendation: "Remove t=y from the key record once signing is confirmed to work.",
    });
  }
  return result;
}

function describeKey(result: DkimSelectorResult): string {
  if (result.keyType === "ed25519") return "Ed25519";
  return `${result.bits ?? "?"}-bit RSA`;
}

function summarize(domain: string, status: CheckStatus, findings: CheckFinding[], results: DkimSelectorResult[]): string {
  if (status === "fail") {
    const first = findings.find((f) => f.severity === "error");
    if (first?.code === "dkim_selector_not_found") {
      const missing = results.find((r) => r.source === "customer" && r.state === "not_found");
      return `No DKIM key is published for selector "${missing?.selector ?? "?"}" on ${domain}, so receivers cannot verify signatures made with it.`;
    }
    return `At least one DKIM selector for ${domain} has a missing, revoked or unusable key.`;
  }
  if (status === "warn") {
    const count = findings.filter((f) => f.severity === "warning").length;
    return `DKIM keys are published for ${domain}, but ${count} issue${count === 1 ? " needs" : "s need"} attention.`;
  }
  if (status === "inconclusive") {
    if (results.some((r) => r.state === "inconclusive")) {
      return `DKIM for ${domain} could not be confirmed because a DNS lookup did not complete.`;
    }
    return `No DKIM key could be confirmed for ${domain}; add the selector your mail provider signs with to check it.`;
  }
  const valid = results.filter((r) => r.state === "valid");
  if (valid.length === 1 && valid[0]) {
    return `A valid DKIM key is published for ${domain} (selector "${valid[0].selector}", ${describeKey(valid[0])}).`;
  }
  return `Valid DKIM keys are published for ${domain} (selectors ${valid.map((r) => `"${r.selector}"`).join(", ")}).`;
}

export async function evaluateDkim(
  domain: string,
  resolver: DnsResolver,
  selectors: DkimSelectorInput[],
): Promise<CheckResult> {
  const started = performance.now();
  const recorder = recordQueries(resolver);
  const findings: CheckFinding[] = [];

  // Dedupe; a customer-supplied selector takes precedence over the same provider default.
  const bySelector = new Map<string, DkimSelectorInput>();
  for (const input of selectors) {
    const selector = input.selector.trim().toLowerCase();
    if (selector === "") continue;
    const existing = bySelector.get(selector);
    if (!existing || (existing.source === "provider_default" && input.source === "customer")) {
      bySelector.set(selector, { selector, source: input.source });
    }
  }
  const inputs = [...bySelector.values()];

  const finish = (status: CheckStatus, summary: string, results: DkimSelectorResult[]): CheckResult => ({
    checkType: "dkim",
    status,
    summary,
    findings,
    evidence: { queries: recorder.queries, parsed: { selectors: results } },
    ruleVersion: DKIM_RULE_VERSION,
    resolver: resolver.label,
    durationMs: Math.round(performance.now() - started),
  });

  if (inputs.length === 0) {
    findings.push({
      code: "dkim_no_selectors",
      severity: "info",
      message: "DKIM selectors cannot be discovered from DNS, so there is nothing to check yet.",
      recommendation:
        "DKIM selectors cannot be discovered from DNS; add the selector from the s= tag of a sent message's DKIM-Signature header.",
    });
    return finish("inconclusive", `DKIM for ${domain} cannot be checked until a selector is provided, because selectors cannot be discovered from DNS.`, []);
  }

  // Each selector writes into its own list so findings stay in selector order.
  const perSelector = inputs.map(() => [] as CheckFinding[]);
  const results = await Promise.all(
    inputs.map((input, i) => evaluateSelector(domain, input, recorder, perSelector[i] ?? [])),
  );
  for (const list of perSelector) findings.push(...list);

  const hasValidKey = results.some((r) => r.state === "valid" || r.state === "weak");
  const hasCustomer = inputs.some((i) => i.source === "customer");
  if (!hasValidKey && !hasCustomer && results.every((r) => r.state === "not_found" || r.state === "revoked")) {
    findings.push({
      code: "dkim_no_key_found",
      severity: "info",
      message: `No DKIM key was found at the provider default selectors (${inputs.map((i) => i.selector).join(", ")}).`,
      recommendation:
        "DKIM selectors cannot be discovered from DNS; add the selector from the s= tag of a sent message's DKIM-Signature header.",
    });
  }

  const status = statusFromFindings(findings, !hasValidKey);
  return finish(status, summarize(domain, status, findings, results), results);
}
