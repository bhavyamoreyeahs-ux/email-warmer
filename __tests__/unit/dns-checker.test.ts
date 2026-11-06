import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { RULE_VERSIONS, normalizeDkimSelectors, runDomainChecks } from "@/lib/dns/checker";
import { FakeResolver, type FakeZone } from "@/lib/dns/fake-resolver";
import { createNodeResolver, mapDnsError } from "@/lib/dns/resolver";
import type { CheckResult, CheckType } from "@/lib/dns/types";
import {
  checkVerification,
  generateVerificationToken,
  verificationRecordName,
  verificationRecordValue,
} from "@/lib/dns/verification";

const D = "example.com";
let key2048 = "";

beforeAll(() => {
  key2048 = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .publicKey.export({ type: "spki", format: "der" })
    .toString("base64");
});

function byType(results: CheckResult[]): Record<CheckType, CheckResult> {
  return Object.fromEntries(results.map((r) => [r.checkType, r])) as Record<CheckType, CheckResult>;
}

function googleZone(overrides: FakeZone = {}): FakeZone {
  return {
    [`${D}|MX`]: [{ exchange: "smtp.google.com", priority: 1 }],
    "smtp.google.com|A": ["192.0.2.25"],
    [`${D}|TXT`]: ["v=spf1 include:_spf.google.com -all"],
    "_spf.google.com|TXT": ["v=spf1 ip4:192.0.2.0/24 ~all"],
    [`google._domainkey.${D}|TXT`]: [`v=DKIM1; k=rsa; p=${key2048}`],
    [`_dmarc.${D}|TXT`]: ["v=DMARC1; p=reject; rua=mailto:dmarc@example.com"],
    ...overrides,
  };
}

describe("runDomainChecks", () => {
  it("runs all four checks and returns them in a stable order", async () => {
    const resolver = new FakeResolver(googleZone());
    const results = await runDomainChecks(D, resolver);
    expect(results.map((r) => r.checkType)).toEqual(["mx", "spf", "dkim", "dmarc"]);
    for (const result of results) {
      expect(result.status).toBe("pass");
      expect(result.ruleVersion).toBe(RULE_VERSIONS[result.checkType]);
      expect(result.resolver).toBe("fake");
      expect(result.summary.length).toBeGreaterThan(0);
    }
    // The MX answer is shared between the MX check and provider detection.
    expect(resolver.countFor(`${D}|MX`)).toBe(1);
  });

  it("probes the Google default DKIM selector because MX points at Google", async () => {
    const resolver = new FakeResolver(googleZone());
    const { dkim } = byType(await runDomainChecks(D, resolver));
    expect(resolver.countFor(`google._domainkey.${D}|TXT`)).toBe(1);
    expect(resolver.countFor(`selector1._domainkey.${D}|TXT`)).toBe(0);
    expect(dkim?.status).toBe("pass");
  });

  it("expects the MX-detected provider's SPF include", async () => {
    const resolver = new FakeResolver(googleZone({ [`${D}|TXT`]: ["v=spf1 ip4:192.0.2.0/24 -all"] }));
    const { spf } = byType(await runDomainChecks(D, resolver));
    expect(spf?.status).toBe("warn");
    expect(spf?.findings.map((f) => f.code)).toContain("spf_expected_include_missing");
  });

  it("adds expectations for connected mailbox providers", async () => {
    const resolver = new FakeResolver(googleZone());
    const { spf } = byType(await runDomainChecks(D, resolver, { mailboxProviders: ["microsoft"] }));
    expect(spf?.status).toBe("warn");
    const finding = spf?.findings.find((f) => f.code === "spf_expected_include_missing");
    expect(finding?.recommendation).toMatch(/include:spf\.protection\.outlook\.com/);
    expect(resolver.countFor(`selector1._domainkey.${D}|TXT`)).toBe(1);
    expect(resolver.countFor(`selector2._domainkey.${D}|TXT`)).toBe(1);
  });

  it("returns an inconclusive result for a check that exceeds its budget", async () => {
    const resolver = new FakeResolver(googleZone(), { delays: { [`${D}|TXT`]: 300 } });
    const results = byType(await runDomainChecks(D, resolver, { timeoutMs: 60 }));
    expect(results.spf?.status).toBe("inconclusive");
    expect(results.spf?.findings.map((f) => f.code)).toEqual(["spf_check_timeout"]);
    expect(results.spf?.ruleVersion).toBe(RULE_VERSIONS.spf);
    expect(results.mx?.status).toBe("pass");
    expect(results.dmarc?.status).toBe("pass");
  });

  it("uses normalised customer selectors and notes invalid ones", async () => {
    const resolver = new FakeResolver(
      googleZone({
        [`${D}|MX`]: [{ exchange: "mx.example.net", priority: 10 }],
        "mx.example.net|A": ["192.0.2.1"],
        [`${D}|TXT`]: ["v=spf1 include:_spf.google.com -all"],
        [`s1._domainkey.${D}|TXT`]: [`v=DKIM1; p=${key2048}`],
        [`s2._domainkey.${D}|TXT`]: [`v=DKIM1; p=${key2048}`],
      }),
    );
    const { dkim } = byType(
      await runDomainChecks(D, resolver, { dkimSelectors: [" S1 ", "s1", "bad selector!", `s2._domainkey.${D}`] }),
    );
    expect(resolver.countFor(`s1._domainkey.${D}|TXT`)).toBe(1);
    expect(resolver.countFor(`s2._domainkey.${D}|TXT`)).toBe(1);
    expect(resolver.countFor(`google._domainkey.${D}|TXT`)).toBe(0);
    expect(dkim?.status).toBe("pass");
    expect(dkim?.findings[0]).toMatchObject({ code: "dkim_invalid_selector", severity: "info" });
  });

  it("reports DKIM as inconclusive when there is nothing to probe", async () => {
    const resolver = new FakeResolver(
      googleZone({ [`${D}|MX`]: [{ exchange: "mx.example.net", priority: 10 }], "mx.example.net|A": ["192.0.2.1"] }),
    );
    const { dkim } = byType(await runDomainChecks(D, resolver));
    expect(dkim?.status).toBe("inconclusive");
    expect(dkim?.findings.map((f) => f.code)).toEqual(["dkim_no_selectors"]);
  });
});

describe("normalizeDkimSelectors", () => {
  it("lowercases, trims, dedupes and validates", () => {
    expect(normalizeDkimSelectors([" S1 ", "s1", "k1.2026", "x_y-z", "", "bad sel", ".lead", "a..b", "a".repeat(64)])).toEqual({
      valid: ["s1", "k1.2026", "x_y-z"],
      invalid: ["bad sel", ".lead", "a..b", "a".repeat(64)],
    });
  });
});

describe("verification", () => {
  const token = "abc123_-XYZ";

  it("builds the record name and value", () => {
    expect(verificationRecordName(D)).toBe("_quikreach.example.com");
    expect(verificationRecordValue(token)).toBe("quikreach-verification=abc123_-XYZ");
  });

  it("generates 32-character base64url tokens", () => {
    const a = generateVerificationToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(generateVerificationToken()).not.toBe(a);
  });

  it("verifies a matching record among others", async () => {
    const resolver = new FakeResolver({
      "_quikreach.example.com|TXT": ["unrelated", `quikreach-verification=${token}`],
    });
    const result = await checkVerification(D, token, resolver);
    expect(result.verified).toBe(true);
    expect(result.outcome).toBe("NOERROR");
    expect(result.evidence).toMatchObject({ name: "_quikreach.example.com", type: "TXT" });
  });

  it("rejects a wrong token, a missing record and a timeout", async () => {
    const wrong = await checkVerification(
      D,
      token,
      new FakeResolver({ "_quikreach.example.com|TXT": ["quikreach-verification=other"] }),
    );
    expect(wrong.verified).toBe(false);
    expect(wrong.detail).toMatch(/does not match/);

    const missing = await checkVerification(D, token, new FakeResolver({}));
    expect(missing).toMatchObject({ verified: false, outcome: "NXDOMAIN" });

    const timeout = await checkVerification(D, token, new FakeResolver({ "_quikreach.example.com|TXT": "TIMEOUT" }));
    expect(timeout).toMatchObject({ verified: false, outcome: "TIMEOUT" });
    expect(timeout.detail).toMatch(/did not complete/);
  });
});

describe("resolvers", () => {
  it("maps node:dns error codes to outcomes", () => {
    const err = (code: string) => Object.assign(new Error(code), { code });
    expect(mapDnsError(err("ENOTFOUND"))).toBe("NXDOMAIN");
    expect(mapDnsError(err("ENODATA"))).toBe("NODATA");
    expect(mapDnsError(err("ETIMEOUT"))).toBe("TIMEOUT");
    expect(mapDnsError(err("ESERVFAIL"))).toBe("SERVFAIL");
    expect(mapDnsError(err("EREFUSED"))).toBe("REFUSED");
    expect(mapDnsError(err("ECONNREFUSED"))).toBe("ERROR");
    expect(mapDnsError("boom")).toBe("ERROR");
  });

  it("labels the node resolver by its servers", () => {
    expect(createNodeResolver({}).label).toBe("system");
    expect(createNodeResolver({ servers: ["1.1.1.1", "8.8.8.8"] }).label).toBe("1.1.1.1,8.8.8.8");
  });

  it("FakeResolver: unknown keys are NXDOMAIN, empty arrays NODATA, queries counted", async () => {
    const resolver = new FakeResolver({ "Example.com.|TXT": [], "a.example.com|A": ["192.0.2.1"] });
    expect((await resolver.txt("example.com")).outcome).toBe("NODATA");
    expect((await resolver.mx("example.com")).outcome).toBe("NXDOMAIN");
    expect(await resolver.a("A.example.com.")).toMatchObject({ outcome: "NOERROR", records: ["192.0.2.1"] });
    expect(resolver.label).toBe("fake");
    expect(resolver.queryCount).toBe(3);
  });
});
