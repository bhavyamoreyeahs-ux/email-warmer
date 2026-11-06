import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  defaultSelectorsFor,
  estimateKeyBits,
  evaluateDkim,
  inspectDkimKey,
  parseDkim,
  type DkimSelectorResult,
} from "@/lib/dns/dkim";
import { FakeResolver, type FakeZone } from "@/lib/dns/fake-resolver";
import type { CheckResult, DkimSelectorInput } from "@/lib/dns/types";

const D = "example.com";

function rsaKey(modulusLength: number): string {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength });
  return publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

let rsa2048 = "";
let rsa1024 = "";
let rsa512 = "";
let ed25519Raw = "";
let ed25519Spki = "";

beforeAll(() => {
  rsa2048 = rsaKey(2048);
  rsa1024 = rsaKey(1024);
  rsa512 = rsaKey(512);
  const ed = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" });
  ed25519Spki = ed.toString("base64");
  ed25519Raw = ed.subarray(ed.length - 32).toString("base64"); // RFC 8463 publishes the raw 32-byte key
});

const customer = (selector: string): DkimSelectorInput => ({ selector, source: "customer" });
const providerDefault = (selector: string): DkimSelectorInput => ({ selector, source: "provider_default" });

function codes(result: CheckResult): string[] {
  return result.findings.map((f) => f.code);
}

function selectorsOf(result: CheckResult): DkimSelectorResult[] {
  return (result.evidence.parsed?.selectors ?? []) as DkimSelectorResult[];
}

async function check(zone: FakeZone, selectors: DkimSelectorInput[]) {
  const resolver = new FakeResolver(zone);
  return { result: await evaluateDkim(D, resolver, selectors), resolver };
}

describe("estimateKeyBits / inspectDkimKey", () => {
  it("reads the RSA modulus length from SPKI DER", () => {
    expect(estimateKeyBits(rsa2048)).toBe(2048);
    expect(estimateKeyBits(rsa1024)).toBe(1024);
  });

  it("returns null for data that is not a key", () => {
    expect(estimateKeyBits("bm90IGEga2V5")).toBeNull();
    expect(estimateKeyBits("***")).toBeNull();
    expect(estimateKeyBits("")).toBeNull();
  });

  it("recognises Ed25519 keys (raw and SPKI)", () => {
    expect(estimateKeyBits(ed25519Spki)).toBe(256);
    expect(inspectDkimKey(ed25519Raw, "ed25519")).toEqual({ keyType: "ed25519", bits: 256 });
    expect(inspectDkimKey(rsa2048)).toEqual({ keyType: "rsa", bits: 2048 });
  });
});

describe("parseDkim", () => {
  it("parses tags and strips whitespace inside p=", () => {
    const half = Math.floor(rsa2048.length / 2);
    const parsed = parseDkim(`v=DKIM1; k=rsa; t=y:s; h=sha256; s=email; p=${rsa2048.slice(0, half)} ${rsa2048.slice(half)}`);
    expect(parsed.issues).toEqual([]);
    expect(parsed.publicKey).toBe(rsa2048);
    expect(parsed.testing).toBe(true);
    expect(parsed.strictSubdomains).toBe(true);
    expect(parsed.keyType).toBe("rsa");
  });

  it("treats v= as optional but requires DKIM1 when present", () => {
    expect(parseDkim(`p=${rsa2048}`).issues).toEqual([]);
    expect(parseDkim(`v=DKIM2; p=${rsa2048}`).issues.map((i) => i.code)).toEqual(["dkim_invalid_version"]);
  });

  it("detects revoked keys, missing p=, unknown key types and duplicate tags", () => {
    expect(parseDkim("v=DKIM1; p=").publicKey).toBe("");
    expect(parseDkim("v=DKIM1; k=rsa").issues.map((i) => i.code)).toContain("dkim_key_missing");
    expect(parseDkim(`v=DKIM1; k=dsa; p=${rsa2048}`).issues.map((i) => i.code)).toContain("dkim_unknown_key_type");
    expect(parseDkim(`v=DKIM1; p=${rsa2048}; p=${rsa1024}`).issues.map((i) => i.code)).toContain("dkim_duplicate_tag");
  });
});

describe("defaultSelectorsFor", () => {
  it("returns provider default selectors", () => {
    expect(defaultSelectorsFor(["google"])).toEqual([providerDefault("google")]);
    expect(defaultSelectorsFor(["google", "microsoft"]).map((s) => s.selector)).toEqual([
      "google",
      "selector1",
      "selector2",
    ]);
  });
});

describe("evaluateDkim", () => {
  it("is inconclusive when there are no selectors at all", async () => {
    const { result, resolver } = await check({}, []);
    expect(result.status).toBe("inconclusive");
    expect(codes(result)).toEqual(["dkim_no_selectors"]);
    expect(result.findings[0]?.recommendation).toBe(
      "DKIM selectors cannot be discovered from DNS; add the selector from the s= tag of a sent message's DKIM-Signature header.",
    );
    expect(resolver.queryCount).toBe(0);
  });

  it("passes a 2048-bit customer key", async () => {
    const { result } = await check({ [`s1._domainkey.${D}|TXT`]: [`v=DKIM1; k=rsa; p=${rsa2048}`] }, [customer("s1")]);
    expect(result.status).toBe("pass");
    expect(result.findings).toEqual([]);
    expect(result.summary).toMatch(/2048-bit RSA/);
    expect(selectorsOf(result)[0]).toMatchObject({ selector: "s1", state: "valid", bits: 2048, keyType: "rsa" });
    expect(result.evidence.queries[0]).toMatchObject({ name: `s1._domainkey.${D}`, type: "TXT", outcome: "NOERROR" });
  });

  it("warns on a 1024-bit key and recommends 2048", async () => {
    const { result } = await check({ [`s1._domainkey.${D}|TXT`]: [`v=DKIM1; p=${rsa1024}`] }, [customer("s1")]);
    expect(result.status).toBe("warn");
    expect(codes(result)).toEqual(["dkim_key_weak"]);
    expect(result.findings[0]?.recommendation).toMatch(/2048/);
  });

  it("fails on a key shorter than 1024 bits", async () => {
    const { result } = await check({ [`s1._domainkey.${D}|TXT`]: [`v=DKIM1; p=${rsa512}`] }, [customer("s1")]);
    expect(result.status).toBe("fail");
    expect(codes(result)).toEqual(["dkim_key_too_weak"]);
  });

  it("fails on a revoked customer key", async () => {
    const { result } = await check({ [`s1._domainkey.${D}|TXT`]: ["v=DKIM1; k=rsa; p="] }, [customer("s1")]);
    expect(result.status).toBe("fail");
    expect(codes(result)).toEqual(["dkim_key_revoked"]);
  });

  it("treats a revoked provider-default key as informational only", async () => {
    const { result } = await check({ [`google._domainkey.${D}|TXT`]: ["v=DKIM1; p="] }, [providerDefault("google")]);
    expect(result.status).toBe("inconclusive");
    expect(result.findings.every((f) => f.severity === "info")).toBe(true);
    expect(codes(result)).toContain("dkim_default_selector_revoked");
  });

  it("warns on t=y (testing mode)", async () => {
    const { result } = await check({ [`s1._domainkey.${D}|TXT`]: [`v=DKIM1; t=y; p=${rsa2048}`] }, [customer("s1")]);
    expect(result.status).toBe("warn");
    expect(codes(result)).toEqual(["dkim_testing_mode"]);
  });

  it("fails when a customer selector is not published", async () => {
    const { result } = await check({}, [customer("s1")]);
    expect(result.status).toBe("fail");
    expect(result.findings[0]).toMatchObject({
      code: "dkim_selector_not_found",
      severity: "error",
      message: `No DKIM key is published at s1._domainkey.${D}. If this selector is correct, receivers cannot verify signatures made with it — check the selector spelling.`,
    });
  });

  it("fails a missing customer selector even when a provider default is valid", async () => {
    const { result } = await check({ [`google._domainkey.${D}|TXT`]: [`v=DKIM1; p=${rsa2048}`] }, [
      customer("s1"),
      providerDefault("google"),
    ]);
    expect(result.status).toBe("fail");
  });

  it("does not fail when a provider default selector is missing", async () => {
    const { result } = await check({}, [providerDefault("selector1"), providerDefault("selector2")]);
    expect(result.status).toBe("inconclusive");
    expect(result.findings.some((f) => f.severity !== "info")).toBe(false);
    expect(codes(result)).toContain("dkim_no_key_found");
  });

  it("passes when one provider default is valid and another is missing", async () => {
    const { result } = await check({ [`selector1._domainkey.${D}|TXT`]: [`v=DKIM1; k=rsa; p=${rsa2048}`] }, [
      providerDefault("selector1"),
      providerDefault("selector2"),
    ]);
    expect(result.status).toBe("pass");
    expect(codes(result)).toEqual(["dkim_default_selector_not_found"]);
  });

  it("is inconclusive when the only selector times out", async () => {
    const { result } = await check({ [`s1._domainkey.${D}|TXT`]: "TIMEOUT" }, [customer("s1")]);
    expect(result.status).toBe("inconclusive");
    expect(selectorsOf(result)[0]?.state).toBe("inconclusive");
  });

  it("can pass when one selector times out but another holds a valid key", async () => {
    const { result } = await check(
      { [`s1._domainkey.${D}|TXT`]: "TIMEOUT", [`s2._domainkey.${D}|TXT`]: [`v=DKIM1; p=${rsa2048}`] },
      [customer("s1"), customer("s2")],
    );
    expect(result.status).toBe("pass");
    expect(codes(result)).toEqual(["dkim_selector_lookup_failed"]);
  });

  it("fails when the key data cannot be decoded", async () => {
    const { result } = await check({ [`s1._domainkey.${D}|TXT`]: ["v=DKIM1; k=rsa; p=bm90IGEga2V5"] }, [customer("s1")]);
    expect(result.status).toBe("fail");
    expect(codes(result)).toEqual(["dkim_key_unparseable"]);
  });

  it("fails when the TXT record at a customer selector is not a DKIM key", async () => {
    const { result } = await check({ [`s1._domainkey.${D}|TXT`]: ["hello world"] }, [customer("s1")]);
    expect(result.status).toBe("fail");
    expect(codes(result)).toEqual(["dkim_not_a_key"]);
  });

  it("accepts Ed25519 keys with an informational note", async () => {
    const { result } = await check({ [`ed._domainkey.${D}|TXT`]: [`v=DKIM1; k=ed25519; p=${ed25519Raw}`] }, [customer("ed")]);
    expect(result.status).toBe("pass");
    expect(codes(result)).toEqual(["dkim_ed25519_key"]);
    expect(selectorsOf(result)[0]).toMatchObject({ keyType: "ed25519", bits: 256 });
  });

  it("dedupes selectors, preferring the customer source", async () => {
    const { result, resolver } = await check({}, [providerDefault("google"), customer("Google"), customer("google")]);
    expect(resolver.queryCount).toBe(1);
    expect(selectorsOf(result)[0]?.source).toBe("customer");
    expect(result.status).toBe("fail");
  });
});
