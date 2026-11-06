import { describe, expect, it } from "vitest";
import { evaluateDmarc, parseDmarc } from "@/lib/dns/dmarc";
import { FakeResolver, type FakeZone } from "@/lib/dns/fake-resolver";
import type { CheckResult } from "@/lib/dns/types";

const D = "example.com";
const RUA = "rua=mailto:dmarc@example.com";

function codes(result: CheckResult): string[] {
  return result.findings.map((f) => f.code);
}

function parsedOf(result: CheckResult): Record<string, unknown> {
  return result.evidence.parsed ?? {};
}

async function check(zone: FakeZone, domain = D) {
  const resolver = new FakeResolver(zone);
  return { result: await evaluateDmarc(domain, resolver), resolver };
}

describe("parseDmarc", () => {
  it("parses tags, report URIs and alignment defaults", () => {
    const parsed = parseDmarc(
      "v=DMARC1; p=quarantine; sp=reject; pct=50; rua=mailto:a@example.com,mailto:b@reports.example.net!10m; ruf=mailto:f@example.com;",
    );
    expect(parsed.issues).toEqual([]);
    expect(parsed.policy).toBe("quarantine");
    expect(parsed.subdomainPolicy).toBe("reject");
    expect(parsed.pct).toBe(50);
    expect(parsed.rua.map((u) => u.domain)).toEqual(["example.com", "reports.example.net"]);
    expect(parsed.ruf).toHaveLength(1);
    expect(parsed.adkim).toBe("r");
    expect(parsed.aspf).toBe("r");
    expect(parsed.tagOrder).toEqual(["v", "p", "sp", "pct", "rua", "ruf"]);
  });

  it("requires v=DMARC1 as the first tag", () => {
    expect(parseDmarc("p=reject; v=DMARC1").issues.map((i) => i.code)).toContain("dmarc_version_not_first");
    expect(parseDmarc("v=dmarc1; p=reject").issues.map((i) => i.code)).toContain("dmarc_invalid_version");
  });

  it("requires a valid p= tag", () => {
    expect(parseDmarc("v=DMARC1; rua=mailto:a@example.com").issues.map((i) => i.code)).toContain("dmarc_policy_missing");
    expect(parseDmarc("v=DMARC1; p=block").issues.map((i) => i.code)).toContain("dmarc_policy_invalid");
  });

  it("flags report URIs without a scheme", () => {
    const parsed = parseDmarc("v=DMARC1; p=none; rua=dmarc@example.com");
    expect(parsed.rua[0]?.valid).toBe(false);
  });

  it("treats tag names as data, not object keys", () => {
    const parsed = parseDmarc("v=DMARC1; p=none; __proto__=x; constructor=y");
    expect(parsed.tags.__proto__).toBe("x");
    expect(parsed.issues).toEqual([]);
  });
});

describe("evaluateDmarc", () => {
  it("passes p=reject with an internal rua", async () => {
    const { result, resolver } = await check({ [`_dmarc.${D}|TXT`]: [`v=DMARC1; p=reject; ${RUA}`] });
    expect(result.status).toBe("pass");
    expect(result.findings).toEqual([]);
    expect(result.summary).toMatch(/reject mail that fails/);
    expect(resolver.queryCount).toBe(1); // internal rua needs no authorization lookup
    expect(parsedOf(result)).toMatchObject({ policyDomain: D, inherited: false, effectivePolicy: "reject", pct: 100 });
    expect(result.evidence.queries[0]).toMatchObject({ name: `_dmarc.${D}`, type: "TXT", outcome: "NOERROR" });
  });

  it("passes p=quarantine", async () => {
    const { result } = await check({ [`_dmarc.${D}|TXT`]: [`v=DMARC1; p=quarantine; ${RUA}`] });
    expect(result.status).toBe("pass");
  });

  it("warns on p=none (monitoring only)", async () => {
    const { result } = await check({ [`_dmarc.${D}|TXT`]: [`v=DMARC1; p=none; ${RUA}`] });
    expect(result.status).toBe("warn");
    expect(codes(result)).toEqual(["dmarc_policy_none"]);
    expect(result.summary).toMatch(/monitoring mode/);
  });

  it("fails when no record exists", async () => {
    const { result } = await check({});
    expect(result.status).toBe("fail");
    expect(codes(result)).toEqual(["dmarc_missing"]);
  });

  it("ignores non-DMARC TXT records at _dmarc", async () => {
    const { result } = await check({ [`_dmarc.${D}|TXT`]: ["some-verification=1"] });
    expect(codes(result)).toEqual(["dmarc_missing"]);
  });

  it("fails on multiple DMARC records", async () => {
    const { result } = await check({ [`_dmarc.${D}|TXT`]: ["v=DMARC1; p=none", "v=DMARC1; p=reject"] });
    expect(result.status).toBe("fail");
    expect(codes(result)).toEqual(["dmarc_multiple_records"]);
  });

  it("fails when v=DMARC1 is not the first tag", async () => {
    const { result } = await check({ [`_dmarc.${D}|TXT`]: [`p=reject; v=DMARC1; ${RUA}`] });
    expect(result.status).toBe("fail");
    expect(codes(result)).toContain("dmarc_version_not_first");
  });

  it("fails when p is missing or invalid", async () => {
    expect((await check({ [`_dmarc.${D}|TXT`]: [`v=DMARC1; ${RUA}`] })).result.status).toBe("fail");
    const invalid = await check({ [`_dmarc.${D}|TXT`]: [`v=DMARC1; p=maybe; ${RUA}`] });
    expect(invalid.result.status).toBe("fail");
    expect(codes(invalid.result)).toContain("dmarc_policy_invalid");
  });

  it("warns when pct is below 100", async () => {
    const { result } = await check({ [`_dmarc.${D}|TXT`]: [`v=DMARC1; p=reject; pct=25; ${RUA}`] });
    expect(result.status).toBe("warn");
    expect(codes(result)).toEqual(["dmarc_pct_partial"]);
  });

  it("warns when there is no rua", async () => {
    const { result } = await check({ [`_dmarc.${D}|TXT`]: ["v=DMARC1; p=reject"] });
    expect(result.status).toBe("warn");
    expect(codes(result)).toEqual(["dmarc_no_rua"]);
  });

  it("warns on malformed report URIs", async () => {
    const { result } = await check({
      [`_dmarc.${D}|TXT`]: ["v=DMARC1; p=reject; rua=dmarc@example.com,mailto:not-an-address"],
    });
    expect(result.status).toBe("warn");
    expect(codes(result).filter((c) => c === "dmarc_malformed_report_uri")).toHaveLength(2);
  });

  it("reports sp= for the organizational domain", async () => {
    const { result } = await check({ [`_dmarc.${D}|TXT`]: [`v=DMARC1; p=reject; sp=none; ${RUA}`] });
    expect(result.status).toBe("pass");
    const finding = result.findings.find((f) => f.code === "dmarc_subdomain_policy");
    expect(finding?.severity).toBe("info");
    expect(finding?.message).toMatch(/sp=none/);
  });

  describe("organizational-domain fallback", () => {
    it("inherits the organizational domain's policy, using sp=", async () => {
      const { result } = await check(
        { [`_dmarc.${D}|TXT`]: [`v=DMARC1; p=reject; sp=quarantine; ${RUA}`] },
        "mail.example.com",
      );
      expect(result.status).toBe("pass");
      expect(result.evidence.queries.map((q) => q.name)).toEqual(["_dmarc.mail.example.com", `_dmarc.${D}`]);
      expect(parsedOf(result)).toMatchObject({ policyDomain: D, inherited: true, effectivePolicy: "quarantine" });
      expect(codes(result)).toEqual(["dmarc_policy_inherited"]);
    });

    it("falls back to p= when the inherited record has no sp=", async () => {
      const { result } = await check({ [`_dmarc.${D}|TXT`]: [`v=DMARC1; p=none; ${RUA}`] }, "mail.example.com");
      expect(result.status).toBe("warn");
      expect(parsedOf(result).effectivePolicy).toBe("none");
    });

    it("prefers the subdomain's own record", async () => {
      const { result, resolver } = await check(
        {
          "_dmarc.mail.example.com|TXT": ["v=DMARC1; p=reject; rua=mailto:dmarc@example.com"],
          [`_dmarc.${D}|TXT`]: ["v=DMARC1; p=none"],
        },
        "mail.example.com",
      );
      expect(result.status).toBe("pass");
      expect(resolver.countFor(`_dmarc.${D}|TXT`)).toBe(0);
      expect(parsedOf(result).inherited).toBe(false);
    });

    it("fails when neither the subdomain nor the organizational domain publishes DMARC", async () => {
      const { result } = await check({}, "mail.example.com");
      expect(result.status).toBe("fail");
      expect(result.findings[0]?.message).toMatch(/_dmarc\.example\.com/);
    });

    it("is inconclusive when the organizational lookup times out", async () => {
      const { result } = await check({ [`_dmarc.${D}|TXT`]: "TIMEOUT" }, "mail.example.com");
      expect(result.status).toBe("inconclusive");
    });
  });

  describe("external report destinations (RFC 7489 §7.1)", () => {
    const record = "v=DMARC1; p=reject; rua=mailto:reports@dmarc.vendor.net";

    it("passes when the destination authorizes the domain", async () => {
      const { result } = await check({
        [`_dmarc.${D}|TXT`]: [record],
        [`${D}._report._dmarc.dmarc.vendor.net|TXT`]: ["v=DMARC1"],
      });
      expect(result.status).toBe("pass");
      expect(result.evidence.queries.map((q) => q.name)).toContain(`${D}._report._dmarc.dmarc.vendor.net`);
    });

    it("warns when the authorization record is missing", async () => {
      const { result } = await check({ [`_dmarc.${D}|TXT`]: [record] });
      expect(result.status).toBe("warn");
      const finding = result.findings.find((f) => f.code === "dmarc_external_report_unauthorized");
      expect(finding?.message).toMatch(/example\.com\._report\._dmarc\.dmarc\.vendor\.net/);
      expect(finding?.recommendation).toBeTruthy();
    });

    it("uses the policy domain in the authorization name when the policy is inherited", async () => {
      const { result } = await check(
        {
          [`_dmarc.${D}|TXT`]: [record],
          [`${D}._report._dmarc.dmarc.vendor.net|TXT`]: ["v=DMARC1;"],
        },
        "mail.example.com",
      );
      expect(result.status).toBe("pass");
    });

    it("does not check destinations within the same organizational domain", async () => {
      const { result, resolver } = await check({
        [`_dmarc.${D}|TXT`]: ["v=DMARC1; p=reject; rua=mailto:dmarc@reports.example.com"],
      });
      expect(result.status).toBe("pass");
      expect(resolver.queryCount).toBe(1);
    });

    it("cannot pass when the authorization lookup times out", async () => {
      const { result } = await check({
        [`_dmarc.${D}|TXT`]: [record],
        [`${D}._report._dmarc.dmarc.vendor.net|TXT`]: "TIMEOUT",
      });
      expect(result.status).toBe("inconclusive");
      expect(codes(result)).toEqual(["dmarc_external_report_unverified"]);
    });
  });

  it("reports alignment modes: strict is informational, invalid warns", async () => {
    const strict = await check({ [`_dmarc.${D}|TXT`]: [`v=DMARC1; p=reject; adkim=s; aspf=r; ${RUA}`] });
    expect(strict.result.status).toBe("pass");
    expect(strict.result.findings).toEqual([
      expect.objectContaining({ code: "dmarc_strict_alignment", severity: "info" }),
    ]);
    expect(parsedOf(strict.result).alignment).toEqual({ adkim: "s", aspf: "r" });

    const invalid = await check({ [`_dmarc.${D}|TXT`]: [`v=DMARC1; p=reject; aspf=x; ${RUA}`] });
    expect(invalid.result.status).toBe("warn");
    expect(codes(invalid.result)).toEqual(["dmarc_alignment_invalid"]);
  });

  it("is inconclusive on TIMEOUT or SERVFAIL", async () => {
    for (const outcome of ["TIMEOUT", "SERVFAIL"] as const) {
      const { result } = await check({ [`_dmarc.${D}|TXT`]: outcome });
      expect(result.status).toBe("inconclusive");
    }
  });
});
