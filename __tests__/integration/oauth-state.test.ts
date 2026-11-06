import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/db";
import { makeTenant } from "../helpers/factories";
import { db } from "@/lib/db";
import { mailboxConnections, mailboxCredentials, oauthStates } from "@/lib/db/schema";
import { completeMailboxOAuth, startMailboxOAuth } from "@/lib/mailboxes/oauth";
import type { Principal } from "@/lib/api/principal";

const principalFor = (t: Awaited<ReturnType<typeof makeTenant>>): Principal => ({
  userId: t.user.id,
  email: t.user.email,
  name: t.user.name,
  orgId: t.org.id,
  orgName: t.org.name,
  orgSlug: t.org.slug,
  isDemoOrg: false,
  automationPaused: false,
  role: "owner",
  membershipId: t.membership.id,
  memberships: [],
});

describe("mailbox OAuth state handling", () => {
  let t: Awaited<ReturnType<typeof makeTenant>>;
  beforeAll(async () => {
    await createTestDb();
    t = await makeTenant();
  });

  it("refuses to start when the provider is not configured (no simulated connection)", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    await expect(startMailboxOAuth(principalFor(t), "google")).rejects.toMatchObject({ status: 503 });
  });

  it("binds state to the user, consumes it once, handles consent denial, and stores only encrypted tokens", async () => {
    process.env.GOOGLE_CLIENT_ID = "test-client";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";
    const started = await startMailboxOAuth(principalFor(t), "google");
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    expect(new URL(started.authorizationUrl).searchParams.get("code_challenge_method")).toBe("S256");

    // A different signed-in user cannot complete someone else's flow.
    const other = await makeTenant();
    const mismatch = await completeMailboxOAuth({ provider: "google", sessionUserId: other.user.id, code: "c", state, providerError: null });
    expect(mismatch).toMatchObject({ ok: false, code: "session_mismatch" });
    // The state was consumed by that attempt: replay fails.
    const replay = await completeMailboxOAuth({ provider: "google", sessionUserId: t.user.id, code: "c", state, providerError: null });
    expect(replay).toMatchObject({ ok: false, code: "invalid_state" });

    const s2 = new URL((await startMailboxOAuth(principalFor(t), "google")).authorizationUrl).searchParams.get("state")!;
    const denied = await completeMailboxOAuth({ provider: "google", sessionUserId: t.user.id, code: null, state: s2, providerError: "access_denied" });
    expect(denied).toMatchObject({ ok: false, code: "consent_denied" });

    // Happy path with a faked Google token + userinfo exchange.
    const s3 = new URL((await startMailboxOAuth(principalFor(t), "google")).authorizationUrl).searchParams.get("state")!;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "ya29.SECRET-ACCESS-TOKEN-1234567890", refresh_token: "1//SECRET-REFRESH", expires_in: 3600, scope: "openid email https://www.googleapis.com/auth/gmail.metadata", token_type: "Bearer" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("userinfo")) return new Response(JSON.stringify({ sub: "123", email: "sender@acme.example", email_verified: true }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 404 });
    });
    const ok = await completeMailboxOAuth({ provider: "google", sessionUserId: t.user.id, code: "good", state: s3, providerError: null });
    fetchMock.mockRestore();
    expect(ok.ok).toBe(true);
    const [conn] = await db.select().from(mailboxConnections).where(eq(mailboxConnections.orgId, t.org.id));
    expect(conn).toMatchObject({ emailAddress: "sender@acme.example", state: "pending" });
    const [cred] = await db.select().from(mailboxCredentials).where(eq(mailboxCredentials.connectionId, conn!.id));
    expect(cred!.encryptedAccessToken).toMatch(/^v1\./);
    expect(JSON.stringify(cred)).not.toContain("SECRET");
    const unconsumed = (await db.select().from(oauthStates)).filter((r) => !r.consumedAt);
    expect(unconsumed).toHaveLength(0);
  });
});
