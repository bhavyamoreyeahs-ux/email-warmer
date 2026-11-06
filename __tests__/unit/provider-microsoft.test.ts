/**
 * Unit tests for the Microsoft Graph adapter. All HTTP goes through an injected
 * fake fetch; nothing touches the network.
 */
import { describe, expect, it } from "vitest";
import { createMicrosoftAdapter } from "@/lib/mailboxes/providers/microsoft";
import { CAPABILITY_KEYS, ProviderError, type MailboxProviderAdapter } from "@/lib/mailboxes/providers/types";

const ACCESS_TOKEN = "eyJ0eXAiOiJKV1QiSECRET-ACCESS-TOKEN-do-not-leak";
const REFRESH_TOKEN = "0.AXEA-SECRET-REFRESH-TOKEN-do-not-leak";
const CLIENT_SECRET = "Q~client-secret-do-not-leak";
const MAILBOX = "sales@contoso.test";
const SINCE = new Date("2026-10-01T00:00:00.000Z");
const GRAPH = "https://graph.microsoft.com/v1.0";

interface Call {
  url: URL;
  raw: string;
  method: string;
  body: string;
  headers: Headers;
}

function createFakeFetch(handler: (url: URL, raw: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    calls.push({ url, raw, method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : "", headers: new Headers(init.headers) });
    return handler(url, raw);
  };
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function adapterWith(fetchImpl: typeof fetch, tenant?: string): MailboxProviderAdapter {
  return createMicrosoftAdapter({ clientId: "00000000-aaaa-bbbb-cccc-000000000000", clientSecret: CLIENT_SECRET, tenant, fetchImpl });
}

async function catchError(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error("expected a ProviderError");
}

function expectSafe(error: ProviderError): void {
  for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET, "Zephyr"]) expect(error.message).not.toContain(secret);
}

function graphMsg(
  id: string,
  o: { subject?: string; from: string; fromName?: string; to?: string[]; at: string; conv: string },
) {
  return {
    id,
    subject: o.subject ?? "",
    from: { emailAddress: { name: o.fromName ?? o.from, address: o.from } },
    toRecipients: (o.to ?? [MAILBOX]).map((a) => ({ emailAddress: { name: a, address: a } })),
    sentDateTime: o.at,
    receivedDateTime: o.at,
    conversationId: o.conv,
    internetMessageId: `<${id}@contoso.test>`,
  };
}

const isDelta = (url: URL, folder: string) => url.pathname === `/v1.0/me/mailFolders('${folder}')/messages/delta`;

/* ─── OAuth ───────────────────────────────────────────────────────────── */

describe("Microsoft OAuth", () => {
  it("builds an organizations-tenant PKCE authorization URL with least-privilege scopes", () => {
    const { fetchImpl } = createFakeFetch(() => json({}));
    const url = new URL(
      adapterWith(fetchImpl).buildAuthorizationUrl({
        state: "state-1",
        codeChallenge: "challenge-1",
        redirectUri: "http://localhost:3020/api/mailboxes/callback/microsoft",
        loginHint: MAILBOX,
      }),
    );
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize");
    const p = url.searchParams;
    expect(p.get("scope")).toBe("offline_access openid email User.Read Mail.ReadBasic");
    expect(p.get("scope")).not.toMatch(/Mail\.Read(\s|$)|Mail\.ReadWrite|Mail\.Send/);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("response_mode")).toBe("query");
    expect(p.get("prompt")).toBe("select_account");
    expect(p.get("code_challenge")).toBe("challenge-1");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("state")).toBe("state-1");
    expect(p.get("login_hint")).toBe(MAILBOX);
    expect(url.href).not.toContain(CLIENT_SECRET);
  });

  it("honours a configured tenant and rejects malformed ones", () => {
    const { fetchImpl } = createFakeFetch(() => json({}));
    const url = adapterWith(fetchImpl, "contoso.onmicrosoft.com").buildAuthorizationUrl({
      state: "s",
      codeChallenge: "c",
      redirectUri: "http://localhost/cb",
    });
    expect(url.startsWith("https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize?")).toBe(true);
    const bad = adapterWith(fetchImpl, "evil.test/x?y=");
    expect(bad.isConfigured()).toBe(false);
    expect(() => bad.buildAuthorizationUrl({ state: "s", codeChallenge: "c", redirectUri: "http://localhost/cb" })).toThrow(
      ProviderError,
    );
  });

  it("exchanges the code with client secret, verifier and scopes", async () => {
    const { fetchImpl, calls } = createFakeFetch(() =>
      json({
        token_type: "Bearer",
        scope: "email openid profile https://graph.microsoft.com/Mail.ReadBasic https://graph.microsoft.com/User.Read",
        expires_in: 4153,
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
      }),
    );
    const tokens = await adapterWith(fetchImpl).exchangeCode({ code: "code-1", codeVerifier: "verifier-1", redirectUri: "http://localhost/cb" });
    expect(calls[0]?.url.href).toBe("https://login.microsoftonline.com/organizations/oauth2/v2.0/token");
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.body))).toEqual({
      client_id: "00000000-aaaa-bbbb-cccc-000000000000",
      client_secret: CLIENT_SECRET,
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "http://localhost/cb",
      code_verifier: "verifier-1",
      scope: "offline_access openid email User.Read Mail.ReadBasic",
    });
    expect(tokens).toMatchObject({ accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN });
    expect(tokens.scopes).toContain("https://graph.microsoft.com/Mail.ReadBasic");
  });

  it("maps token endpoint errors (AADSTS codes) safely", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ error: "invalid_grant", error_description: "AADSTS70008: The refresh token has expired.", error_codes: [70008] }, "auth_revoked"],
      [
        { error: "invalid_grant", error_description: "AADSTS65001: The user or administrator has not consented.", error_codes: [65001], suberror: "consent_required" },
        "insufficient_scope",
      ],
      [{ error: "access_denied", error_description: "AADSTS90094: Admin consent is required.", error_codes: [90094] }, "admin_consent_required"],
      [{ error: "invalid_request", error_description: "AADSTS90094: Need admin approval" }, "admin_consent_required"],
      [{ error: "access_denied", error_description: "AADSTS65004: User declined to consent to access the app." }, "consent_denied"],
      [{ error: "interaction_required", error_description: "AADSTS50076: MFA required" }, "auth_revoked"],
      [{ error: "invalid_client", error_description: `AADSTS7000215: Invalid client secret provided ${CLIENT_SECRET}` }, "invalid_request"],
    ];
    for (const [body, code] of cases) {
      const { fetchImpl } = createFakeFetch(() => json(body, 400));
      const error = await catchError(adapterWith(fetchImpl).refreshAccessToken(REFRESH_TOKEN));
      expect(error.code, String(body.error_description)).toBe(code);
      expectSafe(error);
      if (body.error === "invalid_client") expect(error.message).toBe("OAuth client misconfigured");
    }
  });

  it("fetches the profile, falling back to userPrincipalName", async () => {
    const { fetchImpl, calls } = createFakeFetch(() =>
      json({ id: "user-guid", mail: null, userPrincipalName: "Sales@Contoso.test", displayName: "Sales Team" }),
    );
    const profile = await adapterWith(fetchImpl).fetchProfile(ACCESS_TOKEN);
    expect(profile).toEqual({ emailAddress: "sales@contoso.test", providerAccountId: "user-guid", displayName: "Sales Team" });
    expect(calls[0]?.url.pathname).toBe("/v1.0/me");
    expect(calls[0]?.url.searchParams.get("$select")).toBe("id,mail,userPrincipalName,displayName");
  });

  it("revoke reports revoked:false without any network call", async () => {
    const { fetchImpl, calls } = createFakeFetch(() => json({}));
    const result = await adapterWith(fetchImpl).revoke({ accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN });
    expect(result.revoked).toBe(false);
    expect(result.detail).toContain("https://myapps.microsoft.com");
    expect(calls).toHaveLength(0);
  });
});

/* ─── Capabilities ────────────────────────────────────────────────────── */

describe("Microsoft validateCapabilities", () => {
  const granted = ["email", "openid", "profile", "https://graph.microsoft.com/Mail.ReadBasic", "https://graph.microsoft.com/User.Read"];

  function capServer(headerProbe: () => Response) {
    return createFakeFetch((url) => {
      if (url.pathname === "/v1.0/me/mailFolders('sentitems')") return json({ id: "sent-id" });
      if (url.pathname === "/v1.0/me/messages" && url.searchParams.get("$select") === "internetMessageHeaders") return headerProbe();
      return json({ error: { code: "UnexpectedPath" } }, 500);
    });
  }

  const statusOf = (results: Array<{ capability: string; status: string }>) =>
    Object.fromEntries(results.map((r) => [r.capability, r.status]));

  function expectEveryKeyOnce(results: Array<{ capability: string }>) {
    expect(results.map((r) => r.capability).sort()).toEqual([...CAPABILITY_KEYS].sort());
    expect(results).toHaveLength(CAPABILITY_KEYS.length);
  }

  it("with header access: full honest matrix (normalises Graph scope URLs)", async () => {
    const { fetchImpl, calls } = capServer(() =>
      json({ value: [{ internetMessageHeaders: [{ name: "Received", value: "from x" }] }] }),
    );
    const results = await adapterWith(fetchImpl).validateCapabilities(ACCESS_TOKEN, granted);
    expectEveryKeyOnce(results);
    expect(calls.map((c) => c.url.pathname)).toEqual(["/v1.0/me/mailFolders('sentitems')", "/v1.0/me/messages"]);
    expect(statusOf(results)).toEqual({
      sent_volume: "available",
      bounce_detection: "available",
      bounce_classification: "partial",
      reply_detection: "partial",
      auto_reply_detection: "available",
      complaint_feedback: "partial",
      unsubscribe_requests: "partial",
      sending_limit_notices: "unavailable",
      provider_api_errors: "available",
      inbox_placement: "unavailable",
      open_tracking: "unavailable",
      realtime_push: "unavailable",
    });
    expect(results.find((r) => r.capability === "complaint_feedback")?.detail).toMatch(/JMRP/);
  });

  it("header probe 403 → header-based detection is partial, complaints unavailable", async () => {
    const { fetchImpl } = capServer(() => json({ error: { code: "ErrorAccessDenied", message: "Access is denied." } }, 403));
    const results = await adapterWith(fetchImpl).validateCapabilities(ACCESS_TOKEN, granted);
    expectEveryKeyOnce(results);
    const s = statusOf(results);
    expect(s.bounce_detection).toBe("partial");
    expect(s.auto_reply_detection).toBe("partial");
    expect(s.reply_detection).toBe("partial");
    expect(s.complaint_feedback).toBe("unavailable");
    expect(results.find((r) => r.capability === "reply_detection")?.detail).toMatch(/conversation/i);
  });

  it("messages without the header property → partial", async () => {
    const { fetchImpl } = capServer(() => json({ value: [{}] }));
    const s = statusOf(await adapterWith(fetchImpl).validateCapabilities(ACCESS_TOKEN, granted));
    expect(s.bounce_detection).toBe("partial");
    expect(s.complaint_feedback).toBe("unknown");
  });

  it("missing Mail.ReadBasic → unavailable, with no network calls", async () => {
    const { fetchImpl, calls } = createFakeFetch(() => json({}));
    const results = await adapterWith(fetchImpl).validateCapabilities(ACCESS_TOKEN, ["openid", "email", "User.Read"]);
    expectEveryKeyOnce(results);
    expect(calls).toHaveLength(0);
    const s = statusOf(results);
    for (const key of ["sent_volume", "bounce_detection", "reply_detection", "auto_reply_detection", "unsubscribe_requests"]) {
      expect(s[key], key).toBe("unavailable");
    }
    expect(s.inbox_placement).toBe("unavailable");
    expect(s.open_tracking).toBe("unavailable");
  });

  it("revoked token propagates as auth_revoked; no mailbox → unavailable", async () => {
    const revoked = createFakeFetch(() => json({ error: { code: "InvalidAuthenticationToken", message: "expired" } }, 401));
    const error = await catchError(adapterWith(revoked.fetchImpl).validateCapabilities(ACCESS_TOKEN, granted));
    expect(error.code).toBe("auth_revoked");
    expectSafe(error);

    const noMailbox = createFakeFetch(() =>
      json({ error: { code: "MailboxNotEnabledForRESTAPI", message: "REST API is not yet supported for this mailbox." } }, 404),
    );
    const s = statusOf(await adapterWith(noMailbox.fetchImpl).validateCapabilities(ACCESS_TOKEN, granted));
    expect(s.sent_volume).toBe("unavailable");
  });
});

/* ─── Sync ────────────────────────────────────────────────────────────── */

describe("Microsoft syncSince", () => {
  const SENT_DELTA = `${GRAPH}/me/mailFolders('sentitems')/messages/delta?$deltatoken=sent-token-1`;
  const INBOX_DELTA = `${GRAPH}/me/mailFolders('inbox')/messages/delta?$deltatoken=inbox-token-1`;

  function firstSyncServer(headerResponse: (id: string) => Response) {
    return createFakeFetch((url, raw) => {
      if (isDelta(url, "sentitems") && url.searchParams.has("$filter")) {
        return json({
          value: [
            graphMsg("s1", { from: MAILBOX, to: ["a@x.test", "b@y.test"], subject: "Intro Zephyr", at: "2026-10-20T10:00:00Z", conv: "conv-1" }),
            { id: "gone", "@removed": { reason: "deleted" } },
          ],
          "@odata.nextLink": `${GRAPH}/me/mailFolders('sentitems')/messages/delta?$skiptoken=sent-page-2`,
        });
      }
      if (isDelta(url, "sentitems") && url.searchParams.get("$skiptoken") === "sent-page-2") {
        return json({
          value: [graphMsg("s2", { from: MAILBOX, to: ["c@z.test"], subject: "Hello", at: "2026-10-21T10:00:00Z", conv: "conv-2" })],
          "@odata.deltaLink": SENT_DELTA,
        });
      }
      if (isDelta(url, "inbox") && url.searchParams.has("$filter")) {
        return json({
          value: [
            graphMsg("i1", {
              from: "postmaster@contoso.onmicrosoft.com",
              fromName: "Microsoft Outlook",
              subject: "Undeliverable: Intro Zephyr",
              at: "2026-10-20T10:05:00Z",
              conv: "conv-1",
            }),
            graphMsg("i2", { from: "c@z.test", fromName: "Cara", subject: "RE: Hello", at: "2026-10-22T09:00:00Z", conv: "conv-2" }),
            graphMsg("i3", { from: "dan@d.test", subject: "Automatic reply: Intro", at: "2026-10-20T11:00:00Z", conv: "conv-1" }),
            graphMsg("i4", { from: "erin@e.test", subject: "Re: Old thread", at: "2026-10-23T09:00:00Z", conv: "conv-old" }),
            graphMsg("i5", { from: "news@vendor.test", subject: "Weekly digest", at: "2026-10-23T09:00:00Z", conv: "conv-news" }),
            graphMsg("i6", { from: "frank@f.test", subject: "Re: Not ours", at: "2026-10-23T09:00:00Z", conv: "conv-foreign" }),
          ],
          "@odata.deltaLink": INBOX_DELTA,
        });
      }
      if (url.pathname === "/v1.0/me/mailFolders('sentitems')/messages") {
        const filter = url.searchParams.get("$filter") ?? "";
        return json({ value: filter.includes("'conv-old'") ? [{ id: "older-sent" }] : [] });
      }
      const headerMatch = /^\/v1\.0\/me\/messages\/([^/]+)$/.exec(url.pathname);
      if (headerMatch?.[1]) return headerResponse(decodeURIComponent(headerMatch[1]));
      if (raw === SENT_DELTA) return json({ value: [], "@odata.deltaLink": SENT_DELTA });
      if (raw === INBOX_DELTA) {
        return json({
          value: [graphMsg("i7", { from: "gina@g.test", subject: "Unsubscribe", at: "2026-10-30T09:00:00Z", conv: "conv-7" })],
          "@odata.deltaLink": `${GRAPH}/me/mailFolders('inbox')/messages/delta?$deltatoken=inbox-token-2`,
        });
      }
      return json({ error: { code: "UnexpectedPath", message: raw } }, 500);
    });
  }

  it("first sync uses filtered delta queries, classifies, and persists deltaLinks", async () => {
    const server = firstSyncServer(() => json({ error: { code: "ErrorAccessDenied", message: "Access is denied." } }, 403));
    const page = await adapterWith(server.fetchImpl).syncSince({
      accessToken: ACCESS_TOKEN,
      cursor: null,
      since: SINCE,
      mailboxAddress: MAILBOX,
      maxMessages: 100,
    });

    const firstSent = server.calls.find((c) => isDelta(c.url, "sentitems"));
    expect(firstSent?.url.searchParams.get("$filter")).toBe("receivedDateTime ge 2026-10-01T00:00:00Z");
    expect(firstSent?.url.searchParams.get("$select")).toBe(
      "id,subject,from,toRecipients,sentDateTime,receivedDateTime,conversationId,internetMessageId",
    );
    expect(firstSent?.headers.get("prefer")).toBe("odata.maxpagesize=50");
    expect(firstSent?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    for (const c of server.calls) expect(c.url.searchParams.get("$select") ?? "").not.toMatch(/body|bodyPreview|attachments/i);

    const byRef = Object.fromEntries(page.signals.map((s) => [s.providerMessageRef, s]));
    expect(byRef.s1).toMatchObject({ category: "sent", metadata: { recipientCount: 2 } });
    expect(byRef.s2?.category).toBe("sent");
    expect(byRef.gone).toBeUndefined();
    expect(byRef.i1).toMatchObject({ category: "hard_bounce", confidence: "medium" });
    expect(byRef.i2).toMatchObject({ category: "reply", counterpartyAddress: "c@z.test" }); // conversation seen in this run
    expect(byRef.i3?.category).toBe("auto_reply");
    expect(byRef.i4).toMatchObject({ category: "reply" }); // bounded conversation lookup found our sent message
    expect(byRef.i5).toBeUndefined();
    expect(byRef.i6).toBeUndefined(); // lookup found nothing of ours
    expect(JSON.stringify(page.signals)).not.toContain("Zephyr");

    const lookups = server.calls.filter((c) => c.url.pathname === "/v1.0/me/mailFolders('sentitems')/messages");
    expect(lookups.map((c) => c.url.searchParams.get("$filter")).sort()).toEqual([
      "conversationId eq 'conv-foreign'",
      "conversationId eq 'conv-old'",
    ]);
    expect(lookups[0]?.url.searchParams.get("$top")).toBe("1");

    expect(page.messagesExamined).toBe(8);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toEqual({ sentDelta: SENT_DELTA, inboxDelta: INBOX_DELTA, headerAccess: "denied" });
  });

  it("round-trips the deltaLink cursor and stops probing headers once denied", async () => {
    const server = firstSyncServer(() => json({ error: { code: "ErrorAccessDenied" } }, 403));
    const page = await adapterWith(server.fetchImpl).syncSince({
      accessToken: ACCESS_TOKEN,
      cursor: { sentDelta: SENT_DELTA, inboxDelta: INBOX_DELTA, headerAccess: "denied" },
      since: SINCE,
      mailboxAddress: MAILBOX,
      maxMessages: 100,
    });
    expect(server.calls.map((c) => c.raw).slice(0, 2)).toEqual([SENT_DELTA, INBOX_DELTA]);
    expect(server.calls.some((c) => c.url.searchParams.has("$filter") && isDelta(c.url, "inbox"))).toBe(false);
    expect(server.calls.some((c) => /^\/v1\.0\/me\/messages\//.test(c.url.pathname))).toBe(false);
    expect(page.signals.map((s) => [s.providerMessageRef, s.category])).toEqual([["i7", "unsubscribe"]]);
    expect(page.nextCursor).toEqual({
      sentDelta: SENT_DELTA,
      inboxDelta: `${GRAPH}/me/mailFolders('inbox')/messages/delta?$deltatoken=inbox-token-2`,
      headerAccess: "denied",
    });
  });

  it("uses internetMessageHeaders when Graph returns them", async () => {
    const headers: Record<string, Array<{ name: string; value: string }>> = {
      i5: [
        { name: "Content-Type", value: 'multipart/report; report-type="feedback-report"; boundary="b"' },
        { name: "Received", value: "from mx" },
      ],
      i6: [{ name: "Auto-Submitted", value: "auto-replied" }],
    };
    const server = firstSyncServer((id) => json({ internetMessageHeaders: headers[id] ?? [] }));
    const page = await adapterWith(server.fetchImpl).syncSince({
      accessToken: ACCESS_TOKEN,
      cursor: null,
      since: SINCE,
      mailboxAddress: MAILBOX,
      maxMessages: 100,
    });
    const byRef = Object.fromEntries(page.signals.map((s) => [s.providerMessageRef, s]));
    expect(byRef.i5).toMatchObject({ category: "complaint", confidence: "high" });
    expect(byRef.i6).toMatchObject({ category: "auto_reply", confidence: "high" });
    expect(page.nextCursor.headerAccess).toBeUndefined();
    const headerCall = server.calls.find((c) => c.url.pathname === "/v1.0/me/messages/i5");
    expect(headerCall?.url.searchParams.get("$select")).toBe("internetMessageHeaders");
  });

  it("maxMessages bounds the run, persists nextLinks and sets hasMore", async () => {
    const server = createFakeFetch((url) => {
      const size = Number((/maxpagesize=(\d+)/.exec(server.calls.at(-1)?.headers.get("prefer") ?? "") ?? [])[1] ?? 50);
      const folder = isDelta(url, "sentitems") ? "sentitems" : "inbox";
      const value = Array.from({ length: size }, (_, i) =>
        graphMsg(`${folder}-${url.searchParams.get("$skiptoken") ?? "p0"}-${i}`, {
          from: folder === "sentitems" ? MAILBOX : "x@y.test",
          at: "2026-10-20T10:00:00Z",
          conv: `c-${i}`,
        }),
      );
      return json({ value, "@odata.nextLink": `${GRAPH}/me/mailFolders('${folder}')/messages/delta?$skiptoken=next-${folder}` });
    });
    const page = await adapterWith(server.fetchImpl).syncSince({
      accessToken: ACCESS_TOKEN,
      cursor: null,
      since: SINCE,
      mailboxAddress: MAILBOX,
      maxMessages: 3,
    });
    expect(page.messagesExamined).toBe(3);
    expect(page.hasMore).toBe(true);
    expect(server.calls.filter((c) => isDelta(c.url, "sentitems") || isDelta(c.url, "inbox")).map((c) => c.headers.get("prefer"))).toEqual([
      "odata.maxpagesize=2",
      "odata.maxpagesize=1",
    ]);
    expect(page.nextCursor.sentDelta).toBe(`${GRAPH}/me/mailFolders('sentitems')/messages/delta?$skiptoken=next-sentitems`);
    expect(page.nextCursor.inboxDelta).toBe(`${GRAPH}/me/mailFolders('inbox')/messages/delta?$skiptoken=next-inbox`);
  });

  it("410 Gone and syncStateNotFound → history_expired", async () => {
    for (const response of [
      () => json({ error: { code: "SyncStateNotFound", message: "The sync state generation is not found." } }, 410),
      () => json({ error: { code: "syncStateNotFound", message: "bad token" } }, 400),
    ]) {
      const { fetchImpl } = createFakeFetch(response);
      const error = await catchError(
        adapterWith(fetchImpl).syncSince({
          accessToken: ACCESS_TOKEN,
          cursor: { sentDelta: SENT_DELTA, inboxDelta: INBOX_DELTA },
          since: SINCE,
          mailboxAddress: MAILBOX,
          maxMessages: 10,
        }),
      );
      expect(error.code).toBe("history_expired");
      expectSafe(error);
    }
  });

  it("refuses cursor links that do not point at Graph (token exfiltration guard)", async () => {
    const { fetchImpl, calls } = createFakeFetch(() => json({ value: [], "@odata.deltaLink": SENT_DELTA }));
    const error = await catchError(
      adapterWith(fetchImpl).syncSince({
        accessToken: ACCESS_TOKEN,
        cursor: { sentDelta: "https://attacker.test/steal", inboxDelta: INBOX_DELTA },
        since: SINCE,
        mailboxAddress: MAILBOX,
        maxMessages: 10,
      }),
    );
    expect(error.code).toBe("history_expired");
    expect(calls).toHaveLength(0);
  });

  it("throttling surfaces as rate_limited with Retry-After", async () => {
    const { fetchImpl } = createFakeFetch(() =>
      json({ error: { code: "ApplicationThrottled", message: "throttled" } }, 429, { "Retry-After": "7" }),
    );
    const error = await catchError(
      adapterWith(fetchImpl).syncSince({ accessToken: ACCESS_TOKEN, cursor: null, since: SINCE, mailboxAddress: MAILBOX, maxMessages: 10 }),
    );
    expect(error).toMatchObject({ code: "rate_limited", retryAfterMs: 7000, retryable: true });
    expectSafe(error);
  });
});
