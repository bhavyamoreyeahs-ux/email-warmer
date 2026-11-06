/**
 * Signed outbound webhooks (campaign control + notifications).
 *
 * Signature: header `X-QuikReach-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`
 * plus `Idempotency-Key`. Receivers must verify the signature and reject
 * timestamps older than 5 minutes (docs/integrations.md has a reference
 * verifier).
 *
 * SSRF protection
 *  - HTTPS only in production; no credentials in the URL; redirects are not followed.
 *  - Reserved / private / loopback / link-local / CGNAT / multicast / documentation
 *    ranges are blocked for IPv4, IPv6 and IPv4-mapped IPv6 (any textual form).
 *  - The check runs INSIDE the socket's DNS lookup, so the address that was
 *    validated is the address that is connected to — DNS rebinding between a
 *    pre-check and the request is not possible.
 *  - ALLOW_PRIVATE_WEBHOOK_TARGETS (local development only) is rejected in
 *    production by lib/env.ts.
 */
import { createHmac } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { env } from "@/lib/env";

export function signPayload(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** Extracts the IPv4 address from an IPv4-mapped IPv6 address in dotted or hex form. */
function mappedIpv4(ip: string): string | null {
  const v6 = ip.toLowerCase();
  const dotted = v6.match(/^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1]!;
  const hex = v6.match(/^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = Number.parseInt(hex[1]!, 16);
    const lo = Number.parseInt(hex[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

export function isPrivateAddress(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, "");
  const family = isIP(clean);
  if (family === 4) return blocked.check(clean, "ipv4");
  if (family === 6) {
    const v4 = mappedIpv4(clean);
    if (v4) return blocked.check(v4, "ipv4");
    return blocked.check(clean, "ipv6");
  }
  return true; // not an IP literal at all — refuse rather than guess
}

/** Syntactic checks on the URL (scheme, credentials, literal IPs). */
export function validateWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Webhook URL is not a valid URL.");
  }
  const e = env();
  const allowInsecure = e.NODE_ENV !== "production" && e.ALLOW_PRIVATE_WEBHOOK_TARGETS;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowInsecure)) throw new Error("Webhook URLs must use https://.");
  if (url.username || url.password) throw new Error("Webhook URLs must not contain credentials.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!allowInsecure && isIP(host) && isPrivateAddress(host)) throw new Error("Webhook URL points to a private or reserved network address, which is not allowed.");
  if (!allowInsecure && /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error("Webhook URL points to a local hostname, which is not allowed.");
  return url;
}

/** Kept for callers that validate at configuration time (also resolves DNS once for an early, friendly error). */
export async function assertSafeWebhookUrl(raw: string): Promise<URL> {
  const url = validateWebhookUrl(raw);
  const e = env();
  if (e.NODE_ENV !== "production" && e.ALLOW_PRIVATE_WEBHOOK_TARGETS) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!isIP(host)) {
    const addresses = await new Promise<LookupAddress[]>((resolve, reject) =>
      dnsLookup(host, { all: true, verbatim: true }, (err, addrs) => (err ? reject(new Error("Webhook host could not be resolved.")) : resolve(addrs))),
    );
    if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
      throw new Error("Webhook URL resolves to a private or reserved network address, which is not allowed.");
    }
  }
  return url;
}

/** DNS lookup used by the socket itself: refuses private answers at connect time. */
function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: { all?: boolean; family?: number } | number, callback: (...args: unknown[]) => void) => {
    const opts = typeof options === "number" ? { family: options } : options;
    dnsLookup(hostname, { ...opts, all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err);
      const safe = allowPrivate ? addresses : addresses.filter((a) => !isPrivateAddress(a.address));
      if (!safe.length) return callback(Object.assign(new Error("Webhook host resolves only to private or reserved addresses."), { code: "EBLOCKED" }));
      if (opts.all) return callback(null, safe);
      return callback(null, safe[0]!.address, safe[0]!.family);
    });
  };
}

export interface WebhookResult {
  ok: boolean;
  status: number | null;
  json: Record<string, unknown> | null;
  error: string | null;
  durationMs: number;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function nodeRequest(url: URL, headers: Record<string, string>, body: string, timeoutMs: number, allowPrivate: boolean): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      { method: "POST", headers: { ...headers, "content-length": String(Buffer.byteLength(body)) }, lookup: guardedLookup(allowPrivate) as never, timeout: timeoutMs },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size <= 10_000) chunks.push(c);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8").slice(0, 10_000) }));
        res.on("error", reject);
      },
    );
    // Hard deadline for the whole exchange: `timeout` alone only covers socket
    // inactivity, so a slow-drip endpoint could otherwise hold a worker slot.
    const deadline = setTimeout(() => req.destroy(Object.assign(new Error("Timed out"), { name: "AbortError" })), timeoutMs);
    req.on("close", () => clearTimeout(deadline));
    req.on("timeout", () => req.destroy(Object.assign(new Error("Timed out"), { name: "AbortError" })));
    req.on("error", reject);
    req.end(body);
  });
}

export async function postSignedWebhook(input: { url: string; secret: string; body: Record<string, unknown>; idempotencyKey: string; timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<WebhookResult> {
  const started = Date.now();
  const body = JSON.stringify(input.body);
  const headers = {
    "content-type": "application/json",
    "user-agent": "QuikReach-Webhook/1.0",
    "idempotency-key": input.idempotencyKey,
    "x-quikreach-signature": signPayload(input.secret, body),
  };
  try {
    const url = validateWebhookUrl(input.url);
    const e = env();
    const allowPrivate = e.NODE_ENV !== "production" && e.ALLOW_PRIVATE_WEBHOOK_TARGETS;
    let status: number;
    let text: string;
    if (input.fetchImpl) {
      // Test seam only: production always uses the guarded socket path below.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 10_000);
      try {
        const res = await input.fetchImpl(url, { method: "POST", redirect: "manual", signal: controller.signal, headers, body });
        status = res.status;
        text = (await res.text()).slice(0, 10_000);
      } finally {
        clearTimeout(timer);
      }
    } else {
      ({ status, text } = await nodeRequest(url, headers, body, input.timeoutMs ?? 10_000, allowPrivate));
    }
    const ok = status >= 200 && status < 300;
    return { ok, status, json: parseJsonObject(text), error: ok ? null : `HTTP ${status}`, durationMs: Date.now() - started };
  } catch (error: unknown) {
    const message = error instanceof Error ? (error.name === "AbortError" ? "Timed out" : error.message) : "Request failed";
    return { ok: false, status: null, json: null, error: message.slice(0, 300), durationMs: Date.now() - started };
  }
}
