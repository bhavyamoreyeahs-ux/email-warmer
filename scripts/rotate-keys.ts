/**
 * Re-encrypt stored secrets with the ACTIVE encryption key: `npm run keys:rotate`.
 *
 * Rotation procedure (docs/security.md):
 *   1. Prepend a new key: TOKEN_ENCRYPTION_KEYS="new:...,old:..." and deploy (old values still decrypt).
 *   2. Run this script — mailbox credentials, integration secrets and pending OAuth verifiers are re-encrypted.
 *   3. Confirm the summary shows no rows left on the old key id, then remove the old key and deploy.
 * Idempotent: rows already on the active key are skipped. Updates are conditional on
 * the ciphertext read, so a token refreshed concurrently is left as is (re-run to pick it up).
 */
import { and, eq, isNull } from "drizzle-orm";
import { db, closeDb } from "@/lib/db";
import { integrations, mailboxCredentials, oauthStates } from "@/lib/db/schema";
import { activeKeyId, decryptSecret, encryptSecret, keyIdOf } from "@/lib/crypto/encryption";

async function main() {
  const active = activeKeyId();
  const summary = { activeKey: active, mailboxCredentials: 0, integrationSecrets: 0, oauthStates: 0, remainingOnOldKeys: 0 };

  for (const row of await db.select().from(mailboxCredentials)) {
    const needs = [row.encryptedAccessToken, row.encryptedRefreshToken].some((v) => v && keyIdOf(v) !== active);
    if (!needs) continue;
    await db
      .update(mailboxCredentials)
      .set({
        encryptedAccessToken: encryptSecret(decryptSecret(row.encryptedAccessToken)),
        encryptedRefreshToken: row.encryptedRefreshToken ? encryptSecret(decryptSecret(row.encryptedRefreshToken)) : null,
        keyId: active,
        updatedAt: new Date(),
      })
      // Conditional on the values we read, so a concurrent token refresh is never overwritten.
      .where(
        and(
          eq(mailboxCredentials.connectionId, row.connectionId),
          eq(mailboxCredentials.encryptedAccessToken, row.encryptedAccessToken),
          row.encryptedRefreshToken ? eq(mailboxCredentials.encryptedRefreshToken, row.encryptedRefreshToken) : isNull(mailboxCredentials.encryptedRefreshToken),
        ),
      );
    summary.mailboxCredentials += 1;
  }
  for (const row of await db.select().from(integrations)) {
    if (!row.encryptedSecret || keyIdOf(row.encryptedSecret) === active) continue;
    await db.update(integrations).set({ encryptedSecret: encryptSecret(decryptSecret(row.encryptedSecret)), keyId: active, updatedAt: new Date() }).where(and(eq(integrations.id, row.id), eq(integrations.encryptedSecret, row.encryptedSecret)));
    summary.integrationSecrets += 1;
  }
  for (const row of await db.select().from(oauthStates)) {
    if (keyIdOf(row.encryptedCodeVerifier) === active) continue;
    await db.update(oauthStates).set({ encryptedCodeVerifier: encryptSecret(decryptSecret(row.encryptedCodeVerifier)) }).where(eq(oauthStates.id, row.id));
    summary.oauthStates += 1;
  }
  const all = [
    ...(await db.select({ a: mailboxCredentials.encryptedAccessToken, r: mailboxCredentials.encryptedRefreshToken }).from(mailboxCredentials)).flatMap((r) => [r.a, r.r]),
    ...(await db.select({ s: integrations.encryptedSecret }).from(integrations)).map((r) => r.s),
  ].filter((v): v is string => Boolean(v));
  summary.remainingOnOldKeys = all.filter((v) => keyIdOf(v) !== active).length;
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .then(() => closeDb())
  .catch(async (error: unknown) => {
    console.error("[rotate-keys] failed:", error instanceof Error ? error.message : error);
    await closeDb();
    process.exit(1);
  });
