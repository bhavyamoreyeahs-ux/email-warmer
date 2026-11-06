import { describe, expect, it } from "vitest";
import { normalizeDomain, organizationalDomain } from "@/lib/dns/domain-name";

function ok(input: string): string {
  const result = normalizeDomain(input);
  if (!result.ok) throw new Error(`expected ${input} to be accepted, got: ${result.error}`);
  return result.domain;
}

function rejected(input: string): string {
  const result = normalizeDomain(input);
  if (result.ok) throw new Error(`expected ${input} to be rejected, got ${result.domain}`);
  return result.error;
}

describe("normalizeDomain", () => {
  it("trims and lowercases", () => {
    expect(ok("  Example.COM  ")).toBe("example.com");
  });

  it("strips a trailing dot", () => {
    expect(ok("example.com.")).toBe("example.com");
  });

  it("accepts pasted URLs (scheme, port, path, query, fragment)", () => {
    expect(ok("https://www.Example.com:8443/path/to?q=1#frag")).toBe("www.example.com");
    expect(ok("http://example.org")).toBe("example.org");
    expect(ok("example.net:25")).toBe("example.net");
  });

  it("accepts pasted email addresses and mailto: links", () => {
    expect(ok("Jane.Doe@Example.co.uk")).toBe("example.co.uk");
    expect(ok("mailto:postmaster@example.com?subject=hi")).toBe("example.com");
    expect(ok("https://user:secret@example.com/")).toBe("example.com");
  });

  it("converts IDNs to A-labels", () => {
    expect(ok("bücher.example")).toBe("xn--bcher-kva.example");
    expect(ok("BÜCHER.example")).toBe("xn--bcher-kva.example");
    expect(ok("xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
  });

  it("accepts registrable domains under multi-label public suffixes", () => {
    expect(ok("example.co.uk")).toBe("example.co.uk");
    expect(ok("mail.example.co.uk")).toBe("mail.example.co.uk");
  });

  it("rejects bare public suffixes", () => {
    expect(rejected("co.uk")).toMatch(/public suffix/);
    expect(rejected("com")).toBeTruthy();
  });

  it("rejects IP literals", () => {
    expect(rejected("192.0.2.1")).toMatch(/IP/);
    expect(rejected("[2001:db8::1]")).toMatch(/IP/);
    expect(rejected("2001:db8::1")).toMatch(/IP/);
    expect(rejected("http://192.0.2.1:8080/")).toMatch(/IP/);
    // The WHATWG host parser treats these as IPv4 shorthand.
    expect(rejected("1.2.3")).toMatch(/IP/);
    expect(rejected("0x7f.1")).toMatch(/IP/);
  });

  it("rejects localhost and other special-use names", () => {
    expect(rejected("localhost")).toBeTruthy();
    expect(rejected("app.localhost")).toMatch(/special-use/);
    expect(rejected("printer.local")).toMatch(/special-use/);
    expect(rejected("router.home.arpa")).toBeTruthy();
  });

  it("rejects single-label names", () => {
    expect(rejected("intranet")).toMatch(/at least two parts/);
  });

  it("rejects invalid labels", () => {
    expect(rejected("-bad.example.com")).toMatch(/not a valid domain label/);
    expect(rejected("bad-.example.com")).toMatch(/not a valid domain label/);
    expect(rejected("foo_bar.example.com")).toMatch(/not a valid domain label/);
    expect(rejected("a..example.com")).toBeTruthy();
    expect(rejected(`${"a".repeat(64)}.com`)).toMatch(/63/);
    expect(rejected("exa mple.com")).toMatch(/spaces/);
  });

  it("rejects names longer than 253 characters", () => {
    const long = `${Array.from({ length: 5 }, () => "a".repeat(60)).join(".")}.com`;
    expect(long.length).toBeGreaterThan(253);
    expect(rejected(long)).toMatch(/too long/);
  });

  it("rejects empty input", () => {
    expect(rejected("   ")).toMatch(/Enter a domain/);
  });
});

describe("organizationalDomain", () => {
  it("returns the registrable domain", () => {
    expect(organizationalDomain("example.com")).toBe("example.com");
    expect(organizationalDomain("mail.eu.example.com")).toBe("example.com");
    expect(organizationalDomain("mail.example.co.uk")).toBe("example.co.uk");
  });

  it("returns null for a bare public suffix", () => {
    expect(organizationalDomain("co.uk")).toBeNull();
  });
});
