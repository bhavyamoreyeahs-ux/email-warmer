/**
 * Domain-ownership verification via a DNS TXT record.
 *
 * The user publishes `quikreach-verification=<token>` at `_quikreach.<domain>`.
 * Tokens are compared in constant time. A lookup that does not complete is
 * reported as such (verified: false with the real outcome), never as
 * "record missing".
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { isUncertainOutcome, toQueryEvidence, type DnsOutcome, type DnsQueryEvidence, type DnsResolver } from "@/lib/dns/types";

export const VERIFICATION_PREFIX = "_quikreach";
const VALUE_PREFIX = "quikreach-verification=";

export function verificationRecordName(domain: string): string {
  return `${VERIFICATION_PREFIX}.${domain}`;
}

export function verificationRecordValue(token: string): string {
  return `${VALUE_PREFIX}${token}`;
}

/** 24 random bytes, base64url (32 characters). */
export function generateVerificationToken(): string {
  return randomBytes(24).toString("base64url");
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface VerificationCheck {
  verified: boolean;
  outcome: DnsOutcome;
  evidence: DnsQueryEvidence;
  detail: string;
}

export async function checkVerification(domain: string, token: string, resolver: DnsResolver): Promise<VerificationCheck> {
  const name = verificationRecordName(domain);
  const expected = verificationRecordValue(token);
  const answer = await resolver.txt(name);
  const evidence = toQueryEvidence(name, "TXT", answer);

  if (isUncertainOutcome(answer.outcome)) {
    return {
      verified: false,
      outcome: answer.outcome,
      evidence,
      detail: `The DNS lookup for ${name} did not complete (${answer.outcome}). Try again in a few minutes.`,
    };
  }
  if (answer.records.length === 0) {
    return {
      verified: false,
      outcome: answer.outcome,
      evidence,
      detail: `No TXT record was found at ${name}. Add a TXT record there with the value ${expected}; DNS changes can take a while to appear.`,
    };
  }

  // Some DNS panels store surrounding quotes literally; tolerate one pair.
  const candidates = answer.records.map((r) => r.trim().replace(/^"(.*)"$/, "$1"));
  // Check every record (no early exit) so timing does not depend on which one matches.
  let verified = false;
  for (const candidate of candidates) {
    if (constantTimeEquals(candidate, expected)) verified = true;
  }
  if (verified) {
    return { verified: true, outcome: answer.outcome, evidence, detail: `Found the verification record at ${name}.` };
  }
  const hasOurPrefix = candidates.some((c) => c.startsWith(VALUE_PREFIX));
  return {
    verified: false,
    outcome: answer.outcome,
    evidence,
    detail: hasOurPrefix
      ? `A QuikReach verification record exists at ${name}, but its token does not match. Replace it with ${expected}.`
      : `TXT records exist at ${name}, but none is ${expected}.`,
  };
}
