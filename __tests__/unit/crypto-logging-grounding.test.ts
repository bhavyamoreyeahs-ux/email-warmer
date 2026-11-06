import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/crypto/encryption";
import { redact } from "@/lib/observability/logger";
import { enforceGrounding } from "@/lib/ai/grounding";
import { diagnoseWithRules } from "@/lib/ai/rules-engine";
import type { EvidenceItem } from "@/lib/ai/schema";
import { combineStates, evaluateDomainHealth, evaluateMailboxHealth } from "@/lib/health/evaluate";

describe("credential encryption", () => {
  it("round-trips, rejects tampering, and supports key rotation", () => {
    const ct = encryptSecret("refresh-token-value");
    expect(ct).not.toContain("refresh-token-value");
    expect(decryptSecret(ct)).toBe("refresh-token-value");
    const parts = ct.split(".");
    parts[4] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."))).toThrow();

    const old = process.env.TOKEN_ENCRYPTION_KEYS!;
    const oldCt = encryptSecret("rotate-me");
    process.env.TOKEN_ENCRYPTION_KEYS = `k2:${Buffer.alloc(32, 7).toString("base64")},${old}`;
    expect(encryptSecret("x").split(".")[1]).toBe("k2");
    expect(decryptSecret(oldCt)).toBe("rotate-me");
    process.env.TOKEN_ENCRYPTION_KEYS = old;
  });
});

describe("log redaction", () => {
  it("removes secrets by key and token-shaped values anywhere", () => {
    const out = JSON.stringify(redact({ access_token: "a", nested: { refreshToken: "b", subject: "Re: invoice" }, msg: "auth Bearer abcdefghijklmnopqrstuvwxyz failed", jwt: "x eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk" }));
    expect(out).not.toMatch(/"a"|"b"|invoice|abcdefghijklmnopqrstuvwxyz|eyJhbGci/);
  });
});

const evidence: EvidenceItem[] = [
  { ref: "check:1", kind: "dns_check", title: "SPF fail", observedAt: null, facts: { checkType: "spf", status: "fail", summary: "No SPF record", domain: "a.example" } },
  { ref: "events:c1:7d", kind: "event_summary", title: "Observed events for s@a.example, last 7 days", observedAt: null, facts: { sent: 100, bounceRate: 0.08, hardBounces: 6, softBounces: 2, unclassifiedBounces: 0, providerErrors: 0, sendingLimitNotices: 0, complaints: 0, topBouncingRecipientDomains: ["x.example (5)"] } },
];

describe("AI grounding", () => {
  it("downgrades findings without valid evidence and strips invented refs", () => {
    const out = enforceGrounding(
      {
        summary: "s",
        overallConfidence: "high",
        confirmedFindings: [
          { statement: "SPF is missing", evidenceRefs: ["check:1"] },
          { statement: "Gmail placed mail in spam", evidenceRefs: ["event:invented"] },
        ],
        hypotheses: [],
        recommendations: [{ action: "Fix SPF", rationale: "r", evidenceRefs: ["check:1", "check:999"], kind: "dns_change" }],
        insufficientEvidence: [],
      },
      new Set(evidence.map((e) => e.ref)),
    );
    expect(out.confirmedFindings.map((f) => f.statement)).toEqual(["SPF is missing"]);
    expect(out.hypotheses.some((h) => h.statement.includes("spam") && h.confidence === "low")).toBe(true);
    expect(out.recommendations[0]!.evidenceRefs).toEqual(["check:1"]);
    expect(out.groundingNotes.length).toBeGreaterThan(0);
    expect(out.actionsRequireHumanConfirmation).toBe(true);
  });

  it("rules engine only cites supplied evidence and always lists what it cannot tell", () => {
    const d = diagnoseWithRules(evidence);
    const refs = new Set(evidence.map((e) => e.ref));
    for (const f of [...d.confirmedFindings, ...d.hypotheses, ...d.recommendations]) for (const r of f.evidenceRefs) expect(refs.has(r)).toBe(true);
    expect(d.confirmedFindings.length).toBeGreaterThanOrEqual(2);
    expect(d.insufficientEvidence.some((i) => /inbox placement/i.test(i.missingData))).toBe(true);
  });
});

describe("health evaluation", () => {
  const now = new Date("2026-10-31T12:00:00Z");
  it("never reports stale or inconclusive inputs as healthy", () => {
    expect(combineStates(["healthy", "unknown"])).toBe("unknown");
    expect(combineStates(["healthy", "stale"])).toBe("stale");
    const checks = (["mx", "spf", "dmarc"] as const).map((t, i) => ({ id: String(i), checkType: t, status: "pass" as const, summary: "", checkedAt: now }));
    const withDkimUnknown = evaluateDomainHealth({ checks: [...checks, { id: "d", checkType: "dkim", status: "inconclusive", summary: "no selector", checkedAt: now }], lastScanAt: now, verified: true, now });
    expect(withDkimUnknown.state).toBe("unknown");
    const staleScan = evaluateDomainHealth({ checks: [...checks, { id: "d", checkType: "dkim", status: "pass", summary: "", checkedAt: now }], lastScanAt: new Date(now.getTime() - 30 * 86_400_000), verified: true, now });
    expect(staleScan.state).toBe("stale");
  });

  it("treats a small sample as unknown, not zero", () => {
    const r = evaluateMailboxHealth({ connectionId: "c", state: "connected", stateReason: null, lastSuccessfulSyncAt: now, counts: { sent: 5, hard_bounce: 0 }, capabilities: {}, now });
    expect(r.inputs.find((i) => i.key === "mailbox.bounce_rate")!.state).toBe("unknown");
    expect(r.missing.some((m) => /inbox placement/i.test(m))).toBe(true);
  });
});
