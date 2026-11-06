# Security

This page describes the security controls that exist in the code today, their limits, and the reviews still required. It is not a statement of compliance with any standard or law, and QuikReach has not had an independent security review or penetration test. Items marked **Review** need security, privacy, legal or provider review before launch.

## Tenant isolation

See [architecture.md → How tenant isolation is enforced](architecture.md#how-tenant-isolation-is-enforced). In short:

- The organisation is resolved server-side from the session and an active membership row on every request. The `qr_org` cookie only selects among the user's own active memberships.
- Every service query filters by `org_id`; another tenant's id returns `404 NOT_FOUND`.
- Child tables use composite foreign keys `(org_id, parent_id)`; a few references are single-column or unconstrained and rely on scoped queries only (listed in architecture.md).
- Background job handlers re-load targets scoped by `job.orgId`.
- There is no Postgres row-level security. **Review:** decide whether RLS is required as defence in depth.

## Roles and permissions

Five roles, 40 permissions, enforced server-side per request. The full matrix, assignment rules and the `campaign:review` separation of duties are in [permissions.md](permissions.md).

## Authentication and sessions

Two modes, chosen by configuration (`lib/env.ts`, `lib/auth/options.ts`):

| Mode | When | How |
|---|---|---|
| QuikIT SSO (`quikit_sso`) | `QUIKIT_URL` (or `QUIKIT_ISSUER_URL`), `QUIKIT_CLIENT_ID` and `QUIKIT_CLIENT_SECRET` are all set | OpenID Connect via discovery at `<issuer>/.well-known/openid-configuration`, scopes `openid email profile`, NextAuth `pkce` and `state` checks. Users are provisioned on first sign-in, keyed by the IdP subject. |
| Credentials | Otherwise | Email + password, bcrypt (cost 12). Password policy: 12–200 characters, at least one letter and one digit. |

The QuikIT IdP contract was not available to this build; the OIDC provider assumes standard discovery and must be confirmed by the integration owner ([launch-dependencies.md](launch-dependencies.md)). In SSO mode, an IdP identity is linked to an existing local account with the same email address only when the IdP sends `email_verified: true`; otherwise that sign-in is refused. Users with no existing account are created on first sign-in.

Session handling:

- NextAuth v4 with the JWT session strategy, maximum age 12 hours. The JWT is treated as proof of identity only. It carries the user id and a session version (`sv`), not roles or organisations.
- On every protected request `resolvePrincipal` (`lib/api/principal.ts`) re-reads the user and memberships. A user whose `status` is not `active`, or whose `session_version` no longer matches the `sv` in the token, is treated as signed out immediately, not at token expiry.
- Revoking all of a user's sessions means incrementing `users.session_version`. **There is no UI or API for this in this release, and no UI or API to disable a user account (`users.status`)**; both require a direct SQL update (see [operations.md → Incident response](operations.md#incident-response)). Disabling a *membership* is available in Settings → Members.
- Cookies: NextAuth's session cookie is HttpOnly and SameSite=Lax; `useSecureCookies` is enabled when `APP_URL` starts with `https://`, which adds the `Secure` attribute and the `__Secure-` name prefix. The `qr_org` organisation-selection cookie is HttpOnly, SameSite=Lax, `Secure` when `APP_URL` is https, 180-day lifetime, and only accepted if it is a UUID.
- Without `NEXTAUTH_SECRET`, development uses a fixed insecure fallback secret; production refuses to start without it.
- Login throttling: 10 attempts per 15 minutes per account (keyed by a SHA-256 of the normalised email). There is no per-IP login limit. Credentials-mode logins are audited as `auth.login` with no organisation: outcome `success`, or `denied` with the reason. SSO sign-ins are not audited.
- Self-serve signup is allowed by default outside production and disabled in production unless `ALLOW_SELF_SIGNUP=true`. **Email verification is not implemented.**

## CSRF protection

All mutating requests (`POST`, `PUT`, `PATCH`, `DELETE`) through `withOrgAuth` or `withUserAuth`, plus `POST /api/auth/signup` and `POST /api/invitations/accept`, pass `isSameOrigin`:

- If an `Origin` header is present, it must equal the origin of `APP_URL` or the request's own origin.
- If there is no `Origin` header, `Sec-Fetch-Site` must be `same-origin`.
- Otherwise the request is rejected with `403 CSRF_REJECTED`.

Non-browser clients must therefore send a matching `Origin` header on mutations. NextAuth's own endpoints (`/api/auth/*`) use NextAuth's built-in CSRF token. SameSite=Lax cookies are a second layer.

## Mailbox OAuth

Implemented in `lib/mailboxes/oauth.ts` and the provider adapters. QuikReach never asks for or stores mailbox passwords.

- **Authorization code with PKCE (S256).** The verifier is 64 random bytes (base64url) and is stored encrypted with the token-encryption key.
- **State.** 32 random bytes. Only its SHA-256 is stored, in `oauth_states`, bound to the user, organisation, provider and (for reconnects) the connection id, with a 10-minute expiry.
- **Single use.** The callback consumes the state with one conditional `UPDATE ... WHERE consumed_at IS NULL AND expires_at > now()`. A replayed, expired or wrong-provider state is rejected (`invalid_state`).
- **Session binding.** The callback must run in the session of the user who started the flow (`session_mismatch` otherwise).
- **Re-authorisation at callback time.** Membership must still be active, the organisation active, the role must still hold `mailbox:connect`, the workspace must not be a demo workspace, and (for new connections) the mailbox entitlement is re-checked. A reconnect must sign in as the same email address.
- **Least-privilege scopes.** Google: `openid`, `email`, `https://www.googleapis.com/auth/gmail.metadata`. Microsoft: `offline_access openid email User.Read Mail.ReadBasic`. Neither grants access to message bodies. See [oauth-setup.md](oauth-setup.md).
- The callback redirect carries only a short error code (`?oauth_error=<code>`), never provider error text.
- Capability validation runs in the worker after connection; if sent-volume or bounce detection is `unavailable` (scope not granted), the connection goes to `reauth_required`.
- On disconnect QuikReach attempts provider-side revocation (Google revoke endpoint; Microsoft has no per-app revoke) and always deletes its stored tokens.

## Encryption of credentials at rest

`lib/crypto/encryption.ts` encrypts OAuth access and refresh tokens, PKCE verifiers and integration signing secrets.

- AES-256-GCM, random 96-bit IV per value, additional authenticated data `quikreach:<keyId>`.
- Ciphertext format: `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url parts). The key id travels with the ciphertext.
- Keys come from `TOKEN_ENCRYPTION_KEYS="keyId:base64key,..."`. Each key must decode to exactly 32 bytes; key ids match `[A-Za-z0-9_-]{1,32}`. The **first** key encrypts; every listed key can decrypt.
- Tokens are decrypted only in memory in the worker and the OAuth callback, and are never selected by list queries or returned by the API.

Each token refresh re-encrypts both the new access token and the retained refresh token with the active key, and sets `mailbox_credentials.key_id` to it.

Key rotation procedure:

1. Generate a new key and **prepend** it: `TOKEN_ENCRYPTION_KEYS="k2:<new>,k1:<old>"`. Deploy to web and worker together. New values are encrypted with `k2`; old values still decrypt with `k1`.
2. Run the re-encryption script with the new configuration (`scripts/rotate-keys.ts`). It re-encrypts, with the active key, every mailbox credential, integration signing secret and OAuth PKCE verifier that is not already on it, and prints a JSON summary including `remainingOnOldKeys` (mailbox credentials and integration secrets still on another key). It is idempotent.

   ```bash
   npm run keys:rotate
   ```

   In a container: `npx tsx scripts/rotate-keys.ts`. Updates are conditional on the ciphertext the script read, so a token refreshed concurrently is never overwritten; it is simply left on its current key and picked up by a re-run (the summary's `remainingOnOldKeys` shows anything left). The script stops at the first value it cannot decrypt (for example one under a key no longer listed); fix the key list and run it again.
3. Remove `k1` and deploy only when the summary shows `remainingOnOldKeys: 0`. Removing it earlier makes the affected mailboxes need reconnecting and the affected integrations need recreating.

A KMS is not used. The `KeyProvider` interface in `encryption.ts` is the seam for a KMS-backed provider; **no KMS provider is implemented**. In production the keys must be injected from the platform secret manager.

`RECIPIENT_HASH_KEY` keys the HMAC used for recipient hashes and for audit IP hashes. Rotating it breaks continuity of distinct-recipient counting and of IP-hash correlation; nothing else depends on it.

## Secrets handling

| Secret | Where it lives | Notes |
|---|---|---|
| `NEXTAUTH_SECRET` | Environment | Signs session JWTs. Rotating it signs everyone out. |
| `TOKEN_ENCRYPTION_KEYS` | Environment | Losing it makes every stored token and integration secret unrecoverable. Back it up separately from database backups. |
| `RECIPIENT_HASH_KEY` | Environment | HMAC key, see above. |
| `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_SECRET`, `QUIKIT_CLIENT_SECRET` | Environment | OAuth client secrets. Microsoft client secrets expire. |
| `ANTHROPIC_API_KEY` | Environment | Only used when `AI_PROVIDER=anthropic`. |
| `SMTP_URL` | Environment | Contains SMTP credentials. |
| `DATABASE_URL` | Environment | Contains database credentials. |
| `METRICS_TOKEN` | Environment | Bearer token for both metrics endpoints. |
| Integration signing secrets | `integrations.encrypted_secret` | Generated server-side (`qrwh_` + 32 random bytes), returned once at creation, stored encrypted, deleted on revoke. |
| Invitation tokens, OAuth state | `invitations.token_hash`, `oauth_states.state_hash` | Only SHA-256 digests are stored. |

`.env` is git-ignored and excluded from the Docker build context (`.dockerignore`). In production every value above must come from the platform secret manager; see [deployment.md](deployment.md).

## Transport security and HTTP headers

TLS terminates at the load balancer or reverse proxy; the application does not serve TLS itself. In production `APP_URL` must be `https://` (enforced by `lib/env.ts`).

Headers set on every response by `next.config.ts`:

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=()` |
| `Content-Security-Policy` | `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://accounts.google.com https://login.microsoftonline.com` (development adds `'unsafe-eval'` to `script-src`) |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` — only when the config is evaluated with `NODE_ENV=production` (production builds); not sent by `next dev` |

`X-Powered-By` is disabled. API responses from the guards add `cache-control: no-store`. **Review:** the CSP allows `'unsafe-inline'` scripts (needed by the Next.js App Router bootstrap without nonces); `includeSubDomains` in HSTS affects every subdomain of the serving host.

## Audit log

`lib/audit.ts` writes to `audit_logs`. Each record has: organisation (nullable), actor type (`user`, `system`, `automation`), actor user id, actor label (email at the time, or automation name), action, target type and id, reason, outcome (`success`, `failure`, `denied`, `pending`), metadata (passed through the log redactor), request id, a truncated HMAC of the client IP (`ip_hash`), and timestamp. Audit writes inside a transaction fail the transaction if they fail.

Audited actions in this release:

| Area | Actions |
|---|---|
| Authentication and authorisation | `auth.login` (credentials mode; outcome `success` or `denied`), `authz.denied` (mutating requests denied by the route's permission, target type `permission`, or by a `403 FORBIDDEN` raised inside the handler, target type `route`) |
| Organisation | `organization.create`, `organization.update`, `organization.retention.update`, `organization.automation.pause`, `organization.automation.resume` |
| Members | `member.invite`, `member.invite.revoke`, `member.invite.accept`, `member.role.update`, `member.disable`, `member.enable`, `member.remove` |
| Domains | `domain.create`, `domain.update`, `domain.delete`, `domain.verify`, `domain.scan.request` (manual and recheck scans; scheduled scans are not audited) |
| Mailboxes | `mailbox.connect.start`, `mailbox.reconnect.start`, `mailbox.connect`, `mailbox.reconnect`, `mailbox.sync.request`, `mailbox.pause`, `mailbox.resume`, `mailbox.disconnect`, `mailbox.reauth_required` |
| Alert rules and alerts | `alert_rule.create`, `alert_rule.update`, `alert_rule.enable`, `alert_rule.disable`, `alert_rule.delete`, `alert_rule.test`, `alert.triggered`, `alert.acknowledge`, `alert.resolve` |
| Campaigns | `campaign.link`, `campaign.pause.request`, `campaign.resume.request`, `campaign.pause`, `campaign.resume` (the last two record the confirmed, unconfirmed or failed outcome, including "gave up after retries") |
| Integrations | `integration.create`, `integration.test`, `integration.disable`, `integration.revoke` |
| Data access | `event.export`, `report.export`, `diagnostic.run` |
| Operations | `job.retry`, `retention.purge` |

Audit records are searchable by Owners and Administrators (`audit:view`) in Settings → Audit and through `GET /api/v1/audit`. The request id is taken from the client's `x-request-id` header when supplied, so it is a correlation aid, not a tamper-proof identifier. The audit table is not append-only at the database level and is subject to retention. **Review:** whether audit records need write-once storage or export to an external system.

## Data minimisation

- **Metadata-only scopes.** Gmail requests use `format=metadata` with an explicit header list and a `fields` restriction; Graph requests use `$select` without `body` or `bodyPreview`. Message bodies and attachments are never requested.
- **Subjects are never stored.** The classifier (`lib/mailboxes/providers/classify.ts`) reads the subject in memory to match fixed patterns; the stored `classification_basis` names the pattern, not the text. The logger also redacts any field named `subject` or `body`.
- **Recipients.** For bounces, replies and similar events, the counterparty address is reduced to its domain (`recipient_domain`) plus `recipient_hash` = first 32 hex characters of HMAC-SHA256(`RECIPIENT_HASH_KEY`, `<orgId>:<address>`). The address itself is discarded. `sent` events store no recipient information, only a recipient count.
- **What is stored.** Mailbox email address and display name, granted scopes, provider message ids, event category, confidence and classification basis, DNS records as resolved, audit records (which include member and mailbox email addresses in metadata).
- **AI diagnostics.** When `AI_PROVIDER=anthropic`, evidence sent to the Anthropic API includes domain names, DNS check results and findings, mailbox email addresses and states, aggregated event counts, top bouncing recipient domains, alert titles and the user's question. With `AI_PROVIDER=none` nothing leaves the deployment. **Review:** sub-processor disclosure and data-processing terms for Anthropic.

## Retention and deletion

Purge runs daily at 03:00 UTC (worker) or on demand (`npm run retention:purge`). Periods are per organisation (override) or the deployment default; the defaults (`DEFAULT_EVENT_RETENTION_DAYS=90`, `DEFAULT_DIAGNOSTIC_RETENTION_DAYS=90`, `DEFAULT_AUDIT_RETENTION_DAYS=365`, minimum 30 for audit) are **placeholders pending product, security and legal review**. Exactly what is deleted, what is kept, mailbox disconnect behaviour and the absence of organisation deletion are documented in [operations.md → Retention and deletion](operations.md#retention-and-deletion).

## Rate limits and entitlements

`lib/ratelimit.ts` implements fixed-window counters in the `rate_limit_buckets` table (one upsert per check), so limits are shared by all web instances without Redis.

| Scope | Limit | Key |
|---|---|---|
| Any `withOrgAuth` mutation without an override (default) | 120 per 60 s per user, shared by all such routes | `api:<userId>:w` |
| Any `withOrgAuth` read without an override (default) | 600 per 60 s per user, shared by all such routes | `api:<userId>:r` |
| `POST /api/v1/domains` | 20 per 3600 s | `api:<userId>:POST:/api/v1/domains` |
| `POST /api/v1/invitations` | 30 per 3600 s | `api:<userId>:POST:/api/v1/invitations` |
| `POST /api/v1/mailboxes/oauth/start` | 20 per 600 s | `api:<userId>:POST:/api/v1/mailboxes/oauth/start` |
| `POST /api/v1/alert-rules/test` | 30 per 60 s | `api:<userId>:POST:/api/v1/alert-rules/test` |
| `POST /api/v1/diagnostics` | 10 per 60 s | `api:<userId>:POST:/api/v1/diagnostics` |
| `POST /api/v1/integrations/{id}/test` | 10 per 60 s, across all integrations | `api:<userId>:POST:/api/v1/integrations/:id/test` |
| `GET /api/v1/events/export` | 10 per 600 s | `api:<userId>:GET:/api/v1/events/export` |
| `GET /api/v1/reports/export` | 20 per 600 s | `api:<userId>:GET:/api/v1/reports/export` |
| `withUserAuth` routes (`POST /organizations`, `POST /me/organization`) | 30 per 60 s per user and method | `user:<userId>:<METHOD>` |
| Manual or recheck scan of one domain | 3 per 60 s | `scan:<domainId>` |
| Ownership verification of one domain | 10 per 60 s | `verify:<domainId>` |
| Manual sync of one mailbox | 4 per 300 s | `manual-sync:<connectionId>` |
| Credentials login | 10 per 900 s per account | `login:<sha256(email)>` |
| Self-serve signup | 5 per 3600 s per client IP | `signup:<ipHash>` |
| Invitation acceptance | 20 per 900 s per client IP | `invite-accept:<ipHash>` |

A route with an override has its own counter, keyed by user, method and route (UUIDs in the path are replaced by `:id`). Requests to override routes do not count against the shared default limit.

Client IPs are taken from the first value of `X-Forwarded-For`. The reverse proxy must set or overwrite that header; otherwise clients can choose their own IP for the per-IP limits and audit IP hashes.

Per-tenant entitlements (`lib/usage/entitlements.ts`) are hard stops returning `403 PLAN_LIMIT_REACHED`; nothing is billed. Defaults for every new organisation (placeholders): 5 domains, 10 connected mailboxes, 10 active members, 50 DNS scans per UTC day, 100 diagnoses per UTC month, 100,000 ingested events per UTC month. When the event allowance is exhausted, syncing stops and the mailbox state reason says so; events are not silently dropped. An entitlement whose status is not `active` or whose `valid_until` has passed blocks adding domains, mailboxes, members, scans and diagnoses. There is no API or UI to change entitlements; changes require a database update.

## Abuse controls

| Control | Who | Effect |
|---|---|---|
| Organisation automation kill switch (`POST /api/v1/organization/automation`, Settings) | `organization:update` | The scheduler enqueues nothing for the organisation: no syncs, scans, periodic alert evaluations or health snapshots. Scheduled syncs and scans that were already queued are skipped when they run (a skipped scan is marked `failed` with "Skipped: automation paused for this organization"). Alert rules with `pause_campaigns` do not request pauses while it is on (the alert records why). Still allowed: manual syncs and scans, the initial sync after a mailbox is connected, alert evaluation triggered by those (alerts and notifications are still created), already-queued alert evaluations and health snapshots, and user-requested campaign actions. |
| Per-mailbox pause (`POST /api/v1/mailboxes/{id}/pause`) | `mailbox:pause` | State `paused`: no scheduled or manual syncs; tokens are kept. Resuming sets the state to `connected` and queues the next sync. |
| Mailbox disconnect | `mailbox:disconnect` | Best-effort provider revocation, token deletion, state `disconnected`, optional event deletion. |
| Integration disable / revoke (`POST /api/v1/integrations/{id}/revoke`) | `integration:manage` | `disabled`: new campaign actions are refused and queued ones fail; a later successful test re-activates it. `revoked`: the signing secret is deleted and the integration cannot be tested or used again. |
| Membership disable / removal | `member:disable` | Access ends on the member's next request. |

## CSV formula-injection protection

`lib/reports/csv.ts` prefixes any cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return with a single quote, quotes every cell, doubles embedded quotes, and ends rows with CRLF. CSV responses send `content-disposition: attachment`, `x-content-type-options: nosniff` and `cache-control: no-store`. Both CSV exports are permission-checked, rate limited and audited.

## Outbound webhook SSRF protections

`lib/integrations/webhook.ts` checks webhook endpoints when an integration is created and on every send:

- `https://` only. `http://` is accepted only when `NODE_ENV` is not `production` and `ALLOW_PRIVATE_WEBHOOK_TARGETS=true`. `lib/env.ts` refuses to start in production with `ALLOW_PRIVATE_WEBHOOK_TARGETS=true`.
- No credentials in the URL.
- IP-literal hosts in a blocked range, and the hostnames `localhost`, `*.localhost`, `*.local` and `*.internal`, are rejected.
- Blocked ranges (a `net.BlockList`):
  - IPv4: `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`.
  - IPv6: `::`, `::1`, `64:ff9b::/96`, `100::/64`, `2001::/32`, `2001:db8::/32`, `2002::/16`, `fc00::/7`, `fe80::/10`, `ff00::/8`.
  - IPv4-mapped IPv6 addresses in dotted or hex form (`::ffff:10.0.0.1`, `::ffff:a00:1`) are checked against the IPv4 list.
- At creation, the hostname is resolved once and the integration is refused if **any** address is blocked.
- On send, the request goes through `node:http`/`node:https` with a DNS lookup function that drops blocked addresses and fails if none remain. The address that was checked is the address the socket connects to, so DNS rebinding between a check and the request is not possible. `fetchImpl` exists only as a test seam.
- Redirects are not followed; a 3xx response counts as a non-2xx response.
- 10-second socket timeout; only the first 10,000 bytes of the response are kept.

Each request has a hard 10-second deadline for the whole exchange (in addition to the socket inactivity timeout), so a slow endpoint cannot hold a worker slot. **Review:** any destination port is allowed.

## Error handling and log redaction

- API errors use a fixed envelope with a human-readable message and a stable code. `ApiError` messages are written to be safe to show. Unexpected exceptions return `500 INTERNAL_ERROR` with a generic message and the request id; details go only to the log.
- Provider adapter errors are mapped to short generic messages and never echo provider response bodies, URLs, tokens or message content.
- `lib/observability/logger.ts` emits JSON lines and redacts, at any depth (up to 6 levels), values whose key (case-insensitive) is exactly `authorization`, `cookie`, `set-cookie`, `api_key` / `api-key` / `apikey`, `code`, `code_verifier`, `subject`, `body`, `signature`, `private_key` or `refresh`, or ends in `token`, `secret`, `password` or `passwd` (for example `accessToken`, `clientSecret`). Look-alikes such as `subjectType` or `inputTokens` are not redacted. String values that look like JWTs, Google access tokens (`ya29.`) or `Bearer` credentials are masked anywhere. Arrays are truncated to 50 entries; error stacks to 6 lines.
- Audit metadata passes through the same redactor.
- `reportError` is the single hook for an external error tracker; none is wired in this release.

## Development-only dependencies

`embedded-postgres` (real PostgreSQL binaries distributed through npm) is a `devDependency` used only by `scripts/local-postgres.ts` (`npm run db:local`). No application or worker code imports it. The Docker runtime stage takes `node_modules` from a `prod-deps` stage built with `npm ci --omit=dev`, so `embedded-postgres`, `@electric-sql/pglite`, `drizzle-kit`, `vitest` and the other development tools are not in the production image. `tsx`, which runs the worker, migrations and scripts in the image, is a runtime dependency.

## Reviews required before launch

These are open items. None of them has been completed.

1. **Security review and penetration test** of the application, the worker, the deployment and the outbound webhook path, including the items flagged **Review** above (lack of RLS, CSP `'unsafe-inline'`, audit-log immutability, webhook timeout and port handling) and the trust placed in `X-Forwarded-For`.
2. **Privacy review**: data inventory and minimisation, lawful basis, mailbox metadata processing, recipient-domain and hash storage, AI evidence sent to Anthropic, data-subject requests (there is no user or organisation deletion API).
3. **Google**: OAuth consent screen verification for the restricted `gmail.metadata` scope and the required third-party security assessment, repeated annually; Google API Services User Data Policy and Limited Use requirements. Until verified, an External app is limited to listed test users.
4. **Microsoft**: publisher verification, tenant admin-consent expectations for `Mail.ReadBasic`, and Microsoft APIs Terms of Use.
5. **Legal**: data processing agreement, terms of service, privacy policy, sub-processor list (hosting provider, Anthropic if enabled, SMTP provider), and the customer authorisation basis for campaign-control webhooks.
6. **Data residency**: where the database, backups, logs and AI processing are located, and whether customers need a region choice.
7. **Retention periods**: replace the placeholder defaults for events, diagnoses and audit records, and the 400-day usage-ledger period, with approved values, and decide retention for the data the purge does not cover today (see operations.md).
