/**
 * Microsoft 365 adapter: Microsoft identity platform v2 (authorization code +
 * PKCE, confidential client) and Microsoft Graph v1.0, metadata only.
 *
 * Scope: `Mail.ReadBasic` reads message metadata but excludes body,
 * bodyPreview and attachments. The default tenant is `organizations`
 * (work/school accounts only).
 *
 * Header access (`internetMessageHeaders`) under Mail.ReadBasic is probed, not
 * assumed. When Graph refuses it, classification falls back to sender/subject
 * patterns and conversationId threading, and capabilities say so.
 *
 * Cursor shape (opaque to callers): { sentDelta?, inboxDelta?, headerAccess? }
 * where the delta values are absolute Graph nextLink/deltaLink URLs and
 * headerAccess is "denied" once Graph has refused header reads.
 */
import { z } from "zod";
import { classifyMessage, isFromMailbox, type ClassifyInput } from "@/lib/mailboxes/providers/classify";
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

export const MICROSOFT_SCOPES = ["offline_access", "openid", "email", "User.Read", "Mail.ReadBasic"] as const;
export const DEFAULT_MICROSOFT_TENANT = "organizations";

/** Scopes that cover message metadata (normalised: Graph prefix stripped, lower-cased). */
const GRAPH_MAIL_SCOPES = new Set(["mail.readbasic", "mail.read", "mail.readwrite"]);

const MICROSOFT_SCOPE_EXPLANATIONS: readonly ScopeExplanation[] = [
  { scope: "offline_access", why: "Keeps monitoring running without asking you to sign in again (refresh token)." },
  { scope: "openid", why: "Confirms which Microsoft account you are connecting." },
  { scope: "email", why: "Reads the account's email address so QuikReach knows which mailbox is connected." },
  { scope: "User.Read", why: "Reads your basic profile (name and email address) to identify the connected mailbox." },
  {
    scope: "Mail.ReadBasic",
    why:
      "Reads message metadata (sender, recipients, dates, subject line and folder) to count sent mail and detect " +
      "bounces, replies and auto-replies. It excludes message bodies, previews and attachments, and QuikReach never " +
      "stores subject lines.",
  },
];

const LOGIN_HOST = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";
const GRAPH_ORIGIN_PREFIX = "https://graph.microsoft.com/";
const MESSAGE_SELECT = "id,subject,from,toRecipients,sentDateTime,receivedDateTime,conversationId,internetMessageId";
const WANTED_HEADERS = new Set([
  "from",
  "to",
  "subject",
  "message-id",
  "in-reply-to",
  "references",
  "auto-submitted",
  "x-autoreply",
  "x-autorespond",
  "precedence",
  "x-failed-recipients",
  "content-type",
]);

const MAX_PAGE_SIZE = 50;
const MAX_DELTA_PAGES_PER_RUN = 60;
const FETCH_CONCURRENCY = 5;
const MAX_CONVERSATION_LOOKUPS = 20;
const TENANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,99}$/;
const REPLY_SUBJECT = /^\s*re\s*:/i;

/* ─── Response schemas ────────────────────────────────────────────────── */

const meSchema = z.object({
  id: z.string().min(1),
  mail: z.string().nullish(),
  userPrincipalName: z.string().nullish(),
  displayName: z.string().nullish(),
});
const recipientSchema = z.object({
  emailAddress: z.object({ name: z.string().nullish(), address: z.string().nullish() }).nullish(),
});
const graphMessageSchema = z.object({
  id: z.string(),
  subject: z.string().nullish(),
  from: recipientSchema.nullish(),
  toRecipients: z.array(recipientSchema).nullish(),
  sentDateTime: z.string().nullish(),
  receivedDateTime: z.string().nullish(),
  conversationId: z.string().nullish(),
});
type GraphMessage = z.infer<typeof graphMessageSchema>;
const deltaPageSchema = z.object({
  value: z.array(z.unknown()),
  "@odata.nextLink": z.string().optional(),
  "@odata.deltaLink": z.string().optional(),
});
const headerListSchema = z.array(z.object({ name: z.string(), value: z.string() })).nullish();
const headerProbeSchema = z.object({ value: z.array(z.object({ internetMessageHeaders: headerListSchema })) });
const messageHeadersSchema = z.object({ internetMessageHeaders: headerListSchema });
const idListSchema = z.object({ value: z.array(z.object({ id: z.string() })) });

/* ─── Capabilities ────────────────────────────────────────────────────── */

type MailboxCapability = Exclude<CapabilityKey, "provider_api_errors" | "inbox_placement" | "open_tracking" | "realtime_push">;
type Cap = { status: CapabilityStatus; detail: string };
type MailboxAccess = "ok" | "scope_not_granted" | "scope_rejected" | "no_mailbox" | "unreachable";
/** available: Graph returned headers; denied: Graph refused; unconfirmed: could not tell (e.g. empty mailbox). */
type HeaderAccess = "available" | "denied" | "unconfirmed";

const JMRP_NOTE = "Microsoft's complaint programs (JMRP, SNDS) are separate and not exposed through mailbox access.";

function graphCapabilitiesWhenReadable(headers: HeaderAccess): Record<MailboxCapability, Cap> {
  const withHeaders = headers === "available";
  const headerGap =
    headers === "denied"
      ? "message headers are not accessible with this permission"
      : "access to message headers could not be confirmed yet";
  return {
    sent_volume: {
      status: "available",
      detail: "Counted from the Sent Items folder (metadata only). A sent message is not proof of inbox delivery.",
    },
    bounce_detection: withHeaders
      ? {
          status: "available",
          detail: "Detected from non-delivery reports (system sender, subject and report headers) in this mailbox.",
        }
      : { status: "partial", detail: `Detected from the non-delivery report's sender and subject only; ${headerGap}.` },
    bounce_classification: {
      status: "partial",
      detail:
        "Hard/soft classification uses report subject and header patterns. The SMTP status code is in the report " +
        "body, which QuikReach does not read.",
    },
    reply_detection: withHeaders
      ? {
          status: "partial",
          detail:
            "Detected from In-Reply-To/References headers and Outlook conversations that contain a message you sent. " +
            "Replies that drop these can be missed.",
        }
      : {
          status: "partial",
          detail: `Detected from Outlook conversations (conversationId) that contain a message you sent; ${headerGap}.`,
        },
    auto_reply_detection: withHeaders
      ? { status: "available", detail: "Detected from Auto-Submitted headers and automatic-reply subject patterns." }
      : {
          status: "partial",
          detail: `Detected from automatic-reply subject patterns only (e.g. "Automatic reply:"); ${headerGap}.`,
        },
    complaint_feedback:
      headers === "available"
        ? { status: "partial", detail: `Only standard feedback reports (ARF) delivered to this mailbox are counted. ${JMRP_NOTE}` }
        : headers === "denied"
          ? { status: "unavailable", detail: `Feedback reports cannot be recognised without message headers. ${JMRP_NOTE}` }
          : { status: "unknown", detail: `Depends on message header access, which could not be confirmed yet. ${JMRP_NOTE}` },
    unsubscribe_requests: {
      status: "partial",
      detail:
        "Only unsubscribe requests sent by email (mailto) to this mailbox are seen. One-click HTTPS unsubscribes go to " +
        "the sender's web endpoint, not the mailbox.",
    },
    sending_limit_notices: {
      status: "unavailable",
      detail:
        "Exchange Online reports sending limits inside non-delivery report bodies, which QuikReach does not read; " +
        "such reports are counted as bounces.",
    },
  };
}

function graphCapabilities(access: MailboxAccess, headers: HeaderAccess): CapabilityResult[] {
  const blanket: Record<Exclude<MailboxAccess, "ok">, Cap> = {
    scope_not_granted: {
      status: "unavailable",
      detail: "Mail.ReadBasic permission not granted. Reconnect and approve it to enable this.",
    },
    scope_rejected: {
      status: "unavailable",
      detail: "Microsoft reports the mail permission is missing. Reconnect and approve it to enable this.",
    },
    no_mailbox: { status: "unavailable", detail: "No Exchange Online mailbox is available for this account." },
    unreachable: { status: "unknown", detail: "Could not reach Microsoft Graph to confirm this; QuikReach will check again." },
  };
  const readable = graphCapabilitiesWhenReadable(headers);
  const pick = (key: MailboxCapability): Cap => (access === "ok" ? readable[key] : blanket[access]);
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
      detail: "Microsoft Graph errors (revoked access, throttling, outages) are recorded for this connection.",
    },
    inbox_placement: {
      status: "unavailable",
      detail: "Mailbox APIs cannot see whether mail landed in recipients' inbox or junk folder.",
    },
    open_tracking: { status: "unavailable", detail: "QuikReach does not track opens." },
    realtime_push: {
      status: "unavailable",
      detail: "Updates arrive by periodic polling with delta queries; Graph change notifications are not configured.",
    },
  });
}

/* ─── Helpers ─────────────────────────────────────────────────────────── */

function normalizeGraphScope(scope: string): string {
  return scope.replace(/^https:\/\/graph\.microsoft\.com\//i, "").toLowerCase();
}

function formatAddress(r: z.infer<typeof recipientSchema> | null | undefined): string | null {
  const address = r?.emailAddress?.address?.trim();
  if (!address) return null;
  const name = r?.emailAddress?.name?.replace(/["<>]/g, "").trim();
  return name ? `"${name}" <${address}>` : address;
}

/** Second-precision UTC literal for OData $filter. */
function odataDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function initialDeltaUrl(folder: "sentitems" | "inbox", since: Date): string {
  const filter = encodeURIComponent(`receivedDateTime ge ${odataDate(since)}`);
  return `${GRAPH}/me/mailFolders('${folder}')/messages/delta?$select=${MESSAGE_SELECT}&$filter=${filter}`;
}

/** Cursor links are followed with the user's bearer token, so they must point at Graph and nowhere else. */
function assertGraphLink(link: string): string {
  if (!link.startsWith(GRAPH_ORIGIN_PREFIX)) {
    throw new ProviderError("history_expired", "Stored Microsoft sync cursor is not valid; a resync is required.");
  }
  return link;
}

/* ─── Adapter ─────────────────────────────────────────────────────────── */

export function createMicrosoftAdapter(config: AdapterConfig): MailboxProviderAdapter {
  const fetchImpl: typeof fetch = config.fetchImpl ?? ((input, init) => fetch(input, init));
  const opts = { timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS, provider: "microsoft" as const };
  const tenant = config.tenant?.trim() || DEFAULT_MICROSOFT_TENANT;

  const credentials = (): { clientId: string; clientSecret: string; base: string } => {
    if (!config.clientId || !config.clientSecret) {
      throw new ProviderError("invalid_request", "Microsoft sign-in is not configured for this deployment.");
    }
    if (!TENANT_PATTERN.test(tenant)) {
      throw new ProviderError("invalid_request", "Microsoft tenant setting is invalid.");
    }
    return { clientId: config.clientId, clientSecret: config.clientSecret, base: `${LOGIN_HOST}/${tenant}/oauth2/v2.0` };
  };

  const get = (url: string, accessToken: string, extraHeaders: Record<string, string> = {}): Promise<unknown> =>
    requestJson<unknown>(
      fetchImpl,
      url,
      { method: "GET", headers: { authorization: `Bearer ${accessToken}`, ...extraHeaders } },
      opts,
    );

  return {
    provider: "microsoft",
    displayName: "Microsoft 365 / Outlook",
    scopes: MICROSOFT_SCOPES,
    scopeExplanations: MICROSOFT_SCOPE_EXPLANATIONS,

    isConfigured() {
      return Boolean(config.clientId && config.clientSecret) && TENANT_PATTERN.test(tenant);
    },

    buildAuthorizationUrl({ state, codeChallenge, redirectUri, loginHint }) {
      const { clientId, base } = credentials();
      const params = new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        response_mode: "query",
        scope: MICROSOFT_SCOPES.join(" "),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        prompt: "select_account",
      });
      if (loginHint) params.set("login_hint", loginHint);
      return `${base}/authorize?${params.toString()}`;
    },

    async exchangeCode({ code, codeVerifier, redirectUri }) {
      const { clientId, clientSecret, base } = credentials();
      const data = await postForm<unknown>(
        fetchImpl,
        `${base}/token`,
        {
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
          scope: MICROSOFT_SCOPES.join(" "),
        },
        { ...opts, context: "code_exchange" },
      );
      return parseTokenResponse(data, "microsoft");
    },

    async refreshAccessToken(refreshToken) {
      const { clientId, clientSecret, base } = credentials();
      const data = await postForm<unknown>(
        fetchImpl,
        `${base}/token`,
        {
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          scope: MICROSOFT_SCOPES.join(" "),
        },
        { ...opts, context: "token_refresh" },
      );
      return parseTokenResponse(data, "microsoft");
    },

    async fetchProfile(accessToken) {
      const me = parseResponse(
        meSchema,
        await get(`${GRAPH}/me?$select=id,mail,userPrincipalName,displayName`, accessToken),
        "microsoft",
      );
      const email = (me.mail || me.userPrincipalName || "").trim().toLowerCase();
      if (!email) {
        throw new ProviderError("invalid_request", "Microsoft did not return an email address for this account.");
      }
      return { emailAddress: email, providerAccountId: me.id, displayName: me.displayName?.trim() || null };
    },

    async validateCapabilities(accessToken, grantedScopes) {
      if (!grantedScopes.some((s) => GRAPH_MAIL_SCOPES.has(normalizeGraphScope(s)))) {
        return graphCapabilities("scope_not_granted", "unconfirmed");
      }
      try {
        await get(`${GRAPH}/me/mailFolders('sentitems')?$select=id`, accessToken);
      } catch (error: unknown) {
        if (!(error instanceof ProviderError)) throw error;
        if (error.code === "auth_revoked") throw error;
        if (error.code === "insufficient_scope") return graphCapabilities("scope_rejected", "unconfirmed");
        if (error.code === "mailbox_not_found") return graphCapabilities("no_mailbox", "unconfirmed");
        return graphCapabilities("unreachable", "unconfirmed");
      }
      let headers: HeaderAccess;
      try {
        const probe = parseResponse(
          headerProbeSchema,
          await get(`${GRAPH}/me/messages?$top=1&$select=internetMessageHeaders`, accessToken),
          "microsoft",
        );
        const first = probe.value[0];
        // Messages that never crossed SMTP (internal mail) legitimately lack headers, so absence is "unconfirmed".
        headers = first && Array.isArray(first.internetMessageHeaders) ? "available" : "unconfirmed";
      } catch (error: unknown) {
        if (!(error instanceof ProviderError)) throw error;
        if (error.code === "auth_revoked") throw error;
        headers = error.code === "insufficient_scope" ? "denied" : "unconfirmed";
      }
      return graphCapabilities("ok", headers);
    },

    async syncSince(input) {
      return graphSync(get, input);
    },

    async revoke() {
      // Graph's revokeSignInSessions would sign the user out of every app and device, so it is never used.
      return {
        revoked: false,
        detail:
          "Microsoft does not support revoking a single app's tokens. QuikReach deleted its stored tokens; remove the " +
          "app's consent at https://myapps.microsoft.com (or ask your Entra admin).",
      };
    },
  };
}

/* ─── Sync ────────────────────────────────────────────────────────────── */

type Getter = (url: string, accessToken: string, extraHeaders?: Record<string, string>) => Promise<unknown>;
type SyncInput = Parameters<MailboxProviderAdapter["syncSince"]>[0];
type Folder = "sentitems" | "inbox";

interface FolderState {
  /** Next URL to fetch: a stored deltaLink/nextLink, or null when this folder has not started. */
  link: string | null;
  done: boolean;
}

interface Fetched {
  folder: Folder;
  message: GraphMessage;
}

async function graphSync(get: Getter, input: SyncInput): Promise<SyncPage> {
  const { accessToken, mailboxAddress, since } = input;
  const cursor = input.cursor ?? {};
  const maxMessages = Math.max(1, Math.floor(input.maxMessages));

  const states: Record<Folder, FolderState> = {
    sentitems: { link: cursor.sentDelta ? assertGraphLink(cursor.sentDelta) : null, done: false },
    inbox: { link: cursor.inboxDelta ? assertGraphLink(cursor.inboxDelta) : null, done: false },
  };
  let headerAccess: "unknown" | "denied" = cursor.headerAccess === "denied" ? "denied" : "unknown";

  const fetched: Fetched[] = [];
  const seen = new Set<string>();
  let budget = maxMessages;
  let pages = 0;

  const runFolder = async (folder: Folder, allowance: number): Promise<void> => {
    const state = states[folder];
    if (state.done) return;
    let left = Math.min(allowance, budget);
    let url = state.link ?? initialDeltaUrl(folder, since);
    // state.link always holds the next unfetched link, so stopping anywhere below resumes correctly.
    while (left > 0 && pages < MAX_DELTA_PAGES_PER_RUN) {
      pages++;
      // Ask for no more than the remaining budget so maxMessages holds without dropping part of a page.
      const raw = await get(url, accessToken, { prefer: `odata.maxpagesize=${Math.min(MAX_PAGE_SIZE, left)}` });
      const page = parseResponse(deltaPageSchema, raw, "microsoft");
      for (const item of page.value) {
        if (typeof item === "object" && item !== null && "@removed" in item) continue;
        const parsed = graphMessageSchema.safeParse(item);
        if (!parsed.success || seen.has(parsed.data.id)) continue;
        seen.add(parsed.data.id);
        fetched.push({ folder, message: parsed.data });
        left--;
        budget--;
      }
      const nextLink = page["@odata.nextLink"];
      const deltaLink = page["@odata.deltaLink"];
      if (nextLink) {
        url = assertGraphLink(nextLink);
        state.link = url;
        continue;
      }
      if (deltaLink) {
        state.link = assertGraphLink(deltaLink);
        state.done = true;
        return;
      }
      throw new ProviderError("unknown", "Unexpected response from Microsoft.");
    }
  };

  // Split the budget so a busy Sent Items folder cannot starve bounce/reply detection in the inbox.
  await runFolder("sentitems", Math.ceil(maxMessages / 2));
  await runFolder("inbox", budget);
  await runFolder("sentitems", budget);

  const fetchHeaders = async (id: string): Promise<Record<string, string>> => {
    if (headerAccess === "denied") return {};
    try {
      const raw = await get(`${GRAPH}/me/messages/${encodeURIComponent(id)}?$select=internetMessageHeaders`, accessToken);
      const headers: Record<string, string> = {};
      for (const h of parseResponse(messageHeadersSchema, raw, "microsoft").internetMessageHeaders ?? []) {
        const name = h.name.toLowerCase();
        if (WANTED_HEADERS.has(name) && headers[name] === undefined) headers[name] = h.value;
      }
      return headers;
    } catch (error: unknown) {
      if (error instanceof ProviderError && error.code === "insufficient_scope") {
        headerAccess = "denied";
        return {};
      }
      if (error instanceof ProviderError && error.httpStatus === 404) return {};
      throw error; // transient failures fail the run so the cursor does not advance past unclassified mail
    }
  };

  const lookupConversation = async (conversationId: string): Promise<boolean | undefined> => {
    const filter = encodeURIComponent(`conversationId eq '${conversationId.replace(/'/g, "''")}'`);
    try {
      const raw = await get(
        `${GRAPH}/me/mailFolders('sentitems')/messages?$filter=${filter}&$top=1&$select=id`,
        accessToken,
      );
      return parseResponse(idListSchema, raw, "microsoft").value.length > 0;
    } catch (error: unknown) {
      if (error instanceof ProviderError && error.code === "auth_revoked") throw error;
      return undefined;
    }
  };

  const sentConversations = new Set<string>();
  for (const f of fetched) {
    if (f.folder === "sentitems" && f.message.conversationId) sentConversations.add(f.message.conversationId);
  }

  const inbound = fetched.filter((f) => f.folder === "inbox");
  const inboundHeaders = await mapWithConcurrency(inbound, FETCH_CONCURRENCY, (f) => fetchHeaders(f.message.id));
  const headersById = new Map<string, Record<string, string>>();
  inbound.forEach((f, i) => headersById.set(f.message.id, inboundHeaders[i] ?? {}));

  interface Prepared {
    input: ClassifyInput;
    conversationId: string | null;
    inSentConversation: boolean;
    needsLookup: boolean;
    signal: NormalizedSignal | null;
  }
  const prepared: Prepared[] = [];
  for (const { folder, message } of fetched) {
    const outbound = folder === "sentitems";
    const when = outbound ? (message.sentDateTime ?? message.receivedDateTime) : message.receivedDateTime;
    const occurredAt = when ? new Date(when) : null;
    if (!occurredAt || Number.isNaN(occurredAt.getTime())) continue;
    const headers = outbound ? {} : (headersById.get(message.id) ?? {});
    const from = formatAddress(message.from);
    const input: ClassifyInput = {
      providerMessageRef: message.id,
      occurredAt,
      direction: outbound ? "outbound" : "inbound",
      from,
      to: (message.toRecipients ?? [])
        .map((r) => r.emailAddress?.address?.trim().toLowerCase())
        .filter((a): a is string => Boolean(a)),
      subject: message.subject ?? null,
      headers,
      mailboxAddress,
    };
    const conversationId = message.conversationId ?? null;
    const inSentConversation = !outbound && conversationId !== null && sentConversations.has(conversationId);
    const signal = classifyMessage({ ...input, isReplyToOurThread: inSentConversation ? true : undefined });
    const hasReplyHeaders = Boolean(headers["in-reply-to"]?.trim() || headers["references"]?.trim());
    const needsLookup =
      !outbound &&
      !inSentConversation &&
      conversationId !== null &&
      !isFromMailbox(from, mailboxAddress) &&
      (signal?.category === "reply" || (signal === null && !hasReplyHeaders && REPLY_SUBJECT.test(message.subject ?? "")));
    prepared.push({ input, conversationId, inSentConversation, needsLookup, signal });
  }

  const toLookup = prepared.filter((p) => p.needsLookup).slice(0, MAX_CONVERSATION_LOOKUPS);
  const answers = await mapWithConcurrency(toLookup, FETCH_CONCURRENCY, (p) =>
    p.conversationId ? lookupConversation(p.conversationId) : Promise.resolve(undefined),
  );
  toLookup.forEach((p, i) => {
    const answer = answers[i];
    if (answer !== undefined) p.signal = classifyMessage({ ...p.input, isReplyToOurThread: answer });
  });

  const nextCursor: Record<string, string> = {};
  if (states.sentitems.link) nextCursor.sentDelta = states.sentitems.link;
  if (states.inbox.link) nextCursor.inboxDelta = states.inbox.link;
  if (headerAccess === "denied") nextCursor.headerAccess = "denied";

  return {
    signals: prepared.flatMap((p) => (p.signal ? [p.signal] : [])),
    messagesExamined: fetched.length,
    nextCursor,
    hasMore: !(states.sentitems.done && states.inbox.done),
  };
}
