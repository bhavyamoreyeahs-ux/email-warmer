/**
 * Mailbox OAuth (authorization code + PKCE). QuikReach never asks for mailbox
 * passwords.
 *
 * Flow
 *  1. start: create a single-use state (only its SHA-256 is stored) bound to the
 *     user + org + provider, with the PKCE verifier encrypted at rest; 10 min TTL.
 *  2. provider consent screen.
 *  3. callback: the state must exist, be unexpired, unconsumed, for this
 *     provider AND for the currently signed-in user (prevents session swapping /
 *     login CSRF). It is consumed atomically. Membership + permission are
 *     re-checked at callback time, tokens are encrypted, the connection is
 *     upserted in `pending` state, and capability validation is queued.
 */
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, mailboxConnections, memberships, oauthStates, organizations } from "@/lib/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto/encryption";
import { sha256Hex } from "@/lib/crypto/hash";
import { getAdapter } from "@/lib/mailboxes/providers/registry";
import { createOAuthState, createPkcePair } from "@/lib/mailboxes/providers/pkce";
import { ProviderError, type OAuthProvider } from "@/lib/mailboxes/providers/types";
import { storeTokens } from "@/lib/mailboxes/tokens";
import { ApiError, badRequest, forbidden, notFound, unavailable } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import { enqueueJob } from "@/lib/jobs/queue";
import { assertCanAddMailbox } from "@/lib/usage/entitlements";
import { recordUsage } from "@/lib/usage/ledger";
import { can } from "@/lib/rbac";
import { env } from "@/lib/env";
import type { Principal } from "@/lib/api/principal";

const STATE_TTL_MS = 10 * 60 * 1000;

export function redirectUriFor(provider: OAuthProvider): string {
  return `${env().APP_URL}/api/v1/mailboxes/oauth/callback/${provider}`;
}

export async function startMailboxOAuth(principal: Principal, provider: OAuthProvider, reconnectConnectionId?: string, requestId?: string) {
  const adapter = getAdapter(provider);
  if (!adapter.isConfigured()) {
    throw unavailable(
      `${adapter.displayName} OAuth is not configured in this deployment. An administrator must set the client id and secret (see docs/oauth-setup.md). No mailbox can be connected until then.`,
    );
  }
  let loginHint: string | undefined;
  if (reconnectConnectionId) {
    const [conn] = await db
      .select()
      .from(mailboxConnections)
      .where(and(eq(mailboxConnections.id, reconnectConnectionId), eq(mailboxConnections.orgId, principal.orgId)))
      .limit(1);
    if (!conn || conn.provider !== provider) throw notFound("Mailbox connection");
    loginHint = conn.emailAddress;
  } else {
    await assertCanAddMailbox(principal.orgId);
  }

  const { verifier, challenge } = createPkcePair();
  const state = createOAuthState();
  await db.insert(oauthStates).values({
    stateHash: sha256Hex(state),
    orgId: principal.orgId,
    userId: principal.userId,
    provider,
    encryptedCodeVerifier: encryptSecret(verifier),
    reconnectConnectionId: reconnectConnectionId ?? null,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });
  await recordAudit({
    orgId: principal.orgId,
    actor: { type: "user", userId: principal.userId, label: principal.email },
    action: reconnectConnectionId ? "mailbox.reconnect.start" : "mailbox.connect.start",
    targetType: "mailbox",
    targetId: reconnectConnectionId ?? null,
    outcome: "pending",
    requestId,
    metadata: { provider },
  });
  return {
    authorizationUrl: adapter.buildAuthorizationUrl({ state, codeChallenge: challenge, redirectUri: redirectUriFor(provider), loginHint }),
    scopes: adapter.scopes,
    scopeExplanations: adapter.scopeExplanations,
  };
}

export type CallbackOutcome =
  | { ok: true; connectionId: string; reconnected: boolean }
  | { ok: false; code: string; message: string };

export async function completeMailboxOAuth(input: {
  provider: OAuthProvider;
  sessionUserId: string | null;
  code: string | null;
  state: string | null;
  providerError: string | null;
}): Promise<CallbackOutcome> {
  if (!input.state) return { ok: false, code: "invalid_state", message: "The sign-in response was missing its state. Start the connection again." };
  // Consume the state atomically: exactly one callback can use it.
  const [st] = await db
    .update(oauthStates)
    .set({ consumedAt: new Date() })
    .where(and(eq(oauthStates.stateHash, sha256Hex(input.state)), isNull(oauthStates.consumedAt), gt(oauthStates.expiresAt, new Date())))
    .returning();
  if (!st || st.provider !== input.provider) {
    return { ok: false, code: "invalid_state", message: "This connection attempt expired or was already used. Start again from Mailboxes." };
  }
  if (!input.sessionUserId || input.sessionUserId !== st.userId) {
    return { ok: false, code: "session_mismatch", message: "Finish the connection in the same signed-in session that started it." };
  }
  const actor = { type: "user" as const, userId: st.userId, label: "" };
  const audit = (outcome: "success" | "failure" | "denied", reason: string, targetId: string | null = null, metadata: Record<string, unknown> = {}) =>
    recordAudit({ orgId: st.orgId, actor: { ...actor, label: actor.label || st.userId }, action: st.reconnectConnectionId ? "mailbox.reconnect" : "mailbox.connect", targetType: "mailbox", targetId, reason, outcome, metadata: { provider: input.provider, ...metadata } });

  if (input.providerError) {
    const denied = input.providerError === "access_denied";
    await audit("failure", denied ? "consent denied by user" : `provider error: ${input.providerError.slice(0, 60)}`);
    return denied
      ? { ok: false, code: "consent_denied", message: "Permission was not granted, so no mailbox was connected. You can try again at any time." }
      : { ok: false, code: "provider_error", message: "The provider returned an error during sign-in. No mailbox was connected." };
  }
  if (!input.code) return { ok: false, code: "missing_code", message: "The provider did not return an authorization code." };

  // Re-check authorization at callback time — roles can change in 10 minutes.
  const [member] = await db
    .select({ role: memberships.role, email: sql<string>`(select email from users where id = ${st.userId})`, isDemo: organizations.isDemo, orgStatus: organizations.status })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.orgId, st.orgId), eq(memberships.userId, st.userId), eq(memberships.status, "active")))
    .limit(1);
  if (!member || member.orgStatus !== "active" || !can(member.role, "mailbox:connect")) {
    await audit("denied", "no longer permitted to connect mailboxes");
    return { ok: false, code: "forbidden", message: "Your role no longer permits connecting mailboxes in this organization." };
  }
  actor.label = member.email;
  if (member.isDemo) {
    await audit("denied", "demo workspace");
    return { ok: false, code: "demo_workspace", message: "Live mailboxes cannot be connected to a demo workspace." };
  }

  const adapter = getAdapter(input.provider);
  try {
    const tokens = await adapter.exchangeCode({ code: input.code, codeVerifier: decryptSecret(st.encryptedCodeVerifier), redirectUri: redirectUriFor(input.provider) });
    const profile = await adapter.fetchProfile(tokens.accessToken);
    const email = profile.emailAddress.trim().toLowerCase();
    const emailDomain = email.split("@")[1] ?? "";

    const connectionId = await db.transaction(async (tx) => {
      let id: string;
      if (st.reconnectConnectionId) {
        const [existing] = await tx
          .select()
          .from(mailboxConnections)
          .where(and(eq(mailboxConnections.id, st.reconnectConnectionId), eq(mailboxConnections.orgId, st.orgId)))
          .limit(1);
        if (!existing) throw notFound("Mailbox connection");
        if (existing.emailAddress !== email) {
          throw badRequest(`You signed in as ${email}, but this connection is for ${existing.emailAddress}. Sign in with the matching account.`);
        }
        id = existing.id;
        if (!existing.domainId) {
          const [domain] = await tx.select({ id: domains.id }).from(domains).where(and(eq(domains.orgId, st.orgId), eq(domains.name, emailDomain))).limit(1);
          if (domain) await tx.update(mailboxConnections).set({ domainId: domain.id }).where(eq(mailboxConnections.id, id));
        }
      } else {
        await assertCanAddMailbox(st.orgId, tx);
        const [domain] = await tx.select({ id: domains.id }).from(domains).where(and(eq(domains.orgId, st.orgId), eq(domains.name, emailDomain))).limit(1);
        const [row] = await tx
          .insert(mailboxConnections)
          .values({ orgId: st.orgId, provider: input.provider, emailAddress: email, domainId: domain?.id ?? null, connectedByUserId: st.userId })
          .onConflictDoUpdate({
            target: [mailboxConnections.orgId, mailboxConnections.provider, mailboxConnections.emailAddress],
            set: { updatedAt: new Date(), domainId: sql`coalesce(${mailboxConnections.domainId}, excluded.domain_id)` },
          })
          .returning({ id: mailboxConnections.id });
        id = row!.id;
      }
      await tx
        .update(mailboxConnections)
        .set({
          state: "pending",
          stateReason: "Validating permissions and available signals…",
          providerAccountId: profile.providerAccountId,
          displayName: profile.displayName,
          grantedScopes: tokens.scopes,
          lastErrorCode: null,
          lastErrorMessage: null,
          consecutiveFailures: 0,
          disconnectedAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(mailboxConnections.id, id), eq(mailboxConnections.orgId, st.orgId)));
      await storeTokens(st.orgId, id, tokens, tx);
      await enqueueJob({ type: "mailbox.validate", orgId: st.orgId, payload: { connectionId: id }, idempotencyKey: `validate:${id}` }, tx);
      await recordUsage({ orgId: st.orgId, metric: "mailbox_connected", quantity: 1, idempotencyKey: `mailbox-connected:${id}`, source: "oauth.callback" }, tx);
      await recordAudit(
        { orgId: st.orgId, actor, action: st.reconnectConnectionId ? "mailbox.reconnect" : "mailbox.connect", targetType: "mailbox", targetId: id, outcome: "success", metadata: { provider: input.provider, email, grantedScopes: tokens.scopes } },
        tx,
      );
      return id;
    });
    return { ok: true, connectionId, reconnected: Boolean(st.reconnectConnectionId) };
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      await audit("failure", error.message);
      return { ok: false, code: error.code.toLowerCase(), message: error.message };
    }
    if (error instanceof ProviderError) {
      await audit("failure", `${error.code}: ${error.message}`);
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}

export function assertProvider(value: string): OAuthProvider {
  if (value === "google" || value === "microsoft") return value;
  throw forbidden("Unsupported provider.");
}
