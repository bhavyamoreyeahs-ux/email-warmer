/**
 * PKCE (RFC 7636, S256) and OAuth `state` generation for the mailbox connect flow.
 *
 * The verifier and state are stored server-side (encrypted / in a signed,
 * short-lived record) by the caller and compared on the callback.
 */
import { createHash, randomBytes } from "node:crypto";

export interface PkcePair {
  /** 64 random bytes, base64url → 86 characters (RFC 7636 allows 43–128). */
  verifier: string;
  /** base64url(SHA-256(verifier)), sent as code_challenge with method S256. */
  challenge: string;
}

export function computeCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function createPkcePair(): PkcePair {
  const verifier = randomBytes(64).toString("base64url");
  return { verifier, challenge: computeCodeChallenge(verifier) };
}

/** 32 random bytes, base64url. Single-use CSRF/state token for the OAuth round trip. */
export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}
