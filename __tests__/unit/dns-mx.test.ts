import { describe, expect, it } from "vitest";
import { FakeResolver, type FakeZone } from "@/lib/dns/fake-resolver";
import { detectMxProvider, evaluateMx, providerForExchange, type MxResolvedTarget } from "@/lib/dns/mx";
import type { CheckResult } from "@/lib/dns/types";

const D = "example.com";

function codes(result: CheckResult): string[] {
  return result.findings.map((f) => f.code);
}

function parsedOf(result: CheckResult): Record<string, unknown> {
  return result.evidence.parsed ?? {};
}

async function check(zone: FakeZone) {
  const resolver = new FakeResolver(zone);
  return { result: await evaluateMx(D, resolver), resolver };
}

const GOOGLE_MX = [
  { exchange: "alt4.aspmx.l.google.com", priority: 10 },
  { exchange: "aspmx.l.google.com", priority: 1 },
  { exchange: "alt1.aspmx.l.google.com", priority: 5 },
  { exchange: "alt2.aspmx.l.google.com", priority: 5 },
  { exchange: "alt3.aspmx.l.google.com", priority: 10 },
];

describe("provider detection", () => {
  it("matches on dot boundaries", () => {
    expect(providerForExchange("aspmx.l.google.com")).toBe("google");
    expect(providerForExchange("smtp.google.com")).toBe("google");
    expect(providerForExchange("aspmx2.googlemail.com")).toBe("google");
    expect(providerForExchange("example-com.mail.protection.outlook.com")).toBe("microsoft");
    expect(providerForExchange("notgoogle.com")).toBe("other");
    expect(providerForExchange("mx.example.net")).toBe("other");
  });

  it("uses the most-preferred exchange", () => {
    expect(
      detectMxProvider([
        { exchange: "backup.example.net", priority: 20 },
        { exchange: "example-com.mail.protection.outlook.com", priority: 0 },
      ]),
    ).toBe("microsoft");
    expect(detectMxProvider([])).toBeNull();
  });
});

describe("evaluateMx", () => {
  it("passes Google MX records, sorted, resolving at most three exchanges", async () => {
    const zone: FakeZone = { [`${D}|MX`]: GOOGLE_MX };
    for (const { exchange } of GOOGLE_MX) zone[`${exchange}|A`] = ["192.0.2.10"];
    const { result, resolver } = await check(zone);
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("Mail for example.com is handled by Google Workspace (5 MX records).");
    const parsed = parsedOf(result);
    expect(parsed.provider).toBe("google");
    expect((parsed.records as Array<{ exchange: string }>).map((r) => r.exchange)).toEqual([
      "aspmx.l.google.com",
      "alt1.aspmx.l.google.com",
      "alt2.aspmx.l.google.com",
      "alt3.aspmx.l.google.com",
      "alt4.aspmx.l.google.com",
    ]);
    const targets = parsed.resolvedTargets as MxResolvedTarget[];
    expect(targets.map((t) => t.exchange)).toEqual([
      "aspmx.l.google.com",
      "alt1.aspmx.l.google.com",
      "alt2.aspmx.l.google.com",
    ]);
    expect(resolver.countFor("alt3.aspmx.l.google.com|A")).toBe(0);
    expect(result.evidence.queries[0]).toMatchObject({ name: D, type: "MX", answers: expect.arrayContaining(["1 aspmx.l.google.com"]) });
  });

  it("detects Microsoft 365 and other providers", async () => {
    const ms = await check({
      [`${D}|MX`]: [{ exchange: "example-com.mail.protection.outlook.com", priority: 0 }],
      "example-com.mail.protection.outlook.com|A": ["192.0.2.20"],
    });
    expect(parsedOf(ms.result).provider).toBe("microsoft");
    expect(ms.result.summary).toMatch(/Microsoft 365/);

    const other = await check({
      [`${D}|MX`]: [{ exchange: "mx.mailhost.example.net", priority: 10 }],
      "mx.mailhost.example.net|AAAA": ["2001:db8::25"],
    });
    expect(other.result.status).toBe("pass");
    expect(parsedOf(other.result).provider).toBe("other");
    expect(other.result.summary).toMatch(/mx\.mailhost\.example\.net/);
  });

  it("warns on a null MX (RFC 7505)", async () => {
    const { result } = await check({ [`${D}|MX`]: [{ exchange: "", priority: 0 }] });
    expect(result.status).toBe("warn");
    expect(codes(result)).toEqual(["mx_null_mx"]);
    expect(result.findings[0]?.message).toMatch(/bounces and replies to this domain cannot be received/);
    expect(parsedOf(result).nullMx).toBe(true);
  });

  it("warns when a null MX is mixed with other records", async () => {
    const { result } = await check({
      [`${D}|MX`]: [
        { exchange: "", priority: 0 },
        { exchange: "mx.example.com", priority: 10 },
      ],
      "mx.example.com|A": ["192.0.2.1"],
    });
    expect(result.status).toBe("warn");
    expect(codes(result)).toEqual(["mx_null_mx_with_others"]);
  });

  it("warns on the implicit MX fallback when there is no MX but an A record", async () => {
    const { result } = await check({ [`${D}|MX`]: "NODATA", [`${D}|A`]: ["192.0.2.1"] });
    expect(result.status).toBe("warn");
    expect(codes(result)).toEqual(["mx_implicit_fallback"]);
  });

  it("fails when there is no MX and no address record", async () => {
    const { result } = await check({ [`${D}|MX`]: "NODATA", [`${D}|A`]: "NODATA" });
    expect(result.status).toBe("fail");
    expect(codes(result)).toEqual(["mx_missing"]);
  });

  it("fails when the domain does not exist", async () => {
    const { result, resolver } = await check({});
    expect(result.status).toBe("fail");
    expect(codes(result)).toEqual(["mx_domain_not_found"]);
    expect(resolver.queryCount).toBe(1);
  });

  it("is inconclusive on TIMEOUT or SERVFAIL", async () => {
    for (const outcome of ["TIMEOUT", "SERVFAIL"] as const) {
      const { result } = await check({ [`${D}|MX`]: outcome });
      expect(result.status).toBe("inconclusive");
    }
  });

  it("warns when none of the exchanges resolve", async () => {
    const { result } = await check({ [`${D}|MX`]: [{ exchange: "mx.gone.example.net", priority: 10 }] });
    expect(result.status).toBe("warn");
    expect(codes(result)).toEqual(["mx_targets_unresolvable"]);
  });

  it("notes, without failing, an exchange that does not resolve when others do", async () => {
    const { result } = await check({
      [`${D}|MX`]: [
        { exchange: "mx1.example.com", priority: 10 },
        { exchange: "mx2.example.com", priority: 20 },
      ],
      "mx1.example.com|A": ["192.0.2.1"],
    });
    expect(result.status).toBe("pass");
    expect(result.findings).toEqual([expect.objectContaining({ code: "mx_target_unresolvable", severity: "info" })]);
  });

  it("is inconclusive when exchange lookups time out and none resolve", async () => {
    const { result } = await check({
      [`${D}|MX`]: [{ exchange: "mx1.example.com", priority: 10 }],
      "mx1.example.com|A": "TIMEOUT",
    });
    expect(result.status).toBe("inconclusive");
  });
});
