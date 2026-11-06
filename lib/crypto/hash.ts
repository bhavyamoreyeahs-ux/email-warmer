/**
 * Hashing helpers.
 *
 *  - sha256Hex: for single-use tokens (invitations, OAuth state) where only a
 *    digest is stored.
 *  - recipientHash: keyed HMAC of a counterparty email address, so QuikReach can
 *    count distinct recipients without storing addresses. The key
 *    (RECIPIENT_HASH_KEY) is a deployment secret; rotating it breaks continuity
 *    of distinct-recipient counts, nothing else.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function recipientHash(orgId: string, address: string): string {
  const key = process.env.RECIPIENT_HASH_KEY;
  if (!key) throw new Error("RECIPIENT_HASH_KEY is not configured");
  return createHmac("sha256", key).update(`${orgId}:${address.trim().toLowerCase()}`).digest("hex").slice(0, 32);
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Truncated hash of a client IP for audit records — enough to correlate, not to identify. */
export function ipHash(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const key = process.env.RECIPIENT_HASH_KEY ?? "ip";
  return createHmac("sha256", key).update(`ip:${ip}`).digest("hex").slice(0, 16);
}
