# Architecture

QuikReach is a modular monolith: one Next.js 15 application (UI and HTTP API) and one background worker process, both built from the same codebase and both talking to one PostgreSQL database through Drizzle ORM. There is no Redis, message broker or second datastore. Background work is a Postgres-backed job queue (see [ADR-003 in decisions.md](decisions.md)).

| Process | Entry point | What it does |
|---|---|---|
| Web | `next dev` / `next start` / `node server.js` (standalone build) | Pages under `app/(app)/`, HTTP API under `app/api/` |
| Worker | `scripts/worker.ts` (`npm run worker`) | Claims and runs jobs, runs the scheduler tick, reaps stale locks, exposes `/healthz` and `/metrics` |
| Migrations | `scripts/migrate.ts` (`npm run db:migrate`) | Applies SQL migrations from `db/migrations/` |
| Retention (manual) | `scripts/retention-purge.ts` (`npm run retention:purge`) | Runs the same purge the worker schedules daily |
| Key rotation (manual) | `scripts/rotate-keys.ts` (`npm run keys:rotate`) | Re-encrypts stored secrets with the active encryption key |

## Module boundaries

Modules are directories under `lib/`. API route files under `app/api/` are thin: they parse input, call a service function and return the response envelope. Services take the organisation id as an explicit argument and never read it from request input.

| Module | Responsibility | Implemented in |
|---|---|---|
| Identity and tenancy | Users, organisations, memberships, invitations, self-serve signup, session handling, principal resolution, roles and permissions | `lib/auth/`, `lib/tenancy/`, `lib/api/session.ts`, `lib/api/principal.ts`, `lib/api/with-org-auth.ts`, `lib/rbac.ts`; routes `app/api/auth/`, `app/api/invitations/accept/`, `app/api/v1/{me,organization,organizations,members,invitations}/` |
| Mailbox connections | OAuth (authorization code + PKCE), encrypted token storage and refresh, provider adapters (Gmail API, Microsoft Graph), capability validation, incremental sync, pause/disconnect | `lib/mailboxes/` (`oauth.ts`, `tokens.ts`, `service.ts`, `sync.ts`, `providers/`); routes `app/api/v1/mailboxes/` |
| Domains and DNS | Domain ownership verification (TXT record), MX/SPF/DKIM/DMARC checks with evidence, scan history and comparison | `lib/domains/service.ts`, `lib/dns/`; routes `app/api/v1/domains/` |
| Event ingestion | Idempotent storage of normalised provider signals, event search, CSV export | `lib/events/`; routes `app/api/v1/events/` |
| Health evaluation | Three separate states (domain configuration, mailbox health, campaign safety) and stored snapshots | `lib/health/`; route `app/api/v1/health/` |
| Alerts | Alert rules, evaluation, deduplicated alerts, notifications (in-app, email, webhook) | `lib/alerts/`, `lib/notify/`; routes `app/api/v1/{alert-rules,alerts,notifications}/` |
| Reports and usage | Period summaries, CSV export, plan entitlements, append-only usage ledger | `lib/reports/`, `lib/usage/`; routes `app/api/v1/{reports,usage}/` |
| AI diagnostics | Tenant-scoped evidence collection, Anthropic model or deterministic rules engine, server-side grounding enforcement | `lib/ai/`; routes `app/api/v1/diagnostics/` |
| Audit | Audit records for security-relevant and high-impact actions, audit search | `lib/audit.ts`; route `app/api/v1/audit/` |
| Integrations and campaigns | Signed outbound webhooks, campaign references, pause/resume requests and confirmation | `lib/integrations/`, `lib/campaigns/`; routes `app/api/v1/{integrations,campaigns}/` |
| Jobs | Queue, worker loop, scheduler, handlers | `lib/jobs/`, `scripts/worker.ts`; routes `app/api/v1/jobs/` |
| Shared infrastructure | DB client and schema, validated configuration, encryption and hashing, logging and metrics, rate limiting, retention, OpenAPI document | `lib/db/`, `lib/env.ts`, `lib/crypto/`, `lib/observability/`, `lib/ratelimit.ts`, `lib/retention/`, `lib/openapi.ts` |
| UI | Server-rendered pages and client components | `app/(app)/`, `app/login/`, `app/signup/`, `app/onboarding/`, `app/invitations/`, `components/`, `lib/ui/` |

`lib/roadmap/contracts.ts` holds interfaces for deferred features only; see [roadmap-contracts.md](roadmap-contracts.md).

## Request path

Every tenant-data API route is wrapped in `withOrgAuth` (`lib/api/with-org-auth.ts`). The guard runs these steps in order and stops at the first failure:

1. Assign a request id (the incoming `x-request-id` header, otherwise a random UUID).
2. For `POST`, `PUT`, `PATCH`, `DELETE`: reject cross-site requests (`403 CSRF_REJECTED`).
3. Resolve the principal from the database (`resolvePrincipal`): session identity, user status, `sessionVersion`, active memberships in active organisations. No session or a revoked one: `401 UNAUTHORIZED`. No membership: `403 NO_MEMBERSHIP`.
4. Check the route's permission against the role (`can` in `lib/rbac.ts`). Failure: `403 FORBIDDEN` (audited as `authz.denied` for mutations).
5. Reject live-data mutations in demo workspaces when the route sets `liveDataOperation` (`403 DEMO_WORKSPACE`).
6. Reject empty route parameters (`404 NOT_FOUND`).
7. Apply the per-user rate limit (`429 RATE_LIMITED`): the shared default, or the route's own counter if it declares an override.
8. Call the handler with `{ principal, params, requestId, actor, audit }`.
9. Map thrown `ApiError` to its status and code, `ZodError` to `400 VALIDATION_FAILED`, anything else to `500 INTERNAL_ERROR` (logged with the request id). A `403 FORBIDDEN` thrown by the handler on a mutating request is also audited as `authz.denied`.
10. Record the `quikreach_api_requests_total` metric and an `api_request` log line.

Routes that need a signed-in user but no organisation yet (`POST /api/v1/organizations`, `POST /api/v1/me/organization`) use `withUserAuth` from the same file. A few routes are deliberately outside both guards: `/api/health`, `/api/ready`, `/api/metrics` (bearer token), `/api/auth/*` (NextAuth), `/api/auth/signup`, `/api/invitations/accept`, `/api/v1/openapi.json`, and the OAuth callback `/api/v1/mailboxes/oauth/callback/{provider}` (which checks the session and membership itself).

## Job path

1. **Transactional enqueue.** A service writes its change and calls `enqueueJob(..., tx)` inside the same database transaction. If the transaction rolls back, the job does not exist. An optional idempotency key de-duplicates enqueues while a job with that key is `queued` or `running` (partial unique index `background_jobs_idem_uq`).
2. **Claim.** Each worker polls every `WORKER_POLL_MS` and claims up to `WORKER_CONCURRENCY - inFlight` ready jobs with `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`, ordered by `priority` then `run_at`. Claiming sets `status = 'running'`, `locked_at`, `locked_by` and increments `attempts`.
3. **Handle.** `lib/jobs/handlers.ts` maps the job type to a handler. Each handler re-loads its target with both the payload id and `job.orgId`.
4. **Complete, fail or dead-letter.**
   - Success: `status = 'succeeded'`, `result` stored.
   - Retryable failure with attempts left: back to `queued` with `run_at` = now + exponential backoff (or the provider's `Retry-After`, whichever is longer).
   - Non-retryable failure (`JobError` with `retryable: false`) or attempts exhausted: `status = 'dead'`.
   - A job left `running` for more than 10 minutes (crashed worker) is reclaimed by the reaper.

Job types (`lib/jobs/queue.ts`): `domain.scan`, `domain.verify` (no-op; verification runs inline in the request), `mailbox.validate`, `mailbox.sync`, `alerts.evaluate`, `health.compute`, `notification.deliver`, `campaign.action`, `retention.purge`.

## Diagram

```text
 Browser / API client
        │  HTTPS (TLS terminated at proxy / load balancer)
        ▼
 ┌──────────────────────────── Web process (Next.js) ───────────────────────────┐
 │ app/api/v1/<route>/route.ts                                                  │
 │   └─ withOrgAuth: request id → CSRF → resolvePrincipal (DB) → permission     │
 │        → demo guard → rate limit (DB) → handler                              │
 │             └─ lib/<module>/service.ts  (every query filtered by orgId)      │
 │                  └─ db.transaction: write rows + enqueueJob + recordAudit    │
 └──────────────────────────────────────┬───────────────────────────────────────┘
                                        │ SQL
                                        ▼
 ┌──────────────────────────────── PostgreSQL ──────────────────────────────────┐
 │ tenant tables · background_jobs · audit_logs · rate_limit_buckets            │
 │ worker_heartbeats · usage_ledger                                             │
 └──────────────────────────────────────▲───────────────────────────────────────┘
                                        │ SQL (FOR UPDATE SKIP LOCKED)
 ┌──────────────────────────── Worker process(es) ──────────────────────────────┐
 │ loop: heartbeat (15 s) · scheduler tick (60 s) · reaper (120 s) · claim      │
 │   handler(job) → re-scope by job.orgId → provider / DNS / webhook call       │
 │   → complete | retry with backoff | dead                                     │
 │ :9464 /healthz  /metrics                                                     │
 └───────┬──────────────────┬────────────────────┬──────────────────┬───────────┘
         ▼                  ▼                    ▼                  ▼
   Gmail API /        DNS resolvers       Customer webhooks    Anthropic API
   Microsoft Graph    (node:dns)          (signed, HTTPS)      (only if AI_PROVIDER=anthropic)
```

AI diagnoses run inside the web request (`POST /api/v1/diagnostics`), not in the worker. SMTP delivery of alert emails runs in the worker; invitation emails are sent from the web request.

## Data model

All 28 tables are defined in `lib/db/schema.ts` and created by `db/migrations/0000_init.sql`. "Composite FK" means the child references the parent with `(org_id, parent_id) → parent(org_id, id)`, so a row cannot point at another organisation's parent.

| Table | Purpose | Tenant key |
|---|---|---|
| `users` | Accounts (bcrypt hash or QuikIT SSO subject), status, `session_version` | None (global). Linked to organisations through `memberships` |
| `organizations` | Tenant root: name, slug, `is_demo`, status, `automation_paused`, retention overrides, settings | `id` |
| `memberships` | User ↔ organisation with role and status | `org_id` (FK, cascade) |
| `invitations` | Pending invitations; SHA-256 of the token only | `org_id` (FK, cascade) |
| `domains` | Sending domains, verification status, DKIM selectors, monitoring flag | `org_id` (FK, cascade); unique `(org_id, id)` for composite FKs |
| `domain_verifications` | TXT verification token and evidence | Composite FK to `domains` (cascade) |
| `domain_scans` | One DNS scan run | Composite FK to `domains` (cascade) |
| `domain_checks` | One MX/SPF/DKIM/DMARC result with findings and DNS evidence | Composite FKs to `domains` and `domain_scans` (cascade) |
| `mailbox_connections` | Connected mailbox, state, scopes, sync cursor and timestamps. Linked to the domain matching its address when the mailbox is connected or reconnected, or when that domain is added | `org_id` (FK, cascade); composite FK to `domains` (no cascade; deleting a domain nulls `domain_id` first) |
| `mailbox_credentials` | Encrypted access/refresh tokens and key id | Composite FK to `mailbox_connections` (cascade) |
| `provider_capabilities` | Per-connection capability status and explanation | Composite FK to `mailbox_connections` (cascade) |
| `provider_syncs` | One sync run with counts and error | Composite FK to `mailbox_connections` (cascade) |
| `oauth_states` | Single-use OAuth state hash, encrypted PKCE verifier, 10-minute expiry | `org_id` and `user_id` (FKs, cascade) |
| `provider_events` | Normalised signals (sent, bounces, replies, complaints, ...) | Composite FK to `mailbox_connections` (cascade); `domain_id` has no FK |
| `health_snapshots` | Stored health evaluations with inputs and rule version | `org_id` (FK, cascade); `subject_id` has no FK |
| `alert_rules` | Rule definition, threshold, window, action policy, version | `org_id` (FK, cascade) |
| `alerts` | Triggered, deduplicated alerts with evidence and action outcome | `org_id` (FK, cascade); `rule_id` is a single-column FK (set null) |
| `notifications` | In-app, email and webhook notifications and delivery status | `org_id` (FK, cascade); `alert_id` is a single-column FK (cascade) |
| `integrations` | Campaign-control and notification webhooks; encrypted signing secret | `org_id` (FK, cascade) |
| `campaign_references` | External campaigns linked to a mailbox and/or domain; last confirmed status | Composite FKs to `integrations` (cascade), `mailbox_connections`, `domains` |
| `campaign_actions` | Pause/resume requests and their confirmed outcome | Composite FK to `campaign_references` (cascade); `alert_id` has no FK |
| `ai_recommendations` | Stored diagnoses: engine, model, prompt version, evidence refs, output | `org_id` (FK, cascade); `subject_id` has no FK |
| `usage_ledger` | Append-only usage, idempotent per `(org_id, idempotency_key)` | `org_id` (FK, cascade) |
| `entitlements` | Plan and limits, one row per organisation | `org_id` (FK, cascade, unique) |
| `audit_logs` | Audit trail | `org_id` nullable (FK, cascade). Null for records without an organisation, such as login attempts |
| `background_jobs` | Job queue and dead-letter store | `org_id` nullable (FK, cascade). Null for global jobs (`retention.purge`) |
| `worker_heartbeats` | Last-seen time per worker process | None (global) |
| `rate_limit_buckets` | Fixed-window counters | None (global). Keys contain user ids, IP hashes or domain/mailbox ids |

Status vocabularies are `text` columns with `CHECK` constraints, not Postgres enums.

## How tenant isolation is enforced

There is no Postgres row-level security. Isolation is enforced in application code, reinforced by constraints:

1. **Server-resolved organisation.** `resolvePrincipal` reads the user and their active memberships from the database on every request. The `qr_org` cookie only selects which of those memberships is active; an organisation id the user is not an active member of is ignored. Services receive `principal.orgId`, never an id from the request body or query string.
2. **Scoped queries.** Service functions filter every read, update and delete by `org_id`. A record from another organisation therefore resolves to `404 NOT_FOUND`, indistinguishable from a missing record.
3. **Composite foreign keys.** Child tables listed above reference parents through `(org_id, parent_id)`. A bug that mixes ids across organisations fails at the database. The exceptions (single-column or no FK) are `alerts.rule_id`, `notifications.alert_id`, `campaign_actions.alert_id`, `provider_events.domain_id`, `health_snapshots.subject_id` and `ai_recommendations.subject_id`; these rely on scoped queries only.
4. **Validated references.** Ids supplied in request bodies (alert rule scope, notification webhook, campaign link mailbox/domain/integration) are checked against the caller's organisation before use.
5. **Job handlers re-scope.** Jobs carry `org_id`. Handlers load payload ids with `id = ? AND org_id = job.orgId`, so a payload id from another organisation resolves to "not found". A job type that requires an organisation but has none is dead-lettered as non-retryable.
6. **Demo isolation.** Demo organisations are skipped by the scheduler, reject live-data mutations (`liveDataOperation`), reject OAuth connections at callback time, and a `CHECK` constraint ties `provider = 'demo'` to `is_demo = true` on mailbox connections.

Cross-tenant behaviour is covered by `__tests__/integration/authz-tenancy.test.ts`.
