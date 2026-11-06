/**
 * Authenticated encryption for credentials at rest (OAuth tokens, integration
 * signing secrets, PKCE verifiers).
 *
 * AES-256-GCM with a random 96-bit IV per value. Ciphertext format:
 *   v1.<keyId>.<iv b64url>.<tag b64url>.<ciphertext b64url>
 *
 * Keys come from TOKEN_ENCRYPTION_KEYS="newKeyId:base64key,oldKeyId:base64key".
 * The FIRST key encrypts; every listed key can decrypt, which is how rotation
 * works (add a new key first, re-encrypt, then remove the old one). In
 * production these values must come from the platform secret manager / KMS —
 * see docs/security.md. The `KeyProvider` seam is where a KMS-backed provider
 * plugs in.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface KeyProvider {
  activeKeyId(): string;
  key(keyId: string): Buffer | undefined;
}

class EnvKeyProvider implements KeyProvider {
  private readonly keys = new Map<string, Buffer>();
  private readonly active: string;

  constructor(spec: string) {
    const entries = spec.split(",").map((s) => s.trim()).filter(Boolean);
    if (!entries.length) throw new Error("TOKEN_ENCRYPTION_KEYS is empty");
    for (const entry of entries) {
      const idx = entry.indexOf(":");
      if (idx <= 0) throw new Error("TOKEN_ENCRYPTION_KEYS entries must be keyId:base64key");
      const id = entry.slice(0, idx);
      const key = Buffer.from(entry.slice(idx + 1), "base64");
      if (key.length !== 32) throw new Error(`Encryption key ${id} must decode to exactly 32 bytes`);
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error("Encryption key ids must be [A-Za-z0-9_-]{1,32}");
      this.keys.set(id, key);
    }
    this.active = entries[0]!.slice(0, entries[0]!.indexOf(":"));
  }

  activeKeyId() {
    return this.active;
  }
  key(keyId: string) {
    return this.keys.get(keyId);
  }
}

let provider: KeyProvider | null = null;
let providerSpec: string | undefined;

function getProvider(): KeyProvider {
  const spec = process.env.TOKEN_ENCRYPTION_KEYS;
  if (!spec) throw new Error("TOKEN_ENCRYPTION_KEYS is not configured; credentials cannot be stored.");
  if (!provider || spec !== providerSpec) {
    provider = new EnvKeyProvider(spec);
    providerSpec = spec;
  }
  return provider;
}

export function activeKeyId(): string {
  return getProvider().activeKeyId();
}

export function encryptSecret(plaintext: string): string {
  const p = getProvider();
  const keyId = p.activeKeyId();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", p.key(keyId)!, iv);
  cipher.setAAD(Buffer.from(`quikreach:${keyId}`));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", keyId, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 5 || parts[0] !== "v1") throw new Error("Unrecognised ciphertext format");
  const [, keyId, ivB64, tagB64, ctB64] = parts as [string, string, string, string, string];
  const key = getProvider().key(keyId);
  if (!key) throw new Error(`Encryption key ${keyId} is not available; cannot decrypt`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  decipher.setAAD(Buffer.from(`quikreach:${keyId}`));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
}

/** Key id embedded in a ciphertext (for rotation reporting). */
export function keyIdOf(payload: string): string | null {
  const parts = payload.split(".");
  return parts.length === 5 ? (parts[1] ?? null) : null;
}
