/**
 * Gmail adapter: Google OAuth 2.0 (authorization code + PKCE) and the Gmail
 * REST API v1, metadata only.
 *
 * Scope: `https://www.googleapis.com/auth/gmail.metadata` gives labels and
 * headers but never bodies or attachments. It is a Google *restricted* scope:
 * before public launch the OAuth app needs Google's app verification and an
 * annual third-party security assessment (CASA); until then only test users
 * listed on the consent screen can connect.
 *
 * gmail.metadata does NOT support the `q` search parameter, so every listing
 * here is label-based (SENT / INBOX) and bounded by `internalDate`, and
 * incremental sync uses users.history.list.
 *
 * Cursor shapes (opaque to callers):
 *   steady state:  { historyId }
 *   backfill:      { historyId, backfill: "1", sentPageToken?, sentSkip, sentDone,
 *                    inboxPageToken?, inboxSkip, inboxDone }
 * where historyId is the mailbox historyId captured before the backfill began,
 * so anything arriving during a multi-run backfill is picked up by history.
 */
import { z } from "zod";
import { classifyMessage, extractAddresses, type ClassifyInput } from "@/lib/mailboxes/providers/classify";
import {
  DEFAULT_TIMEOUT_MS,
  capabilitiesFrom,
  mapWithConcurrency,
  parseResponse,
  parseTokenResponse,
  postForm,
  requestJson,
} from "@/lib/mailboxes/providers/http";
import {
  ProviderError,
  type AdapterConfig,
  type CapabilityKey,
  type CapabilityResult,
  type MailboxProviderAdapter,
  type NormalizedSignal,
  type ScopeExplanation,
  type SyncPage,
} from "@/lib/mailboxes/providers/types";
import type { CapabilityStatus } from "@/lib/db/schema";

export const GMAIL_METADATA_SCOPE = "https://www.googleapis.com/auth/gmail.metadata";
export const GOOGLE_SCOPES = ["openid", "email", GMAIL_METADATA_SCOPE] as const;

/** Scopes that include header access (we only ever request gmail.metadata). */
const GMAIL_HEADER_SCOPES = new Set([
  GMAIL_METADATA_SCOPE,
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://mail.google.com/",
]);

const GOOGLE_SCOPE_EXPLANATIONS: readonly ScopeExplanation[] = [
  { scope: "openid", why: "Confirms which Google account you are connecting." },
  { scope: "email", why: "Reads the account's email address so QuikReach knows which mailbox is connected." },
  {
    scope: GMAIL_METADATA_SCOPE,
    why:
      "Reads message labels and headers (sender, recipients, date, subject line and delivery-report headers) to count " +
      "sent mail and detect bounces, replies and auto-replies. It cannot read message bodies or attachments, and " +
      "QuikReach never stores subject lines.",
  },
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

const METADATA_HEADERS = [
  "From",
  "To",
  "Subject",
  "Message-ID",
  "In-Reply-To",
  "References",
  "Auto-Submitted",
  "X-Autoreply",
  "X-Autorespond",
  "Precedence",
  "X-Failed-Recipients",
  "Content-Type",
] as const;
const WANTED_HEADERS = new Set(METADATA_HEADERS.map((h) => h.toLowerCase()));
/** Partial response: never even receive fields we do not use (e.g. snippet, sizeEstimate). */
const MESSAGE_FIELDS = "id,threadId,labelIds,historyId,internalDate,payload(mimeType,headers)";

const LIST_PAGE_SIZE = 100;
const FETCH_CONCURRENCY = 5;
const MAX_LIST_PAGES_PER_RUN = 50;
const MAX_HISTORY_PAGES = 25;
const MAX_THREAD_LOOKUPS = 20;

/* ─── Response schemas ────────────────────────────────────────────────── */

const userinfoSchema = z.object({
  sub: z.string().min(1),
  email: z.string().optional(),
  email_verified: z.union([z.boolean(), z.string()]).optional(),
});
const profileSchema = z.object({ emailAddress: z.string().optional(), historyId: z.string().regex(/^\d+$/) });
const messageListSchema = z.object({
  messages: z.array(z.object({ id: z.string() })).optional(),
  nextPageToken: z.string().optional(),
});
const messageSchema = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  historyId: z.string().optional(),
  internalDate: z.string().optional(),
  payload: z
    .object({
      mimeType: z.string().optional(),
      headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    })
    .optional(),
});
const historySchema = z.object({
  history: z
    .array(
      z.object({
        id: z.string(),
        messagesAdded: z
          .array(z.object({ message: z.object({ id: z.string(), labelIds: z.array(z.string()).optional() }) }))
          .optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
  historyId: z.string().optional(),
});
const threadSchema = z.object({ messages: z.array(z.object({ labelIds: z.array(z.string()).optional() })).optional() });

/* ─── Helpers ─────────────────────────────────────────────────────────── */

interface GmailMeta {
  id: string;
  threadId: string | null;
  labels: string[];
  internalDateMs: number | null;
  headers: Record<string, string>;
}

function toMeta(message: z.infer<typeof messageSchema>): GmailMeta {
  const headers: Record<string, string> = {};
  for (const header of message.payload?.headers ?? []) {
    const name = header.name.toLowerCase();
    if (WANTED_HEADERS.has(name) && headers[name] === undefined) headers[name] = header.value;
  }
  if (headers["content-type"] === undefined && message.payload?.mimeType) {
    headers["content-type"] = message.payload.mimeType;
  }
  const date = message.internalDate;
  return {
    id: message.id,
    threadId: message.threadId ?? null,
    labels: message.labelIds ?? [],
    internalDateMs: date && /^\d+$/.test(date) ? Number(date) : null,
    headers,
  };
}

/** Labels that mean "do not classify": drafts and chats always; spam/trash for inbound mail. */
function skipByLabels(labels: readonly string[]): boolean {
  if (labels.includes("DRAFT") || labels.includes("CHAT")) return true;
  return !labels.includes("SENT") && (labels.includes("SPAM") || labels.includes("TRASH"));
}

function maxHistoryId(a: string, b: string | undefined): string {
  if (!b || !/^\d+$/.test(b)) return a;
  return BigInt(b) > BigInt(a) ? b : a;
}

/** Capabilities that depend on reading this mailbox (the rest do not vary with access). */
type MailboxCapability = Exclude<CapabilityKey, "provider_api_errors" | "inbox_placement" | "open_tracking" | "realtime_push">;

type Cap = { status: CapabilityStatus; detail: string };

const GMAIL_CAPABILITIES: Record<MailboxCapability, Cap> = {
  sent_volume: {
    status: "available",
    detail: "Counted from messages with Gmail's SENT label (metadata only). A sent message is not proof of inbox delivery.",
  },
  bounce_detection: {
    status: "available",
    detail: "Detected from delivery-failure notices (Mail Delivery Subsystem sender and report headers) in this mailbox.",
  },
  bounce_classification: {
    status: "partial",
    detail:
      "Hard/soft classification uses notice subject and header patterns. The SMTP status code is in the notice body, " +
      "which QuikReach does not read.",
  },
  reply_detection: {
    status: "partial",
    detail:
      "Detected from In-Reply-To/References headers and Gmail threads that contain a message you sent. Replies that " +
      "drop these headers can be missed.",
  },
  auto_reply_detection: {
    status: "available",
    detail: "Detected from Auto-Submitted / X-Autoreply headers and automatic-reply subject patterns.",
  },
  complaint_feedback: {
    status: "partial",
    detail:
      "Only standard feedback reports (ARF) delivered to this mailbox are counted. Gmail does not expose individual " +
      "recipients' spam complaints; Google Postmaster Tools is a separate, aggregate-only product.",
  },
  unsubscribe_requests: {
    status: "partial",
    detail:
      "Only unsubscribe requests sent by email (mailto) to this mailbox are seen. One-click HTTPS unsubscribes go to " +
      "the sender's web endpoint, not the mailbox.",
  },
  sending_limit_notices: {
    status: "available",
    detail: "Detected from Google's \"reached a limit for sending mail\" notices.",
  },
};

type MailboxAccess = "ok" | "scope_not_granted" | "scope_rejected" | "no_gmail" | "unreachable";

function gmailCapabilities(access: MailboxAccess): CapabilityResult[] {
  const blanket: Record<Exclude<MailboxAccess, "ok">, Cap> = {
    scope_not_granted: {
      status: "unavailable",
      detail: "Gmail metadata permission not granted. Reconnect and approve it to enable this.",
    },
    scope_rejected: {
      status: "unavailable",
      detail: "Google reports the Gmail metadata permission is missing. Reconnect and approve it to enable this.",
    },
    no_gmail: { status: "unavailable", detail: "Gmail is not enabled for this Google account." },
    unreachable: { status: "unknown", detail: "Could not reach Gmail to confirm this; QuikReach will check again." },
  };
  const pick = (key: MailboxCapability): Cap => (access === "ok" ? GMAIL_CAPABILITIES[key] : blanket[access]);
  return capabilitiesFrom({
    sent_volume: pick("sent_volume"),
    bounce_detection: pick("bounce_detection"),
    bounce_classification: pick("bounce_classification"),
    reply_detection: pick("reply_detection"),
    auto_reply_detection: pick("auto_reply_detection"),
    complaint_feedback: pick("complaint_feedback"),
    unsubscribe_requests: pick("unsubscribe_requests"),
    sending_limit_notices: pick("sending_limit_notices"),
    provider_api_errors: {
      status: "available",
      detail: "Gmail API errors (revoked access, quota limits, outages) are recorded for this connection.",
    },
    inbox_placement: {
      status: "unavailable",
      detail: "Mailbox APIs cannot see whether mail landed in recipients' inbox or spam folder.",
    },
    open_tracking: { status: "unavailable", detail: "QuikReach does not track opens." },
    realtime_push: {
      status: "unavailable",
      detail: "Updates arrive by periodic polling; Gmail push notifications (Pub/Sub watch) are not configured.",
    },
  });
}

/* ─── Adapter ─────────────────────────────────────────────────────────── */

export function createGoogleAdapter(config: AdapterConfig): MailboxProviderAdapter {
  const fetchImpl: typeof fetch = config.fetchImpl ?? ((input, init) => fetch(input, init));
  const opts = { timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS, provider: "google" as const };

  const credentials = (): { clientId: string; clientSecret: string } => {
    if (!config.clientId || !config.clientSecret) {
      throw new ProviderError("invalid_request", "Google sign-in is not configured for this deployment.");
    }
    return { clientId: config.clientId, clientSecret: config.clientSecret };
  };

  const get = (url: string, accessToken: string): Promise<unknown> =>
    requestJson<unknown>(fetchImpl, url, { method: "GET", headers: { authorization: `Bearer ${accessToken}` } }, opts);

  return {
    provider: "google",
    displayName: "Gmail / Google Workspace",
    scopes: GOOGLE_SCOPES,
    scopeExplanations: GOOGLE_SCOPE_EXPLANATIONS,

    isConfigured() {
      return Boolean(config.clientId && config.clientSecret);
    },

    buildAuthorizationUrl({ state, codeChallenge, redirectUri, loginHint }) {
      const { clientId } = credentials();
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: GOOGLE_SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "false",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
      });
      if (loginHint) params.set("login_hint", loginHint);
      return `${AUTH_URL}?${params.toString()}`;
    },

    async exchangeCode({ code, codeVerifier, redirectUri }) {
      const { clientId, clientSecret } = credentials();
      const data = await postForm<unknown>(
        fetchImpl,
        TOKEN_URL,
        {
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
        },
        { ...opts, context: "code_exchange" },
      );
      return parseTokenResponse(data, "google");
    },

    async refreshAccessToken(refreshToken) {
      const { clientId, clientSecret } = credentials();
      const data = await postForm<unknown>(
        fetchImpl,
        TOKEN_URL,
        { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret },
        { ...opts, context: "token_refresh" },
      );
      return parseTokenResponse(data, "google");
    },

    async fetchProfile(accessToken) {
      const info = parseResponse(userinfoSchema, await get(USERINFO_URL, accessToken), "google");
      const verified = info.email_verified === true || info.email_verified === "true";
      if (!info.email || !verified) {
        throw new ProviderError("invalid_request", "Google did not confirm a verified email address for this account.");
      }
      return { emailAddress: info.email.trim().toLowerCase(), providerAccountId: info.sub, displayName: null };
    },

    async validateCapabilities(accessToken, grantedScopes) {
      if (!grantedScopes.some((s) => GMAIL_HEADER_SCOPES.has(s))) return gmailCapabilities("scope_not_granted");
      try {
        await get(`${GMAIL_API}/profile`, accessToken);
        return gmailCapabilities("ok");
      } catch (error: unknown) {
        if (!(error instanceof ProviderError)) throw error;
        // A dead token makes every capability moot; let the caller move the connection to reauth_required.
        if (error.code === "auth_revoked") throw error;
        if (error.code === "insufficient_scope") return gmailCapabilities("scope_rejected");
        if (error.code === "mailbox_not_found") return gmailCapabilities("no_gmail");
        return gmailCapabilities("unreachable");
      }
    },

    async syncSince(input) {
      return gmailSync(get, input);
    },

    async revoke({ accessToken, refreshToken }) {
      // Revoking the refresh token also invalidates its access tokens.
      try {
        await postForm<unknown>(fetchImpl, REVOKE_URL, { token: refreshToken ?? accessToken }, { ...opts, context: "revoke" });
        return { revoked: true, detail: "Google revoked QuikReach's access to this mailbox." };
      } catch (error: unknown) {
        if (error instanceof ProviderError && error.code === "auth_revoked") {
          return { revoked: true, detail: "Google reports the access was already revoked or expired." };
        }
        return {
          revoked: false,
          detail:
            "QuikReach deleted its stored tokens but could not confirm revocation with Google. Remove QuikReach at " +
            "https://myaccount.google.com/permissions to be sure.",
        };
      }
    },
  };
}

/* ─── Sync ────────────────────────────────────────────────────────────── */

type Getter = (url: string, accessToken: string) => Promise<unknown>;
type SyncInput = Parameters<MailboxProviderAdapter["syncSince"]>[0];

interface LabelState {
  pageToken: string | null;
  skip: number;
  done: boolean;
}

async function gmailSync(get: Getter, input: SyncInput): Promise<SyncPage> {
  const { accessToken, cursor, mailboxAddress } = input;
  const maxMessages = Math.max(1, Math.floor(input.maxMessages));

  const fetchMeta = async (id: string): Promise<GmailMeta | null> => {
    const params = new URLSearchParams({ format: "metadata", fields: MESSAGE_FIELDS });
    for (const header of METADATA_HEADERS) params.append("metadataHeaders", header);
    try {
      const raw = await get(`${GMAIL_API}/messages/${encodeURIComponent(id)}?${params.toString()}`, accessToken);
      return toMeta(parseResponse(messageSchema, raw, "google"));
    } catch (error: unknown) {
      // Deleted between listing and fetching: nothing to classify.
      if (error instanceof ProviderError && error.httpStatus === 404) return null;
      throw error;
    }
  };

  const threadHasSentMessage = async (threadId: string): Promise<boolean | undefined> => {
    const params = new URLSearchParams({ format: "minimal", fields: "messages(labelIds)" });
    try {
      const raw = await get(`${GMAIL_API}/threads/${encodeURIComponent(threadId)}?${params.toString()}`, accessToken);
      const thread = parseResponse(threadSchema, raw, "google");
      return (thread.messages ?? []).some((m) => m.labelIds?.includes("SENT") ?? false);
    } catch (error: unknown) {
      if (error instanceof ProviderError && error.code === "auth_revoked") throw error;
      return undefined; // undetermined, not "no"
    }
  };

  if (cursor && cursor.historyId !== undefined && !/^\d+$/.test(cursor.historyId)) {
    throw new ProviderError("history_expired", "Stored Gmail sync cursor is not valid; a resync is required.");
  }

  let metas: GmailMeta[];
  let examined: number;
  let nextCursor: Record<string, string>;
  let hasMore: boolean;

  if (cursor?.historyId && cursor.backfill !== "1") {
    ({ metas, examined, nextCursor, hasMore } = await incremental(get, accessToken, cursor.historyId, maxMessages, fetchMeta));
  } else {
    ({ metas, examined, nextCursor, hasMore } = await backfill(get, accessToken, cursor, input.since, maxMessages, fetchMeta));
  }

  const signals = await classifyAll(metas, mailboxAddress, threadHasSentMessage);
  return { signals, messagesExamined: examined, nextCursor, hasMore };
}

interface Collected {
  metas: GmailMeta[];
  examined: number;
  nextCursor: Record<string, string>;
  hasMore: boolean;
}

async function backfill(
  get: Getter,
  accessToken: string,
  cursor: Record<string, string> | null,
  since: Date,
  maxMessages: number,
  fetchMeta: (id: string) => Promise<GmailMeta | null>,
): Promise<Collected> {
  let startHistoryId: string;
  const resuming = cursor?.backfill === "1" && cursor.historyId !== undefined;
  if (resuming && cursor?.historyId) {
    startHistoryId = cursor.historyId;
  } else {
    // Capture the history position BEFORE listing so nothing that arrives meanwhile is missed.
    startHistoryId = parseResponse(profileSchema, await get(`${GMAIL_API}/profile`, accessToken), "google").historyId;
  }
  const readState = (prefix: "sent" | "inbox"): LabelState =>
    resuming && cursor
      ? {
          pageToken: cursor[`${prefix}PageToken`] ?? null,
          skip: Math.max(0, Number.parseInt(cursor[`${prefix}Skip`] ?? "0", 10) || 0),
          done: cursor[`${prefix}Done`] === "1",
        }
      : { pageToken: null, skip: 0, done: false };
  const states: Record<"SENT" | "INBOX", LabelState> = { SENT: readState("sent"), INBOX: readState("inbox") };

  const sinceMs = since.getTime();
  const metas: GmailMeta[] = [];
  let examined = 0;
  let budget = maxMessages;
  let pages = 0;

  const runLabel = async (label: "SENT" | "INBOX", allowance: number): Promise<void> => {
    const state = states[label];
    let left = Math.min(allowance, budget);
    while (left > 0 && !state.done && pages < MAX_LIST_PAGES_PER_RUN) {
      pages++;
      const params = new URLSearchParams({ labelIds: label, maxResults: String(LIST_PAGE_SIZE) });
      if (state.pageToken) params.set("pageToken", state.pageToken);
      const page = parseResponse(messageListSchema, await get(`${GMAIL_API}/messages?${params.toString()}`, accessToken), "google");
      const ids = (page.messages ?? []).map((m) => m.id);
      let index = Math.min(state.skip, ids.length);
      let reachedOlder = false;
      while (index < ids.length && left > 0 && !reachedOlder) {
        const chunk = ids.slice(index, index + Math.min(FETCH_CONCURRENCY, left));
        const fetched = await mapWithConcurrency(chunk, FETCH_CONCURRENCY, fetchMeta);
        index += chunk.length;
        left -= chunk.length;
        budget -= chunk.length;
        for (const meta of fetched) {
          if (!meta) continue;
          examined++;
          // Lists are newest-first, so the first message older than `since` ends this label's backfill.
          if (meta.internalDateMs !== null && meta.internalDateMs < sinceMs) {
            reachedOlder = true;
            continue;
          }
          metas.push(meta);
        }
      }
      if (reachedOlder) {
        state.done = true;
      } else if (index < ids.length) {
        state.skip = index; // budget ran out mid-page: resume this page next run
      } else if (!page.nextPageToken) {
        state.done = true;
      } else {
        state.pageToken = page.nextPageToken;
        state.skip = 0;
      }
    }
  };

  // Split the budget so a busy Sent folder cannot starve bounce/reply detection in the inbox.
  await runLabel("SENT", Math.ceil(maxMessages / 2));
  await runLabel("INBOX", budget);
  await runLabel("SENT", budget);

  if (states.SENT.done && states.INBOX.done) {
    return { metas, examined, nextCursor: { historyId: startHistoryId }, hasMore: false };
  }
  const nextCursor: Record<string, string> = { historyId: startHistoryId, backfill: "1" };
  for (const [prefix, state] of [
    ["sent", states.SENT],
    ["inbox", states.INBOX],
  ] as const) {
    if (state.pageToken) nextCursor[`${prefix}PageToken`] = state.pageToken;
    nextCursor[`${prefix}Skip`] = String(state.skip);
    nextCursor[`${prefix}Done`] = state.done ? "1" : "0";
  }
  return { metas, examined, nextCursor, hasMore: true };
}

async function incremental(
  get: Getter,
  accessToken: string,
  startHistoryId: string,
  maxMessages: number,
  fetchMeta: (id: string) => Promise<GmailMeta | null>,
): Promise<Collected> {
  const candidates: string[] = [];
  const seen = new Set<string>();
  let lastRecordId = startHistoryId;
  let latest = startHistoryId;
  let pageToken: string | undefined;
  let complete = false;
  let truncated = false;

  for (let page = 0; page < MAX_HISTORY_PAGES && !truncated; page++) {
    const params = new URLSearchParams({ startHistoryId, historyTypes: "messageAdded", maxResults: "100" });
    if (pageToken) params.set("pageToken", pageToken);
    let raw: unknown;
    try {
      raw = await get(`${GMAIL_API}/history?${params.toString()}`, accessToken);
    } catch (error: unknown) {
      if (error instanceof ProviderError && error.httpStatus === 404) {
        throw new ProviderError("history_expired", "Gmail history for this mailbox has expired; a resync is required.", {
          httpStatus: 404,
        });
      }
      throw error;
    }
    const res = parseResponse(historySchema, raw, "google");
    latest = maxHistoryId(latest, res.historyId);
    for (const record of res.history ?? []) {
      const added = (record.messagesAdded ?? [])
        .map((a) => a.message)
        .filter((m) => !seen.has(m.id) && !skipByLabels(m.labelIds ?? []));
      // Stop at a record boundary so the cursor never skips half a record. A single record larger than the
      // whole budget is taken anyway (records normally hold one message), otherwise sync could never advance.
      if (candidates.length > 0 && candidates.length + added.length > maxMessages) {
        truncated = true;
        break;
      }
      for (const m of added) {
        seen.add(m.id);
        candidates.push(m.id);
      }
      lastRecordId = maxHistoryId(lastRecordId, record.id);
    }
    if (truncated) break;
    if (!res.nextPageToken) {
      complete = true;
      break;
    }
    pageToken = res.nextPageToken;
  }

  const fetched = await mapWithConcurrency(candidates, FETCH_CONCURRENCY, fetchMeta);
  const metas = fetched.filter((m): m is GmailMeta => m !== null);
  return {
    metas,
    examined: metas.length,
    nextCursor: { historyId: complete ? maxHistoryId(latest, lastRecordId) : lastRecordId },
    hasMore: !complete,
  };
}

async function classifyAll(
  metas: GmailMeta[],
  mailboxAddress: string,
  threadHasSentMessage: (threadId: string) => Promise<boolean | undefined>,
): Promise<NormalizedSignal[]> {
  const sentThreads = new Set<string>();
  for (const meta of metas) if (meta.labels.includes("SENT") && meta.threadId) sentThreads.add(meta.threadId);

  interface Prepared {
    input: ClassifyInput;
    threadId: string | null;
    inSentThread: boolean;
    signal: NormalizedSignal | null;
  }
  const prepared: Prepared[] = [];
  const seen = new Set<string>();
  for (const meta of metas) {
    if (seen.has(meta.id) || meta.internalDateMs === null || skipByLabels(meta.labels)) continue;
    seen.add(meta.id);
    const outbound = meta.labels.includes("SENT");
    const input: ClassifyInput = {
      providerMessageRef: meta.id,
      occurredAt: new Date(meta.internalDateMs),
      direction: outbound ? "outbound" : "inbound",
      from: meta.headers.from ?? null,
      to: extractAddresses(meta.headers.to),
      subject: meta.headers.subject ?? null,
      headers: meta.headers,
      mailboxAddress,
    };
    const inSentThread = !outbound && meta.threadId !== null && sentThreads.has(meta.threadId);
    prepared.push({
      input,
      threadId: meta.threadId,
      inSentThread,
      signal: classifyMessage({ ...input, isReplyToOurThread: inSentThread ? true : undefined }),
    });
  }

  // Header-evidence replies are confirmed against the thread (bounded), so a CC on someone else's
  // conversation is not counted as a reply to this mailbox.
  const toConfirm = prepared
    .filter((p) => p.signal?.category === "reply" && !p.inSentThread && p.threadId !== null)
    .slice(0, MAX_THREAD_LOOKUPS);
  const answers = await mapWithConcurrency(toConfirm, FETCH_CONCURRENCY, (p) =>
    p.threadId ? threadHasSentMessage(p.threadId) : Promise.resolve(undefined),
  );
  toConfirm.forEach((p, i) => {
    const answer = answers[i];
    if (answer !== undefined) p.signal = classifyMessage({ ...p.input, isReplyToOurThread: answer });
  });

  return prepared.flatMap((p) => (p.signal ? [p.signal] : []));
}
