import { describe, expect, it } from "vitest";
import { FakeResolver, type FakeZone } from "@/lib/dns/fake-resolver";
import {
  evaluateSpf,
  expectedSpfIncludesFor,
  parseSpf,
  type SpfIncludeNode,
  type SpfMechanismTerm,
} from "@/lib/dns/spf";
import type { CheckResult } from "@/lib/dns/types";

const D = "example.com";

function codes(result: CheckResult): string[] {
  return result.findings.map((f) => f.code);
}

function parsedOf(result: CheckResult): Record<string, unknown> {
  return result.evidence.parsed ?? {};
}

async function check(zone: FakeZone, expectedIncludes?: string[]) {
  const resolver = new FakeResolver(zone);
  const result = await evaluateSpf(D, resolver, expectedIncludes ? { expectedIncludes } : {});
  return { result, resolver };
}

/** example.com → inc1 → inc2 → … → inc<n>, each counting one include lookup. */
function includeChain(n: number): FakeZone {
  const zone: FakeZone = { [`${D}|TXT`]: ["v=spf1 include:inc1.example.net -all"] };
  for (let i = 1; i <= n; i++) {
    zone[`inc${i}.example.net|TXT`] =
      i < n ? [`v=spf1 include:inc${i + 1}.example.net ~all`] : ["v=spf1 ip4:192.0.2.0/24 ~all"];
  }
  return zone;
}

describe("parseSpf", () => {
  it("parses qualifiers, mechanisms and modifiers", () => {
    const parsed = parseSpf(
      "v=spf1 +a mx:mail.example.com/24 -ip4:192.0.2.0/24 ~ip6:2001:db8::/32 ?include:_spf.example.net exists:%{i}.bl.example.org ptr a//64 exp=explain.example.com redirect=_spf.example.com",
    );
    expect(parsed.errors).toEqual([]);
    const mechanisms = parsed.terms.filter((t): t is SpfMechanismTerm => t.kind === "mechanism");
    expect(mechanisms.map((m) => `${m.qualifier}${m.mechanism}`)).toEqual([
      "+a",
      "+mx",
      "-ip4",
      "~ip6",
      "?include",
      "+exists",
      "+ptr",
      "+a",
    ]);
    expect(mechanisms[1]).toMatchObject({ value: "mail.example.com", cidr4: 24 });
    expect(mechanisms[2]).toMatchObject({ value: "192.0.2.0", cidr4: 24 });
    expect(mechanisms[3]).toMatchObject({ value: "2001:db8::", cidr6: 32 });
    expect(mechanisms[7]).toMatchObject({ value: null, cidr4: null, cidr6: 64 });
    const modifiers = parsed.terms.filter((t) => t.kind === "modifier");
    expect(modifiers.map((m) => m.raw)).toEqual(["exp=explain.example.com", "redirect=_spf.example.com"]);
  });

  it("reports syntax errors", () => {
    const parsed = parseSpf(
      "v=spf1 ip4:300.1.1.1 ip6:zz::1 ip4:192.0.2.0/33 foo:bar include: all:x redirect=a.example.com redirect=b.example.com include:bad%domain.com",
    );
    expect(parsed.errors.length).toBe(8);
    expect(parsed.errors.join(" ")).toMatch(/unknown mechanism "foo"/);
    expect(parsed.errors.join(" ")).toMatch(/redirect= modifier appears more than once/);
  });

  it("ignores unknown modifiers, as receivers do", () => {
    expect(parseSpf("v=spf1 foo=bar -all").errors).toEqual([]);
  });

  it("requires the v=spf1 prefix", () => {
    expect(parseSpf("v=spf10 -all").errors).toEqual(["The record does not start with v=spf1."]);
  });
});

describe("evaluateSpf", () => {
  it("passes a valid record and records evidence for every query", async () => {
    const { result } = await check({
      [`${D}|TXT`]: ["google-site-verification=abc", "v=spf1 include:_spf.google.com -all"],
      "_spf.google.com|TXT": ["v=spf1 include:_netblocks.google.com ~all"],
      "_netblocks.google.com|TXT": ["v=spf1 ip4:35.190.247.0/24 ip6:2001:4860:4000::/36 ~all"],
    });
    expect(result.status).toBe("pass");
    expect(result.checkType).toBe("spf");
    expect(result.resolver).toBe("fake");
    expect(result.ruleVersion).toBe("spf-2026.10.1");
    expect(result.summary).toMatch(/2 of the 10/);
    expect(result.evidence.queries.map((q) => q.name)).toEqual([D, "_spf.google.com", "_netblocks.google.com"]);
    expect(result.evidence.queries[0]).toMatchObject({
      type: "TXT",
      outcome: "NOERROR",
      answers: ["google-site-verification=abc", "v=spf1 include:_spf.google.com -all"],
    });
    expect(typeof result.evidence.queries[0]?.durationMs).toBe("number");
    const parsed = parsedOf(result);
    expect(parsed.lookupCount).toBe(2);
    expect(parsed.voidLookups).toBe(0);
    expect(parsed.record).toBe("v=spf1 include:_spf.google.com -all");
    const tree = parsed.includeTree as SpfIncludeNode;
    expect(tree.children[0]?.domain).toBe("_spf.google.com");
    expect(tree.children[0]?.children[0]?.domain).toBe("_netblocks.google.com");
  });

  it("fails when no SPF record is published", async () => {
    const { result } = await check({ [`${D}|TXT`]: ["some-other=txt"] });
    expect(result.status).toBe("fail");
    expect(codes(result)).toEqual(["spf_missing"]);
    expect(result.findings[0]?.recommendation).toMatch(/v=spf1/);
  });

  it("fails when the domain has no TXT records at all (NODATA / NXDOMAIN)", async () => {
    expect((await check({ [`${D}|TXT`]: "NODATA" })).result.status).toBe("fail");
    const nx = (await check({})).result;
    expect(nx.status).toBe("fail");
    expect(nx.findings[0]?.message).toMatch(/does not exist/);
  });

  it("names expected includes in the example record when SPF is missing", async () => {
    const { result } = await check({ [`${D}|TXT`]: "NODATA" }, ["_spf.google.com"]);
    expect(result.findings[0]?.recommendation).toMatch(/include:_spf\.google\.com/);
  });

  it("fails with permerror when more than one SPF record exists", async () => {
    const { result } = await check({ [`${D}|TXT`]: ["v=spf1 -all", "v=spf1 include:_spf.google.com ~all"] });
    expect(result.status).toBe("fail");
    expect(codes(result)).toEqual(["spf_multiple_records"]);
    expect(result.summary).toMatch(/more than one SPF record/);
  });

  it("fails on syntax errors", async () => {
    const { result } = await check({ [`${D}|TXT`]: ["v=spf1 ip4:999.0.0.1 -all"] });
    expect(result.status).toBe("fail");
    expect(codes(result)).toEqual(["spf_syntax_error"]);
  });

  it("fails on +all and bare all", async () => {
    for (const record of ["v=spf1 +all", "v=spf1 a all"]) {
      const { result } = await check({ [`${D}|TXT`]: [record], [`${D}|A`]: ["192.0.2.1"] });
      expect(result.status).toBe("fail");
      expect(codes(result)).toContain("spf_allows_all");
    }
  });

  it("warns on ?all", async () => {
    const { result } = await check({ [`${D}|TXT`]: ["v=spf1 ip4:192.0.2.1 ?all"] });
    expect(result.status).toBe("warn");
    expect(codes(result)).toEqual(["spf_neutral_all"]);
  });

  it("accepts ~all with an informational note that -all is stricter", async () => {
    const { result } = await check({ [`${D}|TXT`]: ["v=spf1 ip4:192.0.2.1 ~all"] });
    expect(result.status).toBe("pass");
    expect(result.findings).toEqual([expect.objectContaining({ code: "spf_softfail_all", severity: "info" })]);
  });

  it("warns when there is no all and no redirect", async () => {
    const { result } = await check({ [`${D}|TXT`]: ["v=spf1 ip4:192.0.2.1"] });
    expect(result.status).toBe("warn");
    expect(codes(result)).toEqual(["spf_no_all"]);
  });

  it("follows redirect= for the effective all policy", async () => {
    const good = await check({
      [`${D}|TXT`]: ["v=spf1 redirect=_spf.example.net"],
      "_spf.example.net|TXT": ["v=spf1 ip4:192.0.2.0/24 -all"],
    });
    expect(good.result.status).toBe("pass");
    expect(parsedOf(good.result).effectiveAll).toBe("-");
    expect(parsedOf(good.result).lookupCount).toBe(1);

    const open = await check({
      [`${D}|TXT`]: ["v=spf1 redirect=_spf.example.net"],
      "_spf.example.net|TXT": ["v=spf1 +all"],
    });
    expect(open.result.status).toBe("fail");
    expect(codes(open.result)).toContain("spf_allows_all");
  });

  it("ignores redirect= when the record has an all mechanism", async () => {
    const { result, resolver } = await check({ [`${D}|TXT`]: ["v=spf1 -all redirect=_spf.example.net"] });
    expect(codes(result)).toContain("spf_redirect_ignored");
    expect(resolver.countFor("_spf.example.net|TXT")).toBe(0);
  });

  it("warns that ptr is deprecated", async () => {
    const { result } = await check({ [`${D}|TXT`]: ["v=spf1 ptr -all"] });
    expect(result.status).toBe("warn");
    expect(codes(result)).toEqual(["spf_ptr_deprecated"]);
    expect(result.findings[0]?.message).toMatch(/RFC 7208 §5\.5/);
  });

  it("fails when the include chain needs more than 10 DNS lookups", async () => {
    const { result } = await check(includeChain(11));
    expect(result.status).toBe("fail");
    expect(codes(result)).toContain("spf_too_many_lookups");
    expect(parsedOf(result).lookupCount).toBe(11);
    expect(result.summary).toMatch(/more than 10 DNS lookups/);
  });

  it("warns when 9 or 10 lookups are used", async () => {
    for (const n of [9, 10]) {
      const { result } = await check(includeChain(n));
      expect(result.status).toBe("warn");
      expect(codes(result)).toContain("spf_lookups_near_limit");
      expect(parsedOf(result).lookupCount).toBe(n);
    }
    const eight = await check(includeChain(8));
    expect(eight.result.status).toBe("pass");
  });

  it("counts a, mx, ptr and exists lookups across the tree", async () => {
    const { result } = await check({
      [`${D}|TXT`]: ["v=spf1 a mx include:_spf.example.net exists:%{i}.example.org -all"],
      [`${D}|A`]: ["192.0.2.1"],
      [`${D}|MX`]: [{ exchange: "mx.example.com", priority: 10 }],
      "_spf.example.net|TXT": ["v=spf1 a:relay.example.net ptr ~all"],
      "relay.example.net|A": ["192.0.2.2"],
    });
    expect(parsedOf(result).lookupCount).toBe(6);
    expect(codes(result)).toContain("spf_ptr_deprecated");
    // An exists: macro is normal and still counts as exactly one lookup.
    expect(codes(result)).not.toContain("spf_macro_not_expanded");
    expect(parsedOf(result).lookupCountIsLowerBound).toBe(false);
  });

  it("treats an include with macros as a lower-bound lookup count without blocking a pass", async () => {
    const { result, resolver } = await check({ [`${D}|TXT`]: ["v=spf1 include:%{ir}.%{v}._spf.example.net -all"] });
    expect(result.status).toBe("pass");
    expect(codes(result)).toEqual(["spf_macro_not_expanded"]);
    expect(parsedOf(result)).toMatchObject({ lookupCount: 1, lookupCountIsLowerBound: true });
    expect(resolver.queryCount).toBe(1);
  });

  it("detects include loops without recursing forever", async () => {
    const { result, resolver } = await check({
      [`${D}|TXT`]: ["v=spf1 include:a.example.net -all"],
      "a.example.net|TXT": ["v=spf1 include:b.example.net ~all"],
      "b.example.net|TXT": ["v=spf1 include:a.example.net ~all"],
    });
    expect(result.status).toBe("fail");
    expect(codes(result)).toContain("spf_include_loop");
    expect(resolver.queryCount).toBeLessThanOrEqual(3);
  });

  it("detects an include of the domain itself", async () => {
    const { result } = await check({ [`${D}|TXT`]: [`v=spf1 include:${D} -all`] });
    expect(codes(result)).toContain("spf_include_loop");
    expect(result.status).toBe("fail");
  });

  it("warns on more than two void lookups", async () => {
    const { result } = await check({
      [`${D}|TXT`]: ["v=spf1 a:gone1.example.com a:gone2.example.com mx:gone3.example.com -all"],
      "gone2.example.com|A": "NODATA",
    });
    expect(parsedOf(result).voidLookups).toBe(3);
    expect(result.status).toBe("warn");
    expect(codes(result)).toContain("spf_too_many_void_lookups");
  });

  it("fails when an include points to a domain with no SPF record", async () => {
    const { result } = await check({ [`${D}|TXT`]: ["v=spf1 include:typo.example.net -all"] });
    expect(result.status).toBe("fail");
    expect(codes(result)).toContain("spf_include_no_record");
    expect(parsedOf(result).voidLookups).toBe(1);
  });

  it("fails when an included record is broken", async () => {
    const { result } = await check({
      [`${D}|TXT`]: ["v=spf1 include:_spf.example.net -all"],
      "_spf.example.net|TXT": ["v=spf1 ip4:not-an-ip ~all"],
    });
    expect(codes(result)).toContain("spf_include_invalid");
    expect(result.status).toBe("fail");
  });

  it("fails when an mx mechanism targets more than 10 MX records", async () => {
    const records = Array.from({ length: 11 }, (_, i) => ({ exchange: `mx${i}.example.com`, priority: i }));
    const { result } = await check({ [`${D}|TXT`]: ["v=spf1 mx -all"], [`${D}|MX`]: records });
    expect(codes(result)).toContain("spf_mx_too_many_records");
    expect(result.status).toBe("fail");
  });

  it("is inconclusive (never pass) when an include times out", async () => {
    const { result } = await check({
      [`${D}|TXT`]: ["v=spf1 include:slow.example.net -all"],
      "slow.example.net|TXT": "TIMEOUT",
    });
    expect(result.status).toBe("inconclusive");
    expect(codes(result)).toEqual(["spf_include_unresolved"]);
    expect(parsedOf(result).lookupCountIsLowerBound).toBe(true);
    expect(parsedOf(result).unresolvedIncludes).toEqual(["slow.example.net"]);
    expect(result.findings[0]?.message).toMatch(/at least 1/);
  });

  it("reports other problems alongside an unresolved include (warn, not pass)", async () => {
    const { result } = await check({
      [`${D}|TXT`]: ["v=spf1 include:slow.example.net ?all"],
      "slow.example.net|TXT": "SERVFAIL",
    });
    expect(result.status).toBe("warn");
    expect(codes(result)).toEqual(expect.arrayContaining(["spf_neutral_all", "spf_include_unresolved"]));
  });

  it("is inconclusive when the apex TXT lookup times out or SERVFAILs", async () => {
    for (const outcome of ["TIMEOUT", "SERVFAIL"] as const) {
      const { result } = await check({ [`${D}|TXT`]: outcome });
      expect(result.status).toBe("inconclusive");
      expect(result.evidence.queries[0]?.outcome).toBe(outcome);
    }
  });

  describe("expected includes", () => {
    it("maps providers to their includes", () => {
      expect(expectedSpfIncludesFor(["google", "microsoft", "google"])).toEqual([
        "_spf.google.com",
        "spf.protection.outlook.com",
      ]);
    });

    it("is satisfied by an include anywhere in the tree", async () => {
      const { result } = await check(
        {
          [`${D}|TXT`]: ["v=spf1 include:_spf.example.net -all"],
          "_spf.example.net|TXT": ["v=spf1 include:_spf.google.com ~all"],
          "_spf.google.com|TXT": ["v=spf1 ip4:192.0.2.0/24 ~all"],
        },
        ["_spf.google.com"],
      );
      expect(result.status).toBe("pass");
      expect(parsedOf(result).missingExpectedIncludes).toEqual([]);
    });

    it("warns and names the include when it is missing", async () => {
      const { result } = await check({ [`${D}|TXT`]: ["v=spf1 ip4:192.0.2.0/24 -all"] }, ["spf.protection.outlook.com"]);
      expect(result.status).toBe("warn");
      const finding = result.findings.find((f) => f.code === "spf_expected_include_missing");
      expect(finding?.message).toMatch(/Microsoft 365/);
      expect(finding?.recommendation).toMatch(/include:spf\.protection\.outlook\.com/);
    });

    it("does not claim an include is missing when part of the tree is unresolved", async () => {
      const { result } = await check(
        {
          [`${D}|TXT`]: ["v=spf1 include:slow.example.net -all"],
          "slow.example.net|TXT": "TIMEOUT",
        },
        ["_spf.google.com"],
      );
      expect(result.status).toBe("inconclusive");
      expect(codes(result)).toContain("spf_expected_include_unverified");
      expect(codes(result)).not.toContain("spf_expected_include_missing");
    });
  });
});
