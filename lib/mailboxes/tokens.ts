/**
 * Access-token lifecycle for mailbox connections.
 *
 * Tokens are decrypted only in memory, only in the worker/callback path, and
 * never logged or returned by any API. Refresh failures that mean "the user
 * must act" (revoked / expired grant / scope removed / admin policy) move the
 * connection to `reauth_required` and stop retries; transient failures bubble
 * up as retryable.
 */
import { and, eq } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import { mailboxConnections, mailboxCredentials } from "@/lib/db/schema";
import { activeKeyId, decryptSecret, encryptSecret } from "@/lib/crypto/encryption";
import { getAdapter } from "@/lib/mailboxes/providers/registry";
import { ProviderError, type OAuthProvider, type TokenSet } from "@/lib/mailboxes/providers/types";

export const REAUTH_CODES = new Set(["auth_revoked", "insufficient_scope", "admin_consent_required", "consent_denied"]);

export async function storeTokens(orgId: string, connectionId: string, tokens: TokenSet, executor: Executor = db) {
  const values = {
    connectionId,
    orgId,
    encryptedAccessToken: encryptSecret(tokens.accessToken),
    encryptedRefreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
    accessTokenExpiresAt: tokens.expiresAt,
    keyId: activeKeyId(),
    updatedAt: new Date(),
  };
  await executor
    .insert(mailboxCredentials)
    .values(values)
    .onConflictDoUpdate({
      target: mailboxCredentials.connectionId,
      set: {
        encryptedAccessToken: values.encryptedAccessToken,
        // Providers may omit the refresh token on refresh — keep the old one then.
        ...(values.encryptedRefreshToken ? { encryptedRefreshToken: values.encryptedRefreshToken } : {}),
        accessTokenExpiresAt: values.accessTokenExpiresAt,
        keyId: values.keyId,
        updatedAt: values.updatedAt,
      },
    });
}

export async function deleteTokens(orgId: string, connectionId: string, executor: Executor = db) {
  await executor.delete(mailboxCredentials).where(and(eq(mailboxCredentials.connectionId, connectionId), eq(mailboxCredentials.orgId, orgId)));
}

export async function loadTokens(orgId: string, connectionId: string): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: Date | null } | null> {
  const [row] = await db
    .select()
    .from(mailboxCredentials)
    .where(and(eq(mailboxCredentials.connectionId, connectionId), eq(mailboxCredentials.orgId, orgId)))
    .limit(1);
  if (!row) return null;
  return {
    accessToken: decryptSecret(row.encryptedAccessToken),
    refreshToken: row.encryptedRefreshToken ? decryptSecret(row.encryptedRefreshToken) : null,
    expiresAt: row.accessTokenExpiresAt,
  };
}

export async function markReauthRequired(orgId: string, connectionId: string, reason: string, code: string) {
  await db
    .update(mailboxConnections)
    .set({ state: "reauth_required", stateReason: reason, lastErrorCode: code, lastErrorMessage: reason, nextSyncAt: null, updatedAt: new Date() })
    .where(and(eq(mailboxConnections.id, connectionId), eq(mailboxConnections.orgId, orgId)));
}

/** Returns a usable access token, refreshing when it expires within 2 minutes. */
export async function getValidAccessToken(orgId: string, connectionId: string, provider: OAuthProvider): Promise<string> {
  const tokens = await loadTokens(orgId, connectionId);
  if (!tokens) {
    await markReauthRequired(orgId, connectionId, "No stored credentials. Reconnect the mailbox.", "auth_revoked");
    throw new ProviderError("auth_revoked", "No stored credentials for this mailbox.");
  }
  const fresh = tokens.expiresAt && tokens.expiresAt.getTime() - Date.now() > 120_000;
  if (fresh) return tokens.accessToken;
  if (!tokens.refreshToken) {
    await markReauthRequired(orgId, connectionId, "Access expired and no refresh token was granted. Reconnect the mailbox.", "auth_revoked");
    throw new ProviderError("auth_revoked", "Access token expired and no refresh token is available.");
  }
  try {
    const refreshed = await getAdapter(provider).refreshAccessToken(tokens.refreshToken);
    // Providers may omit the refresh token on refresh; re-store the existing one so
    // both secrets are encrypted with the active key and key_id stays accurate.
    await storeTokens(orgId, connectionId, { ...refreshed, refreshToken: refreshed.refreshToken ?? tokens.refreshToken });
    return refreshed.accessToken;
  } catch (error: unknown) {
    if (error instanceof ProviderError && REAUTH_CODES.has(error.code)) {
      await markReauthRequired(orgId, connectionId, error.message, error.code);
    }
    throw error;
  }
}
