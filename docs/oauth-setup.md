# Mailbox OAuth setup

QuikReach connects Gmail / Google Workspace and Microsoft 365 mailboxes through OAuth apps that **you** register with each provider. It never asks for mailbox passwords. This page covers registering the apps, the environment variables, what each provider lets QuikReach observe, and the provider reviews that are still open.

Provider consoles change their labels often. Menu names below describe what to look for; confirm against the provider's current documentation.

## What happens when a provider is not configured

`isConfigured()` in each adapter is true only when the client id and client secret are set (and, for Microsoft, `MICROSOFT_TENANT` is a valid value). When it is false:

- The Mailboxes page shows the provider as "Not configured" and the connect button is disabled with an explanation.
- `POST /api/v1/mailboxes/oauth/start` returns `503 UNAVAILABLE`.
- No connection is simulated. Only seeded demo workspaces contain demo mailboxes, and those are labelled as demo data everywhere.

## Redirect URIs

The redirect URI is built from `APP_URL` (`redirectUriFor` in `lib/mailboxes/oauth.ts`) and must be registered exactly:

| Provider | Redirect URI |
|---|---|
| Google | `${APP_URL}/api/v1/mailboxes/oauth/callback/google` |
| Microsoft | `${APP_URL}/api/v1/mailboxes/oauth/callback/microsoft` |

For local development with the default `APP_URL=http://localhost:3020`, register `http://localhost:3020/api/v1/mailboxes/oauth/callback/google` and `http://localhost:3020/api/v1/mailboxes/oauth/callback/microsoft`. Both providers accept `http://localhost` redirect URIs for development; every other environment needs an `https://` redirect URI, and production requires `APP_URL` to be `https://` anyway. Register one redirect URI per environment.

## Google (Gmail API)

### 1. Project and API

1. In Google Cloud Console, create a project (or choose an existing one) for QuikReach.
2. Enable the **Gmail API** for that project (APIs & Services → Library).

### 2. OAuth consent screen

Choose the user type:

| User type | Who can connect | Verification |
|---|---|---|
| Internal | Only accounts in the Google Workspace organisation that owns the project | Google does not require app verification for Internal apps (confirm current policy). Suitable for connecting your own company's mailboxes. |
| External | Any Google account | `gmail.metadata` is a **restricted** scope. While the app is unverified (publishing status "Testing") only test users you list can connect, up to 100. Going beyond test users requires Google's app verification for restricted scopes **and** a third-party security assessment, which must be renewed annually. |

Google also documents that refresh tokens issued to External apps in "Testing" status that request scopes beyond basic profile scopes expire after 7 days. Expect pilot mailboxes on an unverified External app to move to `reauth_required` and need reconnecting weekly; confirm against current Google documentation.

Add these scopes to the consent screen (they are exactly what the adapter requests, `GOOGLE_SCOPES` in `lib/mailboxes/providers/google.ts`):

| Scope | Why (as shown to users before redirecting) |
|---|---|
| `openid` | Confirms which Google account is being connected |
| `email` | Reads the account's email address |
| `https://www.googleapis.com/auth/gmail.metadata` | Reads labels and headers to count sent mail and detect bounces, replies and auto-replies. Cannot read bodies or attachments. |

### 3. OAuth client

1. APIs & Services → Credentials → Create credentials → OAuth client ID.
2. Application type: **Web application**.
3. Authorised redirect URI: `${APP_URL}/api/v1/mailboxes/oauth/callback/google`.
4. JavaScript origins are not needed; the authorization URL is built server-side.
5. Copy the client id and client secret into the environment.

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth client id |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `APP_URL` | Base URL used to build the redirect URI |

### Authorization request as implemented

Endpoint `https://accounts.google.com/o/oauth2/v2/auth` with `response_type=code`, the three scopes, `access_type=offline` (to obtain a refresh token), `prompt=consent`, `include_granted_scopes=false`, PKCE `code_challenge_method=S256`, the state value, and `login_hint` when reconnecting an existing mailbox. Tokens are exchanged at `https://oauth2.googleapis.com/token`. The profile comes from `https://openidconnect.googleapis.com/v1/userinfo`; a connection is refused unless Google reports a verified email address.

Google Workspace administrators can restrict which third-party apps may access Gmail data. If the organisation blocks the app, the connection fails with `admin_consent_required` or `insufficient_scope` and the administrator must trust the app in the Workspace Admin console.

### gmail.metadata limitations (as implemented)

- **No `q` search parameter.** Gmail does not support `q` with `gmail.metadata`, so listings use `labelIds=SENT` and `labelIds=INBOX` and stop at the first message older than the sync window (`internalDate`).
- **Incremental sync** uses `users.history.list` (`historyTypes=messageAdded`) from the stored `historyId`. If Gmail returns 404 for an expired history id, the cursor is reset and one bounded resync of `INITIAL_SYNC_DAYS` runs.
- **Messages** are fetched with `format=metadata`, an explicit `metadataHeaders` list (From, To, Subject, Message-ID, In-Reply-To, References, Auto-Submitted, X-Autoreply, X-Autorespond, Precedence, X-Failed-Recipients, Content-Type) and a `fields` restriction.
- **No bodies.** The SMTP status code of a bounce is in the delivery report body, which is not available, so hard/soft classification is based on headers and subject patterns only.
- **Reply confirmation** reads `threads.get` with `format=minimal` (label ids only) for up to 20 threads per run.
- Updates arrive by polling (`SYNC_INTERVAL_MINUTES`); Gmail push (Pub/Sub watch) is not configured.

### Revocation

On disconnect QuikReach posts the refresh token (or access token) to `https://oauth2.googleapis.com/revoke` and deletes its stored tokens either way. If Google does not confirm revocation, the user can remove access at `https://myaccount.google.com/permissions`.

## Microsoft (Microsoft Graph)

### 1. App registration

1. In the Microsoft Entra admin center: App registrations → New registration.
2. **Supported account types** must match `MICROSOFT_TENANT`:

   | `MICROSOFT_TENANT` | Account type to choose | Who can connect |
   |---|---|---|
   | `organizations` (default) | Accounts in any organisational directory (multitenant) | Work and school accounts in any tenant |
   | a tenant id (GUID) or verified domain | Accounts in this organisational directory only | Work and school accounts in that one tenant |
   | `common` | Accounts in any organisational directory and personal Microsoft accounts | Work, school and personal accounts. The adapter is written for Exchange Online work/school mailboxes; personal accounts are not tested. |

3. **Redirect URI**: platform **Web**, value `${APP_URL}/api/v1/mailboxes/oauth/callback/microsoft`.

### 2. Client secret

Certificates & secrets → New client secret. Copy the secret **value** (not the secret id) into `MICROSOFT_CLIENT_SECRET`. Client secrets expire; record the expiry and rotate before it. When the secret expires, connections and token refreshes fail until a new secret is deployed.

### 3. API permissions

Microsoft Graph → **Delegated** permissions, exactly as requested by the adapter (`MICROSOFT_SCOPES` in `lib/mailboxes/providers/microsoft.ts`):

| Permission | Why |
|---|---|
| `offline_access` | Refresh token, so monitoring continues without the user signing in again |
| `openid` | Confirms which account is being connected |
| `email` | Reads the account's email address |
| `User.Read` | Reads the basic profile (`/me`: id, mail, userPrincipalName, displayName) |
| `Mail.ReadBasic` | Reads message metadata (sender, recipients, dates, subject, folder). Excludes body, body preview and attachments. |

### 4. Environment

| Variable | Value |
|---|---|
| `MICROSOFT_CLIENT_ID` | Application (client) id |
| `MICROSOFT_CLIENT_SECRET` | Client secret value |
| `MICROSOFT_TENANT` | `organizations` (default), `common`, or a tenant id / domain. Must match `^[A-Za-z0-9][A-Za-z0-9.-]{0,99}$` or the provider is treated as not configured. |

### User consent and admin consent

`Mail.ReadBasic` and the other permissions above do not require admin consent by Microsoft's default classification, so a user can consent for their own mailbox. Tenant policies often restrict this, for example by allowing user consent only for apps from verified publishers, or not at all. In that case the sign-in fails and QuikReach shows `admin_consent_required`; a tenant administrator must grant consent for the organisation (the app's API permissions page in that tenant, or the admin consent flow). A user who declines on the consent screen gets `consent_denied`.

**Publisher verification** (linking the app registration to a verified Microsoft partner account) is not done by QuikReach code and is a launch item: unverified multitenant apps are blocked from user consent in many tenants.

### Authorization request as implemented

Endpoint `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize` with `response_type=code`, `response_mode=query`, the five scopes, PKCE S256, the state value, `prompt=select_account`, and `login_hint` when reconnecting. The token exchange at `/<tenant>/oauth2/v2.0/token` sends the client secret (confidential client) and the PKCE verifier.

### Revocation limits

Microsoft Graph has no endpoint that revokes one application's tokens for one user. QuikReach does not call `revokeSignInSessions`, because that signs the user out of every app and device. On disconnect QuikReach deletes its stored tokens and reports that provider-side revocation was not performed. To remove access, the user removes the app at `https://myapps.microsoft.com`, or a tenant administrator removes the consent grant or the enterprise application.

### How Graph sync works (as implemented)

- Two delta queries, Sent Items and Inbox: `/me/mailFolders('<folder>')/messages/delta?$select=id,subject,from,toRecipients,sentDateTime,receivedDateTime,conversationId,internetMessageId&$filter=receivedDateTime ge <since>`. Page size is requested with `Prefer: odata.maxpagesize`. Stored delta and next links must start with `https://graph.microsoft.com/`.
- For inbound messages, headers are fetched per message with `$select=internetMessageHeaders`. If Graph refuses (`insufficient_scope`), header reads stop for that mailbox (`headerAccess: denied` in the cursor) and classification falls back to sender, subject and `conversationId`.
- Reply confirmation looks up Sent Items with `$filter=conversationId eq '<id>'` for up to 20 conversations per run.
- Polling only; Graph change notifications are not configured.

## Signals each provider exposes

Derived from `validateCapabilities` in `google.ts` and `microsoft.ts`. QuikReach stores one status per capability per connection (`provider_capabilities`) and shows the explanation to users.

Statuses: **available** — observed directly; **partial** — observed with known gaps; **unavailable** — cannot be observed with this access; **unknown** — could not be determined yet.

| Capability | Gmail (`gmail.metadata`) | Microsoft, headers available | Microsoft, headers denied | Microsoft, headers unconfirmed |
|---|---|---|---|---|
| `sent_volume` | available (SENT label) | available (Sent Items) | available | available |
| `bounce_detection` | available | available | partial (sender and subject only) | partial |
| `bounce_classification` | partial (no SMTP code; body not read) | partial | partial | partial |
| `reply_detection` | partial (In-Reply-To/References and threads) | partial (headers and conversations) | partial (conversations only) | partial |
| `auto_reply_detection` | available | available | partial (subject patterns only) | partial |
| `complaint_feedback` | partial (ARF reports delivered to the mailbox only) | partial (ARF only; JMRP/SNDS not exposed) | unavailable | unknown |
| `unsubscribe_requests` | partial (mailto requests only) | partial | partial | partial |
| `sending_limit_notices` | available (Google "limit for sending mail" notices) | unavailable (reported inside NDR bodies; counted as bounces) | unavailable | unavailable |
| `provider_api_errors` | available | available | available | available |
| `inbox_placement` | unavailable | unavailable | unavailable | unavailable |
| `open_tracking` | unavailable | unavailable | unavailable | unavailable |
| `realtime_push` | unavailable (polling) | unavailable (polling) | unavailable | unavailable |

Microsoft header access is probed once at validation with `GET /me/messages?$top=1&$select=internetMessageHeaders`: headers returned → available; `insufficient_scope` → denied; anything else (including an empty mailbox or internal mail without SMTP headers) → unconfirmed.

When the mailbox cannot be read at all, the eight mailbox-dependent capabilities (`sent_volume` through `sending_limit_notices`) take one blanket status:

| Condition | Status |
|---|---|
| No mail scope in the granted scopes (Google: none of `gmail.metadata`, `gmail.readonly`, `gmail.modify`, `https://mail.google.com/`; Microsoft: none of `Mail.ReadBasic`, `Mail.Read`, `Mail.ReadWrite`) | unavailable |
| Provider reports `insufficient_scope` on the probe | unavailable |
| No Gmail / no Exchange Online mailbox for the account | unavailable |
| Provider unreachable or other error | unknown |
| Token revoked (`auth_revoked`) | validation fails and the connection moves to `reauth_required` |

If `sent_volume` or `bounce_detection` ends up `unavailable`, the connection is set to `reauth_required` with an explanation; otherwise it becomes `connected` and the initial sync is queued.

## Verify during pilot

The adapter author could not test these against live provider APIs. Confirm them with real test mailboxes before relying on them:

1. Graph message **delta** on `mailFolders('sentitems')` and `mailFolders('inbox')` accepts `$filter=receivedDateTime ge <timestamp>` together with `$select`, and honours `Prefer: odata.maxpagesize`.
2. Graph accepts `$filter=conversationId eq '<id>'` on `/me/mailFolders('sentitems')/messages` without an "inefficient filter" error.
3. Whether `Mail.ReadBasic` returns `internetMessageHeaders`. The code handles both outcomes, but the capability table above depends on the answer.
4. Gmail partial-response `fields` syntax: `id,threadId,labelIds,historyId,internalDate,payload(mimeType,headers)` on `messages.get` and `messages(labelIds)` on `threads.get` with `format=minimal`, under the `gmail.metadata` scope.
5. Refresh-token lifetime for the Google app's publishing status (see the 7-day note above).
6. Admin-consent error codes returned by real tenants map to `admin_consent_required` as expected.

## Provider reviews still open

None of these is complete. They are tracked in [launch-dependencies.md](launch-dependencies.md) and [security.md → Reviews required before launch](security.md#reviews-required-before-launch).

- Google: restricted-scope app verification for `gmail.metadata`, the annual third-party security assessment, and compliance with the Google API Services User Data Policy (including Limited Use).
- Microsoft: publisher verification, guidance for tenant administrators on granting consent, and the Microsoft APIs Terms of Use.
