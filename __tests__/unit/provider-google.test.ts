/**
 * Unit tests for the Gmail adapter, the shared HTTP error mapping, PKCE and the
 * provider registry. All HTTP goes through an injected fake fetch; nothing
 * touches the network.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createGoogleAdapter, GMAIL_METADATA_SCOPE } from "@/lib/mailboxes/providers/google";
import { parseRetryAfter, requestJson } from "@/lib/mailboxes/providers/http";
import { createOAuthState, createPkcePair } from "@/lib/mailboxes/providers/pkce";
import { getAdapter, listProviderStatus } from "@/lib/mailboxes/providers/registry";
import { CAPABILITY_KEYS, ProviderError, type MailboxProviderAdapter } from "@/lib/mailboxes/providers/types";

const ACCESS_TOKEN = "ya29.SECRET-ACCESS-TOKEN-do-not-leak";
const REFRESH_TOKEN = "1//SECRET-REFRESH-TOKEN-do-not-leak";
const CLIENT_SECRET = "GOCSPX-client-secret-do-not-leak";
const MAILBOX = "sales@acme.test";
const SINCE = new Date("2026-10-01T00:00:00Z");

interface Call {
  url: URL;
  method: string;
  body: string;
  headers: Headers;
}

function createFakeFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : "",
      headers: new Headers(init.headers),
    });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function adapterWith(fetchImpl: typeof fetch, timeoutMs?: number): MailboxProviderAdapter {
  return createGoogleAdapter({ clientId: "client-123.apps.googleusercontent.com", clientSecret: CLIENT_SECRET, fetchImpl, timeoutMs });
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
  for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET, "Zephyr"]) {
    expect(error.message).not.toContain(secret);
  }
}

/* ─── Gmail fixtures ──────────────────────────────────────────────────── */

interface Msg {
  id: string;
  threadId: string;
  labels: string[];
  date: Date;
  headers: Record<string, string>;
}

function gmailMessage(m: Msg) {
  return {
    id: m.id,
    threadId: m.threadId,
    labelIds: m.labels,
    historyId: "900",
    internalDate: String(m.date.getTime()),
    payload: { mimeType: "text/plain", headers: Object.entries(m.headers).map(([name, value]) => ({ name, value })) },
  };
}

function gmailServer(opts: {
  messages: Msg[];
  lists: Record<string, Array<{ ids: string[]; next?: string }>>;
  threads?: Record<string, string[][]>;
  history?: (params: URLSearchParams) => Response;
  profileHistoryId?: string;
}) {
  const byId = new Map(opts.messages.map((m) => [m.id, m]));
  return createFakeFetch((url) => {
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    if (path === "/profile") return json({ emailAddress: MAILBOX, historyId: opts.profileHistoryId ?? "1000" });
    if (path === "/messages") {
      const label = url.searchParams.get("labelIds") ?? "";
      const pages = opts.lists[label] ?? [{ ids: [] }];
      const token = url.searchParams.get("pageToken");
      const index = token ? Number(token.replace("page-", "")) : 0;
      const page = pages[index] ?? { ids: [] };
      return json({
        messages: page.ids.map((id) => ({ id, threadId: byId.get(id)?.threadId })),
        ...(page.next ? { nextPageToken: page.next } : {}),
      });
    }
    const msgMatch = /^\/messages\/([^/]+)$/.exec(path);
    if (msgMatch?.[1]) {
      const m = byId.get(decodeURIComponent(msgMatch[1]));
      return m ? json(gmailMessage(m)) : json({ error: { code: 404, message: "Not Found" } }, 404);
    }
    const threadMatch = /^\/threads\/([^/]+)$/.exec(path);
    if (threadMatch?.[1]) {
      const labels = opts.threads?.[decodeURIComponent(threadMatch[1])] ?? [];
      return json({ messages: labels.map((labelIds) => ({ labelIds })) });
    }
    if (path === "/history" && opts.history) return opts.history(url.searchParams);
    return json({ error: { code: 500, message: `unexpected ${path}` } }, 500);
  });
}

const day = (d: number) => new Date(Date.UTC(2026, 9, d, 12));

/* ─── OAuth ───────────────────────────────────────────────────────────── */

describe("PKCE and state", () => {
  it("creates an S256 pair from a 64-byte verifier", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(createPkcePair().verifier).not.toBe(verifier);
  });

  it("creates a 32-byte base64url state", () => {
    expect(createOAuthState()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("Google OAuth", () => {
  it("reports configuration", () => {
    expect(createGoogleAdapter({ clientId: undefined, clientSecret: undefined }).isConfigured()).toBe(false);
    expect(createGoogleAdapter({ clientId: "a", clientSecret: "b" }).isConfigured()).toBe(true);
  });

  it("builds a least-privilege, PKCE, offline authorization URL", () => {
    const { fetchImpl } = createFakeFetch(() => json({}));
    const url = new URL(
      adapterWith(fetchImpl).buildAuthorizationUrl({
        state: "state-xyz",
        codeChallenge: "challenge-abc",
        redirectUri: "http://localhost:3020/api/mailboxes/callback/google",
        loginHint: "sales@acme.test",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = url.searchParams;
    expect(p.get("scope")).toBe(`openid email ${GMAIL_METADATA_SCOPE}`);
    expect(p.get("scope")).not.toMatch(/readonly|modify|mail\.google\.com/);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("include_granted_scopes")).toBe("false");
    expect(p.get("code_challenge")).toBe("challenge-abc");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("state")).toBe("state-xyz");
    expect(p.get("login_hint")).toBe("sales@acme.test");
    expect(p.get("client_id")).toBe("client-123.apps.googleusercontent.com");
    expect(url.href).not.toContain(CLIENT_SECRET);
  });

  it("refuses to build a URL when not configured", () => {
    expect(() =>
      createGoogleAdapter({ clientId: undefined, clientSecret: undefined }).buildAuthorizationUrl({
        state: "s",
        codeChallenge: "c",
        redirectUri: "http://localhost/cb",
      }),
    ).toThrow(ProviderError);
  });

  it("exchanges the code with the PKCE verifier and parses granted scopes", async () => {
    const { fetchImpl, calls } = createFakeFetch(() =>
      json({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expires_in: 3599,
        scope: `openid https://www.googleapis.com/auth/userinfo.email ${GMAIL_METADATA_SCOPE}`,
        token_type: "Bearer",
      }),
    );
    const before = Date.now();
    const tokens = await adapterWith(fetchImpl).exchangeCode({
      code: "auth-code",
      codeVerifier: "verifier-123",
      redirectUri: "http://localhost:3020/cb",
    });
    const call = calls[0];
    expect(call?.url.href).toBe("https://oauth2.googleapis.com/token");
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(call?.body);
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "authorization_code",
      code: "auth-code",
      code_verifier: "verifier-123",
      redirect_uri: "http://localhost:3020/cb",
      client_id: "client-123.apps.googleusercontent.com",
      client_secret: CLIENT_SECRET,
    });
    expect(tokens.accessToken).toBe(ACCESS_TOKEN);
    expect(tokens.refreshToken).toBe(REFRESH_TOKEN);
    expect(tokens.scopes).toContain(GMAIL_METADATA_SCOPE);
    expect(tokens.expiresAt?.getTime()).toBeGreaterThanOrEqual(before + 3599_000);
  });

  it("maps a refresh invalid_grant to auth_revoked without leaking the token", async () => {
    const { fetchImpl, calls } = createFakeFetch(() =>
      json({ error: "invalid_grant", error_description: `Token has been expired or revoked. ${REFRESH_TOKEN}` }, 400),
    );
    const error = await catchError(adapterWith(fetchImpl).refreshAccessToken(REFRESH_TOKEN));
    expect(error.code).toBe("auth_revoked");
    expect(error.message).toBe("Google rejected the refresh token; the user must reconnect.");
    expect(error.retryable).toBe(false);
    expectSafe(error);
    expect(new URLSearchParams(calls[0]?.body).get("grant_type")).toBe("refresh_token");
  });

  it("maps other OAuth errors", async () => {
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ error: "invalid_client", error_description: "The OAuth client was not found." }, 401, "invalid_request"],
      [{ error: "access_denied" }, 400, "consent_denied"],
      [{ error: "admin_policy_enforced" }, 400, "admin_consent_required"],
      [{ error: "server_error" }, 500, "provider_unavailable"],
    ];
    for (const [body, status, code] of cases) {
      const { fetchImpl } = createFakeFetch(() => json(body, status));
      const error = await catchError(adapterWith(fetchImpl).refreshAccessToken(REFRESH_TOKEN));
      expect(error.code, String(body.error)).toBe(code);
      expectSafe(error);
    }
    const { fetchImpl } = createFakeFetch(() => json({ error: "invalid_client" }, 401));
    const error = await catchError(adapterWith(fetchImpl).refreshAccessToken(REFRESH_TOKEN));
    expect(error.message).toBe("OAuth client misconfigured");
  });

  it("fetches a verified profile and rejects unverified email", async () => {
    const ok = createFakeFetch(() => json({ sub: "1234567890", email: "Sales@Acme.test", email_verified: true }));
    const profile = await adapterWith(ok.fetchImpl).fetchProfile(ACCESS_TOKEN);
    expect(profile).toEqual({ emailAddress: "sales@acme.test", providerAccountId: "1234567890", displayName: null });
    expect(ok.calls[0]?.url.href).toBe("https://openidconnect.googleapis.com/v1/userinfo");
    expect(ok.calls[0]?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);

    const unverified = createFakeFetch(() => json({ sub: "1", email: "x@acme.test", email_verified: false }));
    const error = await catchError(adapterWith(unverified.fetchImpl).fetchProfile(ACCESS_TOKEN));
    expect(error.code).toBe("invalid_request");
  });

  it("revokes the refresh token when present", async () => {
    const { fetchImpl, calls } = createFakeFetch(() => new Response("", { status: 200 }));
    const result = await adapterWith(fetchImpl).revoke({ accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN });
    expect(result.revoked).toBe(true);
    expect(calls[0]?.url.href).toBe("https://oauth2.googleapis.com/revoke");
    expect(new URLSearchParams(calls[0]?.body).get("token")).toBe(REFRESH_TOKEN);
  });

  it("treats an already-invalid token as revoked and network failure as not revoked", async () => {
    const gone = createFakeFetch(() => json({ error: "invalid_token", error_description: "Token expired or revoked" }, 400));
    expect((await adapterWith(gone.fetchImpl).revoke({ accessToken: ACCESS_TOKEN, refreshToken: null })).revoked).toBe(true);
    expect(new URLSearchParams(gone.calls[0]?.body).get("token")).toBe(ACCESS_TOKEN);

    const down = createFakeFetch(() => Promise.reject(new TypeError("fetch failed")));
    const result = await adapterWith(down.fetchImpl).revoke({ accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN });
    expect(result.revoked).toBe(false);
    expect(result.detail).not.toContain(REFRESH_TOKEN);
  });
});

/* ─── HTTP error mapping ──────────────────────────────────────────────── */

describe("HTTP error mapping", () => {
  const call = (fetchImpl: typeof fetch, timeoutMs = 5000) =>
    requestJson(fetchImpl, "https://gmail.googleapis.com/gmail/v1/users/me/profile", {}, { timeoutMs, provider: "google" });

  it("429 with Retry-After seconds → rate_limited with retryAfterMs", async () => {
    const { fetchImpl } = createFakeFetch(() => json({ error: { code: 429, message: "Too many" } }, 429, { "retry-after": "30" }));
    const error = await catchError(call(fetchImpl));
    expect(error).toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: 30_000, httpStatus: 429 });
  });

  it("parses Retry-After HTTP dates", () => {
    const now = Date.parse("2026-10-31T12:00:00Z");
    expect(parseRetryAfter("Sat, 31 Oct 2026 12:01:00 GMT", now)).toBe(60_000);
    expect(parseRetryAfter("garbage", now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });

  it("maps Gmail 403 reasons", async () => {
    const reasons: Array<[string, string, boolean]> = [
      ["rateLimitExceeded", "rate_limited", true],
      ["userRateLimitExceeded", "rate_limited", true],
      ["dailyLimitExceeded", "quota_exceeded", true],
      ["quotaExceeded", "quota_exceeded", true],
      ["insufficientPermissions", "insufficient_scope", false],
    ];
    for (const [reason, code, retryable] of reasons) {
      const { fetchImpl } = createFakeFetch(() =>
        json({ error: { code: 403, message: "nope", errors: [{ domain: "usageLimits", reason }] } }, 403),
      );
      const error = await catchError(call(fetchImpl));
      expect(error.code, reason).toBe(code);
      expect(error.retryable, reason).toBe(retryable);
    }
  });

  it("maps status codes and network failures", async () => {
    const statuses: Array<[number, string]> = [
      [401, "auth_revoked"],
      [404, "mailbox_not_found"],
      [410, "history_expired"],
      [500, "provider_unavailable"],
      [503, "provider_unavailable"],
    ];
    for (const [status, code] of statuses) {
      const { fetchImpl } = createFakeFetch(() => json({ error: { code: status, message: `bad ${ACCESS_TOKEN}` } }, status));
      const error = await catchError(call(fetchImpl));
      expect(error.code, String(status)).toBe(code);
      expectSafe(error);
    }
    const insufficient = createFakeFetch(() =>
      json({ error: { code: 401, message: "Request had insufficient authentication scopes." } }, 401),
    );
    expect((await catchError(call(insufficient.fetchImpl))).code).toBe("insufficient_scope");

    const rejected = createFakeFetch(() => Promise.reject(new TypeError(`connect ECONNREFUSED ${ACCESS_TOKEN}`)));
    const networkError = await catchError(call(rejected.fetchImpl));
    expect(networkError).toMatchObject({ code: "network_error", retryable: true });
    expectSafe(networkError);
  });

  it("aborts slow requests as retryable network errors", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const error = await catchError(call(hanging, 20));
    expect(error).toMatchObject({ code: "network_error", retryable: true, message: "Request to Google timed out." });
  });
});

/* ─── Capabilities ────────────────────────────────────────────────────── */

describe("Google validateCapabilities", () => {
  const granted = ["openid", "https://www.googleapis.com/auth/userinfo.email", GMAIL_METADATA_SCOPE];

  function expectEveryKeyOnce(results: Array<{ capability: string }>) {
    expect(results.map((r) => r.capability).sort()).toEqual([...CAPABILITY_KEYS].sort());
    expect(new Set(results.map((r) => r.capability)).size).toBe(CAPABILITY_KEYS.length);
  }

  it("probes the Gmail profile and reports an honest matrix", async () => {
    const { fetchImpl, calls } = createFakeFetch(() => json({ emailAddress: MAILBOX, historyId: "1" }));
    const results = await adapterWith(fetchImpl).validateCapabilities(ACCESS_TOKEN, granted);
    expectEveryKeyOnce(results);
    expect(calls[0]?.url.href).toBe("https://gmail.googleapis.com/gmail/v1/users/me/profile");
    const status = Object.fromEntries(results.map((r) => [r.capability, r.status]));
    expect(status).toMatchObject({
      sent_volume: "available",
      bounce_detection: "available",
      bounce_classification: "partial",
      reply_detection: "partial",
      auto_reply_detection: "available",
      complaint_feedback: "partial",
      unsubscribe_requests: "partial",
      sending_limit_notices: "available",
      provider_api_errors: "available",
      inbox_placement: "unavailable",
      open_tracking: "unavailable",
      realtime_push: "unavailable",
    });
    for (const r of results) expect(r.detail.length).toBeGreaterThan(10);
  });

  it("marks mailbox capabilities unavailable without the metadata scope, without calling Gmail", async () => {
    const { fetchImpl, calls } = createFakeFetch(() => json({}));
    const results = await adapterWith(fetchImpl).validateCapabilities(ACCESS_TOKEN, ["openid", "email"]);
    expectEveryKeyOnce(results);
    expect(calls).toHaveLength(0);
    for (const key of ["sent_volume", "bounce_detection", "reply_detection", "complaint_feedback"]) {
      const r = results.find((x) => x.capability === key);
      expect(r?.status).toBe("unavailable");
      expect(r?.detail).toMatch(/permission not granted/i);
    }
    expect(results.find((r) => r.capability === "inbox_placement")?.status).toBe("unavailable");
    expect(results.find((r) => r.capability === "open_tracking")?.status).toBe("unavailable");
  });

  it("handles probe failures", async () => {
    const scope = createFakeFetch(() =>
      json({ error: { code: 403, message: "x", errors: [{ reason: "insufficientPermissions" }] } }, 403),
    );
    const scoped = await adapterWith(scope.fetchImpl).validateCapabilities(ACCESS_TOKEN, granted);
    expect(scoped.find((r) => r.capability === "bounce_detection")?.status).toBe("unavailable");

    const outage = createFakeFetch(() => json({ error: { code: 503 } }, 503));
    const unknown = await adapterWith(outage.fetchImpl).validateCapabilities(ACCESS_TOKEN, granted);
    expectEveryKeyOnce(unknown);
    expect(unknown.find((r) => r.capability === "bounce_detection")?.status).toBe("unknown");
    expect(unknown.find((r) => r.capability === "inbox_placement")?.status).toBe("unavailable");

    const revoked = createFakeFetch(() => json({ error: { code: 401, message: "Invalid Credentials" } }, 401));
    const error = await catchError(adapterWith(revoked.fetchImpl).validateCapabilities(ACCESS_TOKEN, granted));
    expect(error.code).toBe("auth_revoked");
    expectSafe(error);
  });
});

/* ─── Sync ────────────────────────────────────────────────────────────── */

describe("Google syncSince", () => {
  const ourSent: Msg[] = [
    { id: "s1", threadId: "t1", labels: ["SENT"], date: day(20), headers: { From: MAILBOX, To: "a@x.test, b@y.test", Subject: "Intro Zephyr" } },
    { id: "s2", threadId: "t2", labels: ["SENT"], date: day(15), headers: { From: MAILBOX, To: "c@z.test", Subject: "Hi" } },
    { id: "s3", threadId: "t3", labels: ["SENT"], date: new Date("2026-09-20T00:00:00Z"), headers: { From: MAILBOX, To: "d@z.test" } },
  ];
  const inboxMsgs: Msg[] = [
    {
      id: "i1",
      threadId: "t1",
      labels: ["INBOX", "UNREAD"],
      date: day(21),
      headers: {
        From: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
        To: MAILBOX,
        Subject: "Delivery Status Notification (Failure)",
        "X-Failed-Recipients": "a@x.test",
        "Auto-Submitted": "auto-replied",
      },
    },
    {
      id: "i2",
      threadId: "t2",
      labels: ["INBOX"],
      date: day(16),
      headers: { From: "Cara <c@z.test>", To: MAILBOX, Subject: "Re: Hi", "In-Reply-To": "<s2@acme.test>" },
    },
    { id: "i3", threadId: "t9", labels: ["INBOX"], date: day(14), headers: { From: "news@vendor.test", To: MAILBOX, Subject: "Weekly digest" } },
    {
      id: "i4",
      threadId: "t-foreign",
      labels: ["INBOX"],
      date: day(13),
      headers: { From: "Dan <dan@else.test>", To: MAILBOX, Subject: "Re: lunch", References: "<x@else.test>" },
    },
    { id: "i5", threadId: "t-old", labels: ["INBOX"], date: new Date("2026-09-25T00:00:00Z"), headers: { From: "old@x.test" } },
  ];

  it("first sync reads the historyId, pages SENT/INBOX by label and stops at `since`", async () => {
    const { fetchImpl, calls } = gmailServer({
      messages: [...ourSent, ...inboxMsgs],
      lists: {
        SENT: [{ ids: ["s1", "s2", "s3"], next: "page-1" }, { ids: ["never"] }],
        INBOX: [{ ids: ["i1", "i2", "i3", "i4", "i5"], next: "page-1" }, { ids: ["never"] }],
      },
      threads: { "t-foreign": [["INBOX"]] },
      profileHistoryId: "4242",
    });
    const page = await adapterWith(fetchImpl).syncSince({
      accessToken: ACCESS_TOKEN,
      cursor: null,
      since: SINCE,
      mailboxAddress: MAILBOX,
      maxMessages: 100,
    });

    expect(calls[0]?.url.pathname).toBe("/gmail/v1/users/me/profile");
    // gmail.metadata cannot use `q`.
    for (const c of calls) expect(c.url.searchParams.has("q")).toBe(false);
    // Older-than-since ends the label: page 2 is never requested.
    expect(calls.some((c) => c.url.searchParams.get("pageToken") === "page-1")).toBe(false);
    expect(calls.some((c) => c.url.pathname.endsWith("/messages/never"))).toBe(false);

    const get = calls.find((c) => c.url.pathname.endsWith("/messages/s1"));
    expect(get?.url.searchParams.get("format")).toBe("metadata");
    expect(get?.url.searchParams.getAll("metadataHeaders")).toEqual(
      expect.arrayContaining(["From", "To", "Subject", "In-Reply-To", "References", "Auto-Submitted", "X-Failed-Recipients", "Content-Type"]),
    );
    expect(get?.url.searchParams.get("fields")).toContain("payload(mimeType,headers)");
    const list = calls.find((c) => c.url.pathname.endsWith("/messages") && c.url.searchParams.get("labelIds") === "SENT");
    expect(Number(list?.url.searchParams.get("maxResults"))).toBeLessThanOrEqual(100);

    const byRef = Object.fromEntries(page.signals.map((s) => [s.providerMessageRef, s]));
    expect(byRef.s1).toMatchObject({ category: "sent", metadata: { recipientCount: 2 } });
    expect(byRef.s2?.category).toBe("sent");
    expect(byRef.s3).toBeUndefined(); // before `since`
    expect(byRef.i1).toMatchObject({ category: "hard_bounce", confidence: "high", counterpartyAddress: "a@x.test" });
    expect(byRef.i2).toMatchObject({ category: "reply", confidence: "high", counterpartyAddress: "c@z.test" });
    expect(byRef.i3).toBeUndefined(); // ordinary mail
    expect(byRef.i4).toBeUndefined(); // thread lookup: no message of ours in it
    expect(byRef.i5).toBeUndefined();
    expect(calls.some((c) => c.url.pathname.endsWith("/threads/t-foreign"))).toBe(true);
    expect(JSON.stringify(page.signals)).not.toContain("Zephyr");

    expect(page.nextCursor).toEqual({ historyId: "4242" });
    expect(page.hasMore).toBe(false);
    expect(page.messagesExamined).toBe(8); // s1-s3 and i1-i5 (the first older message is examined, then the label stops)
  });

  it("respects maxMessages, sets hasMore and resumes the backfill from the cursor", async () => {
    const sent: Msg[] = Array.from({ length: 6 }, (_, i) => ({
      id: `s${i}`,
      threadId: `ts${i}`,
      labels: ["SENT"],
      date: day(28 - i),
      headers: { From: MAILBOX, To: "x@y.test" },
    }));
    const inbox: Msg[] = Array.from({ length: 6 }, (_, i) => ({
      id: `i${i}`,
      threadId: `ti${i}`,
      labels: ["INBOX"],
      date: day(28 - i),
      headers: { From: "mailer-daemon@mx.test", Subject: "Undeliverable: x" },
    }));
    const server = gmailServer({
      messages: [...sent, ...inbox],
      lists: { SENT: [{ ids: sent.map((m) => m.id) }], INBOX: [{ ids: inbox.map((m) => m.id) }] },
      profileHistoryId: "777",
    });
    const adapter = adapterWith(server.fetchImpl);
    const first = await adapter.syncSince({ accessToken: ACCESS_TOKEN, cursor: null, since: SINCE, mailboxAddress: MAILBOX, maxMessages: 4 });
    const gets = server.calls.filter((c) => /\/messages\/[^/]+$/.test(c.url.pathname));
    expect(gets.length).toBeLessThanOrEqual(4);
    expect(first.messagesExamined).toBe(4);
    expect(first.hasMore).toBe(true);
    // The budget is shared: inbox mail is not starved by a busy Sent folder.
    expect(first.signals.filter((s) => s.category === "sent")).toHaveLength(2);
    expect(first.signals.filter((s) => s.category === "hard_bounce")).toHaveLength(2);
    expect(first.nextCursor).toMatchObject({ historyId: "777", backfill: "1", sentSkip: "2", inboxSkip: "2" });

    const second = await adapter.syncSince({
      accessToken: ACCESS_TOKEN,
      cursor: first.nextCursor,
      since: SINCE,
      mailboxAddress: MAILBOX,
      maxMessages: 100,
    });
    expect(second.signals.map((s) => s.providerMessageRef).sort()).toEqual(["i2", "i3", "i4", "i5", "s2", "s3", "s4", "s5"]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toEqual({ historyId: "777" });
  });

  it("incremental sync uses history.list, skips drafts and advances the historyId", async () => {
    const messages: Msg[] = [
      { id: "n1", threadId: "tn1", labels: ["SENT"], date: day(30), headers: { From: MAILBOX, To: "a@b.test" } },
      { id: "n2", threadId: "tn2", labels: ["INBOX"], date: day(30), headers: { From: "x@y.test", Subject: "Automatic reply: hi" } },
      { id: "n3", threadId: "tn3", labels: ["SPAM"], date: day(30), headers: { From: "x@y.test", Subject: "Automatic reply: hi" } },
    ];
    const historyRequests: URLSearchParams[] = [];
    const server = gmailServer({
      messages,
      lists: {},
      history: (params) => {
        historyRequests.push(params);
        return json({
          history: [
            { id: "1001", messagesAdded: [{ message: { id: "n1", labelIds: ["SENT"] } }] },
            { id: "1002", messagesAdded: [{ message: { id: "d1", labelIds: ["DRAFT"] } }] },
            { id: "1003", messagesAdded: [{ message: { id: "n2", labelIds: ["INBOX", "UNREAD"] } }] },
            { id: "1004", messagesAdded: [{ message: { id: "n3", labelIds: ["SPAM"] } }] },
          ],
          historyId: "1010",
        });
      },
    });
    const page = await adapterWith(server.fetchImpl).syncSince({
      accessToken: ACCESS_TOKEN,
      cursor: { historyId: "1000" },
      since: SINCE,
      mailboxAddress: MAILBOX,
      maxMessages: 50,
    });
    expect(historyRequests).toHaveLength(1);
    expect(historyRequests[0]?.get("startHistoryId")).toBe("1000");
    expect(historyRequests[0]?.get("historyTypes")).toBe("messageAdded");
    expect(server.calls.some((c) => c.url.pathname.endsWith("/messages/d1"))).toBe(false);
    expect(server.calls.some((c) => c.url.pathname.endsWith("/messages/n3"))).toBe(false);
    expect(page.signals.map((s) => [s.providerMessageRef, s.category])).toEqual([
      ["n1", "sent"],
      ["n2", "auto_reply"],
    ]);
    expect(page.nextCursor).toEqual({ historyId: "1010" });
    expect(page.hasMore).toBe(false);
  });

  it("incremental sync stops at a record boundary when the budget is reached", async () => {
    const messages: Msg[] = ["a", "b", "c"].map((id) => ({
      id,
      threadId: `t${id}`,
      labels: ["SENT"],
      date: day(30),
      headers: { From: MAILBOX },
    }));
    const server = gmailServer({
      messages,
      lists: {},
      history: () =>
        json({
          history: messages.map((m, i) => ({ id: String(2001 + i), messagesAdded: [{ message: { id: m.id, labelIds: ["SENT"] } }] })),
          historyId: "2100",
        }),
    });
    const page = await adapterWith(server.fetchImpl).syncSince({
      accessToken: ACCESS_TOKEN,
      cursor: { historyId: "2000" },
      since: SINCE,
      mailboxAddress: MAILBOX,
      maxMessages: 2,
    });
    expect(page.messagesExamined).toBe(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual({ historyId: "2002" });
  });

  it("history 404 → history_expired", async () => {
    const server = gmailServer({ messages: [], lists: {}, history: () => json({ error: { code: 404, message: "Requested entity was not found." } }, 404) });
    const error = await catchError(
      adapterWith(server.fetchImpl).syncSince({
        accessToken: ACCESS_TOKEN,
        cursor: { historyId: "5" },
        since: SINCE,
        mailboxAddress: MAILBOX,
        maxMessages: 10,
      }),
    );
    expect(error.code).toBe("history_expired");
    expectSafe(error);
  });

  it("rate limiting during sync surfaces as rate_limited with Retry-After", async () => {
    const { fetchImpl } = createFakeFetch((url) =>
      url.pathname.endsWith("/profile")
        ? json({ historyId: "1" })
        : json({ error: { code: 429, message: "Resource has been exhausted" } }, 429, { "retry-after": "12" }),
    );
    const error = await catchError(
      adapterWith(fetchImpl).syncSince({ accessToken: ACCESS_TOKEN, cursor: null, since: SINCE, mailboxAddress: MAILBOX, maxMessages: 10 }),
    );
    expect(error).toMatchObject({ code: "rate_limited", retryAfterMs: 12_000, retryable: true });
    expectSafe(error);
  });
});

/* ─── Registry ────────────────────────────────────────────────────────── */

describe("provider registry", () => {
  const keys = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_TENANT"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("reads env at call time", () => {
    for (const k of keys) delete process.env[k];
    expect(getAdapter("google").isConfigured()).toBe(false);
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    expect(getAdapter("google").isConfigured()).toBe(true);
    expect(getAdapter("microsoft").isConfigured()).toBe(false);
  });

  it("lists provider status without secrets", () => {
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "very-secret-value";
    delete process.env.MICROSOFT_CLIENT_ID;
    const status = listProviderStatus();
    expect(status.map((s) => [s.provider, s.configured])).toEqual([
      ["google", true],
      ["microsoft", false],
    ]);
    expect(status[0]?.scopes).toContain(GMAIL_METADATA_SCOPE);
    expect(status[1]?.scopes).toContain("Mail.ReadBasic");
    for (const s of status) expect(s.scopeExplanations.map((e) => e.scope)).toEqual([...s.scopes]);
    expect(JSON.stringify(status)).not.toContain("very-secret-value");
  });

  it("applies overrides", async () => {
    const { fetchImpl, calls } = createFakeFetch(() => json({ sub: "1", email: "a@b.test", email_verified: true }));
    await getAdapter("google", { fetchImpl, clientId: "x", clientSecret: "y" }).fetchProfile(ACCESS_TOKEN);
    expect(calls).toHaveLength(1);
  });
});
