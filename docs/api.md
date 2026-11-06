# HTTP API

The QuikReach API is the same API the web UI uses. The machine-readable description is served at **`/api/v1/openapi.json`** (OpenAPI 3.1, generated from `lib/openapi.ts`; a unit test fails if a route under `app/api/v1/` is missing from it). This page summarises the conventions and lists every endpoint.

## Base path

- Versioned API: `${APP_URL}/api/v1`.
- Outside the versioned API: `/api/health`, `/api/ready`, `/api/metrics`, `/api/auth/*` (NextAuth), `/api/auth/signup`, `/api/invitations/accept`.

## Authentication

- The API uses the browser session: the NextAuth session cookie (`next-auth.session-token`, or `__Secure-next-auth.session-token` when `APP_URL` is https). Sign in through the UI (`/login`), which uses NextAuth's credentials or QuikIT SSO flow.
- **API keys, bearer tokens and service accounts are not implemented** for `/api/v1`.
- The active organisation is the one selected by the `qr_org` cookie, if the caller is an active member of it; otherwise the caller's oldest active non-demo membership (or a demo one if that is all they have). Switch with `POST /api/v1/me/organization`. An organisation id in a request body or query is never used for authorisation.
- Every request re-reads the user and membership from the database; see [security.md](security.md#authentication-and-sessions).
- **Mutations** (`POST`, `PUT`, `PATCH`, `DELETE`) must send an `Origin` header equal to the `APP_URL` origin (or the request's own origin), or `Sec-Fetch-Site: same-origin`. Otherwise they fail with `403 CSRF_REJECTED`.
- JSON request bodies are limited to 64 KB (`413 PAYLOAD_TOO_LARGE`).

## Response envelope

Success:

```json
{ "success": true, "data": { } }
```

Failure:

```json
{ "success": false, "error": "Human-readable message.", "code": "MACHINE_CODE", "details": { } }
```

`details` is present only for some errors (for example validation issues, `retryAfterSeconds`, `requestId`). Exceptions: `204` responses have no body, CSV endpoints return `text/csv`, the OAuth callback redirects, and `/api/health`, `/api/ready`, `/api/metrics` and `/api/v1/openapi.json` return their own formats.

Every response from the guards carries `x-request-id` (the incoming `x-request-id` header if the client sent one, otherwise a new UUID) and `cache-control: no-store`.

## Error codes

| HTTP | `code` | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Request body failed schema validation; `details.issues` lists `path` and `message` |
| 400 | `INVALID_JSON` | Body is not valid JSON |
| 400 | `BAD_REQUEST` | Valid shape but not allowed (for example acknowledging a resolved alert, syncing a disconnected mailbox, retrying a job that is not dead) |
| 401 | `UNAUTHORIZED` | No session, disabled user or revoked session |
| 403 | `NO_MEMBERSHIP` | Signed in but not an active member of any active organisation |
| 403 | `FORBIDDEN` | The role lacks the permission, or a role-assignment / separation-of-duties rule applies |
| 403 | `CSRF_REJECTED` | Mutation without a matching `Origin` / `Sec-Fetch-Site` |
| 403 | `DEMO_WORKSPACE` | Live-data mutation attempted in a demo workspace |
| 403 | `PLAN_LIMIT_REACHED` | Entitlement limit reached or plan not active |
| 403 | `SIGNUP_DISABLED` | `POST /api/auth/signup` when self-serve signup is off or SSO mode is active |
| 404 | `NOT_FOUND` | Missing record, or a record that belongs to another organisation |
| 409 | `CONFLICT` | Duplicate (domain already in workspace, domain verified by another organisation, campaign already linked through the integration, existing member or account), or last-owner protection |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 64 KB |
| 429 | `RATE_LIMITED` | Rate limit exceeded; `details.retryAfterSeconds` and a `retry-after` header on guard-level limits |
| 500 | `INTERNAL_ERROR` | Unexpected error; `details.requestId` identifies the log entry |
| 503 | `UNAVAILABLE` | Feature not configured (for example a mailbox provider without OAuth credentials) |

The OAuth callback reports failures as a redirect to `/mailboxes?oauth_error=<code>`, where the code is one of: `invalid_state`, `session_mismatch`, `consent_denied`, `provider_error`, `missing_code`, `forbidden`, `demo_workspace`, `unsupported_provider`, `internal_error`, a lower-cased API error code (for example `bad_request`, `plan_limit_reached`), or a provider error code (for example `auth_revoked`, `insufficient_scope`, `admin_consent_required`, `network_error`).

## Pagination and limits

| Endpoint | Behaviour |
|---|---|
| `GET /events` | `limit` 1–500 (default 100), `offset` 0–100000. Response `{ rows, hasMore }`. |
| `GET /audit` | `limit` up to 200 (default 50), `offset`. Response `{ rows, hasMore }`. |
| `GET /alerts` | Newest 100 by last trigger time; filters `status` (`open`, `acknowledged`, `resolved`, `active` = open or acknowledged) and `severity` |
| `GET /jobs` | Newest 100; optional `status` filter |
| `GET /invitations` | Newest 100 |
| `GET /diagnostics` | Newest 20 |
| `GET /notifications` | Newest 30 |
| Other list endpoints | Unpaginated (bounded by plan limits: domains, mailboxes, members, rules, integrations, campaigns; campaign actions are the newest 50) |

Event filters (`GET /events` and `GET /events/export`): `provider`, `domainId`, `connectionId`, `category` (repeatable), `from`, `to` (ISO timestamps, `from` inclusive, `to` exclusive), `includeSent`. `includeSent` accepts `true`, `1` or `on` (include) and `false`, `0` or `off` (exclude); any other value is a `400 VALIDATION_FAILED`. Without a `category` filter, `sent` events are excluded unless `includeSent` is true.

Report filters (`GET /reports/summary` and `GET /reports/export`): `from`, `to`. Default range is the last 30 days; an invalid range falls back to the default; ranges longer than 366 days are shortened to 366 days ending at `to`.

## CSV endpoints

| Endpoint | Permission | Content |
|---|---|---|
| `GET /api/v1/events/export` | `event:export` | Same filters as `GET /events` (without `limit`/`offset`), newest first, at most 50,000 rows. Header `x-quikreach-truncated: true` when more rows matched. Columns: `occurred_at`, `category`, `provider`, `mailbox`, `sending_domain`, `recipient_domain`, `classification_confidence`, `classification_basis`, `diagnostic_code`, `source`, `is_demo_data`, `ingested_at`, `event_id`. |
| `GET /api/v1/reports/export?kind=mailboxes` (default) | `report:export` | Per-mailbox totals for the range: `mailbox`, `provider`, `connection_state`, `is_demo_data`, `sent_provider_recorded`, `bounces_observed`, `hard_bounces_observed`, `bounce_rate` (empty below 20 sends), `bounce_rate_note`, `replies_observed`, `complaint_reports_observed`, `unsubscribe_requests_observed`, `provider_errors_and_limits`, `successful_syncs_in_period`. |
| `GET /api/v1/reports/export?kind=daily` | `report:export` | One row per UTC day: `day_utc`, `sent_provider_recorded`, `bounces_observed`, `bounce_rate`, `replies_observed`, `complaint_reports_observed`, `provider_errors_and_limits`. |

CSV output is formula-injection safe (see [security.md](security.md#csv-formula-injection-protection)), sent as an attachment, and every export is audited (`event.export`, `report.export`).

## Rate limits

Per-user fixed windows stored in PostgreSQL. Routes without an override share a default of 120 mutations and 600 reads per 60 seconds per user. Routes with an override (exports, diagnostics, domain creation, invitations, OAuth start, rule tests, integration tests) have their own per-user counter. All limits, including the service-level ones (per domain scan/verify, per mailbox manual sync, login, signup, invitation acceptance), are listed in [security.md → Rate limits and entitlements](security.md#rate-limits-and-entitlements).

## Idempotency

QuikReach does **not** accept a client `Idempotency-Key` header on its own API. Retrying a `POST` can create a second record, except where the server de-duplicates:

| Operation | De-duplication |
|---|---|
| `POST /domains` | Same domain name in the same organisation → `409 CONFLICT` |
| `POST /domains/{id}/scan` | An existing queued or running scan is returned with `deduplicated: true` |
| `POST /mailboxes/{id}/sync` | Job key `sync:<connectionId>`; response `{ id, deduplicated }` |
| OAuth callback | Single-use state; the connection is upserted on (organisation, provider, email) |
| `POST /campaigns` | Unique (organisation, integration, external id); a duplicate returns `409 CONFLICT` |
| `POST /campaigns/{id}/actions` | None. Each request creates a new action with its own random idempotency key (`user:<UUID>:<action>:<campaignId>`), so a retried request sends a second pause or resume. Receivers de-duplicate per key, not per campaign |

Internally:

- **Job idempotency keys** (partial unique index while `queued` or `running`): `scan:<scanId>`, `sync:<connectionId>`, `validate:<connectionId>`, `alerts:<orgId>`, `health:<orgId>`, `notify:<notificationId>`, `campaign-action:<actionId>`, `retention:<YYYY-MM-DD>`.
- **Event ingestion**: unique `(org_id, dedupe_key)` with `dedupe_key = <provider>:<connectionId>:<providerMessageId>:<category>`; re-syncs and retries never duplicate events.
- **Usage ledger**: unique `(org_id, idempotency_key)`: `scan:<scanId>` (`dns_scan`), `mailbox-connected:<connectionId>` (`mailbox_connected`), `sync-events:<syncId>` (`event_ingested`), `diagnosis:<id>` (`ai_diagnosis`). Retried jobs never double-count usage.
- **Outbound webhooks** carry an `Idempotency-Key` header that is stable across retries; see [integrations.md](integrations.md#requests-quikreach-sends).

## Endpoint index

Paths are relative to `/api/v1` unless they start with `/api/`. "Member" means any active member of the organisation (no specific permission). Success status is 200 unless stated.

### Organisation and members

| Method | Path | Permission | Success | Summary |
|---|---|---|---|---|
| GET | `/me` | Member | 200 | Current user, active organisation, role, permissions, memberships |
| POST | `/me/organization` | Signed-in user | 200 | Switch active organisation (membership verified; sets `qr_org`) |
| POST | `/organizations` | Signed-in user | 201 | Create a workspace; caller becomes Owner |
| GET | `/organization` | `organization:view` | 200 | Settings, retention overrides and deployment defaults |
| PATCH | `/organization` | `organization:update` | 200 | Update name, retention, settings (audited) |
| POST | `/organization/automation` | `organization:update` | 200 | Pause or resume all automation (kill switch) |
| GET | `/members` | `member:view` | 200 | List members |
| PATCH | `/members/{id}` | `member:update` (role) / `member:disable` (status) | 200 | Change role or enable/disable a member |
| DELETE | `/members/{id}` | `member:disable` | 204 | Remove a member (`reason` query) |
| GET | `/invitations` | `member:view` | 200 | List invitations |
| POST | `/invitations` | `member:invite` | 201 | Invite by email; accept URL returned once; `emailStatus` |
| DELETE | `/invitations/{id}` | `member:invite` | 204 | Revoke a pending invitation |

### Domains

| Method | Path | Permission | Success | Summary |
|---|---|---|---|---|
| GET | `/domains` | `domain:view` | 200 | Domains with latest scan summary |
| POST | `/domains` | `domain:create` | 201 | Add a domain; creates verification token and queues setup scan |
| GET | `/domains/{id}` | `domain:view` | 200 | Verification, latest checks with evidence, scan history, comparison |
| PATCH | `/domains/{id}` | `domain:update` | 200 | Update DKIM selectors / monitoring |
| DELETE | `/domains/{id}` | `domain:delete` | 204 | Delete a domain (`reason` query) |
| POST | `/domains/{id}/scan` | `domain:scan` | 202 | Queue a DNS scan (`trigger=recheck` optional) |
| POST | `/domains/{id}/verify` | `domain:update` | 200 | Check the ownership TXT record now |

### Mailboxes

| Method | Path | Permission | Success | Summary |
|---|---|---|---|---|
| GET | `/mailboxes` | `mailbox:view` | 200 | Mailbox connections (no credentials) |
| GET | `/mailboxes/providers` | `mailbox:view` | 200 | Configured providers, requested scopes and why |
| GET | `/mailboxes/{id}` | `mailbox:view` | 200 | Capabilities, syncs, recent events, 7-day counts |
| POST | `/mailboxes/{id}/sync` | `mailbox:sync` | 202 | Queue a manual sync |
| POST | `/mailboxes/{id}/pause` | `mailbox:pause` | 200 | Pause or resume monitoring (`paused`, `reason`) |
| POST | `/mailboxes/{id}/disconnect` | `mailbox:disconnect` | 200 | Revoke (best effort), delete tokens, optionally delete events |
| POST | `/mailboxes/oauth/start` | `mailbox:connect` | 200 | Start Google/Microsoft OAuth (PKCE); returns the authorization URL |
| GET | `/mailboxes/oauth/callback/{provider}` | Session that started the flow | 307 | OAuth redirect target; redirects to the mailbox page or `/mailboxes?oauth_error=<code>` |

### Events, alerts and diagnostics

| Method | Path | Permission | Success | Summary |
|---|---|---|---|---|
| GET | `/events` | `event:view` | 200 | Search normalised events |
| GET | `/events/export` | `event:export` | 200 (CSV) | CSV export with the same filters |
| GET | `/alert-rules` | `alert_rule:view` | 200 | List alert rules |
| POST | `/alert-rules` | `alert_rule:manage` | 201 | Create an alert rule |
| GET | `/alert-rules/{id}` | `alert_rule:view` | 200 | Get an alert rule |
| PUT | `/alert-rules/{id}` | `alert_rule:manage` | 200 | Replace an alert rule (version incremented) |
| DELETE | `/alert-rules/{id}` | `alert_rule:manage` | 204 | Delete an alert rule |
| POST | `/alert-rules/test` | `alert_rule:test` | 200 | Dry-run a rule against current data (no side effects) |
| GET | `/alerts` | `alert:view` | 200 | List alerts |
| GET | `/alerts/{id}` | `alert:view` | 200 | Alert with expanded evidence, notifications and campaign actions |
| POST | `/alerts/{id}/acknowledge` | `alert:acknowledge` | 200 | Acknowledge an open alert |
| POST | `/alerts/{id}/resolve` | `alert:resolve` | 200 | Resolve with a note |
| GET | `/notifications` | `alert:view` | 200 | Recent notifications |
| GET | `/diagnostics` | `diagnostic:view` | 200 | Diagnosis history |
| POST | `/diagnostics` | `diagnostic:run` | 201 | Run an evidence-grounded diagnosis (AI model or rules engine) |
| GET | `/diagnostics/{id}` | `diagnostic:view` | 200 | Get one diagnosis |

### Reports, operations and integrations

| Method | Path | Permission | Success | Summary |
|---|---|---|---|---|
| GET | `/reports/summary` | `report:view` | 200 | Daily series, per-mailbox totals, period counts |
| GET | `/reports/export` | `report:export` | 200 (CSV) | CSV export of the period report (`kind=mailboxes` or `daily`) |
| GET | `/usage` | `usage:view` | 200 | Usage against plan limits |
| GET | `/audit` | `audit:view` | 200 | Search audit history (`q`, `action`, `outcome`, `from`, `to`, `limit`, `offset`) |
| GET | `/health` | `domain:view` | 200 | Domain, mailbox and campaign-safety health with inputs and missing data |
| GET | `/jobs` | `job:view` | 200 | Background jobs for this organisation |
| POST | `/jobs/{id}/retry` | `job:retry` | 200 | Retry a dead-lettered job |
| GET | `/integrations` | `integration:view` | 200 | Integrations, mailbox provider status and roadmap items |
| POST | `/integrations` | `integration:manage` | 201 | Create a signed webhook integration; secret returned once |
| POST | `/integrations/{id}/test` | `integration:manage` | 200 | Send a signed ping; activates on success |
| POST | `/integrations/{id}/revoke` | `integration:manage` | 200 | Disable or revoke an integration |
| GET | `/campaigns` | `campaign:view` | 200 | Linked campaigns and the newest 50 actions |
| POST | `/campaigns` | `campaign:manage` | 201 | Link an external campaign to a mailbox and/or domain |
| POST | `/campaigns/{id}/actions` | `campaign:pause`, or `campaign:resume` / `campaign:review` for resume (`campaign:review` after critical pauses) | 202 | Request pause or resume; confirmed only by the sending system |
| GET | `/openapi.json` | None | 200 | OpenAPI document |

### Outside `/api/v1`

| Method | Path | Auth | Summary |
|---|---|---|---|
| GET | `/api/health` | None | Liveness |
| GET | `/api/ready` | None | Readiness: independent `config`, `database`, `migrations` and `worker` checks |
| GET | `/api/metrics` | `Authorization: Bearer $METRICS_TOKEN` | Prometheus metrics for the web process |
| GET, POST | `/api/auth/*` | NextAuth | Sign-in, sign-out, session, CSRF token |
| POST | `/api/auth/signup` | None (same-origin, 5 per hour per IP) | Self-serve signup in credentials mode when allowed; returns `201` |
| POST | `/api/invitations/accept` | Invitation token (same-origin, 20 per 15 min per IP) | Accept an invitation with the current session or by creating an account |

Routes marked `liveDataOperation` in code (`POST /domains`, `PATCH`/`DELETE /domains/{id}`, `POST /domains/{id}/scan`, `POST /domains/{id}/verify`, `POST /mailboxes/oauth/start`, `POST /integrations`, `POST /campaigns`, `POST /campaigns/{id}/actions`) return `403 DEMO_WORKSPACE` in demo workspaces.
