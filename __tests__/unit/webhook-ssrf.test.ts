import { afterEach, describe, expect, it } from "vitest";
import { isPrivateAddress, postSignedWebhook, validateWebhookUrl } from "@/lib/integrations/webhook";
import { parseEventFilters } from "@/lib/events/search";

describe("webhook SSRF protection", () => {
  afterEach(() => {
    delete process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS;
  });

  it("blocks private and reserved addresses in every textual form", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:a9fe:a9fe", "[::ffff:10.0.0.1]"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.216.34", "2606:4700::1111", "::ffff:5db8:d822"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("rejects literal private hosts (including the IPv4-mapped hex form the URL parser produces), http, credentials and local names", () => {
    for (const url of ["https://[::ffff:127.0.0.1]/hook", "https://127.0.0.1/hook", "https://[::1]/x", "http://example.com/x", "https://user:pass@example.com/x", "https://metadata.internal/x", "https://foo.localhost/x"]) {
      expect(() => validateWebhookUrl(url), url).toThrow();
    }
    expect(validateWebhookUrl("https://hooks.example.com/quikreach").hostname).toBe("hooks.example.com");
  });

  it("refuses at connect time when DNS answers with a private address (no rebinding window)", async () => {
    const r = await postSignedWebhook({ url: "https://localhost.:1/hook", secret: "s", body: {}, idempotencyKey: "k", timeoutMs: 3000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/private|reserved|local/i);
  });
});

describe("event filter parsing", () => {
  it("treats includeSent=false as false (not coerced to true)", () => {
    expect(parseEventFilters(new URLSearchParams("includeSent=false")).includeSent).toBe(false);
    expect(parseEventFilters(new URLSearchParams("includeSent=1")).includeSent).toBe(true);
    expect(parseEventFilters(new URLSearchParams("")).includeSent).toBeUndefined();
  });
});
