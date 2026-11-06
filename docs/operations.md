# Operations

How to run QuikReach locally, operate the worker, observe it, back it up, and respond to incidents. Deployment topology is in [deployment.md](deployment.md); security controls are in [security.md](security.md).

## Local setup

Requirements: Node.js 22 or later (`engines.node` is `>=22`), npm, and either Docker or the bundled embedded PostgreSQL.

### 1. Install dependencies

```bash
npm install
```

### 2. Start PostgreSQL

Option A, no Docker: run a real PostgreSQL server from the `embedded-postgres` package (development only). It listens on port 54329 (override with `LOCAL_PG_PORT`), stores data in `.data/postgres`, and on first start creates the databases `quikreach` and `quikreach_test`. Leave it running in its own terminal.

```bash
npm run db:local
```

Option B, Docker: run only the database service from `docker-compose.yml` (PostgreSQL 17 on port 5432).

```bash
docker compose up db
```

### 3. Configure the environment

```bash
cp .env.example .env
```

`DATABASE_URL` in `.env.example` points at the embedded server (port 54329). For Docker, use the port-5432 URL given in the comment above it.

Generate the secrets and paste them into `.env`:

| Variable | Command |
|---|---|
| `NEXTAUTH_SECRET` | `openssl rand -base64 48` |
| `TOKEN_ENCRYPTION_KEYS` | `echo "k1:$(openssl rand -base64 32)"` |
| `RECIPIENT_HASH_KEY` | `openssl rand -base64 32` |
| `METRICS_TOKEN` (optional) | `openssl rand -hex 32` |

```bash
openssl rand -base64 48
```

```bash
echo "k1:$(openssl rand -base64 32)"
```

```bash
openssl rand -base64 32
```

Development falls back to a fixed insecure `NEXTAUTH_SECRET` if it is empty, but `TOKEN_ENCRYPTION_KEYS` and `RECIPIENT_HASH_KEY` have no fallback: without them, starting a mailbox connection, creating an integration and ingesting events fail. Mailbox OAuth also needs the provider variables from [oauth-setup.md](oauth-setup.md).

### 4. Apply migrations

```bash
npm run db:migrate
```

### 5. Optional: seed the demo workspace

```bash
npm run db:seed:demo
```

It needs `RECIPIENT_HASH_KEY` to be set. It creates the user `demo@quikreach.test` (password from `DEMO_USER_PASSWORD`, or a random one printed once) and an organisation flagged `is_demo` named "DEMO — Northwind Outbound (sample data)". Demo data is isolated:

- The domain is under the reserved `.example` TLD.
- Mailboxes use provider `demo` and state `demo`; a database `CHECK` constraint ties `provider = 'demo'` to `is_demo = true`.
- DNS checks use rule version `demo-seed` and resolver "demo-seed (not a live DNS query)"; events use source `demo_seed` and `is_demo = true`.
- The scheduler skips demo organisations, live-data API mutations return `403 DEMO_WORKSPACE`, and the OAuth callback refuses to connect real mailboxes to a demo workspace.

Running it again does nothing if the demo workspace exists. To delete and recreate it:

```bash
npm run db:seed:demo -- --reset
```

### 6. Run the app and the worker

In two terminals:

```bash
npm run dev
```

```bash
npm run worker
```

The app listens on `http://localhost:3020`. Self-serve signup at `/signup` is allowed outside production by default. Without the worker, pages load but scans, syncs, alert evaluation, notifications and campaign actions never run, and `/api/ready` reports `degraded`.

## Checks

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm test
```

Tests run against in-memory PGlite (PostgreSQL compiled to WebAssembly) with the real migrations applied. They need no database server, no network, no provider credentials and no DNS. `npm run check` runs all three. CI (`.github/workflows/ci.yml`) runs `npm ci`, typecheck, lint, tests and `npm run build` on Node 22.

## Schema changes

1. Edit `lib/db/schema.ts`.
2. Generate a migration:

   ```bash
   npm run db:generate
   ```

3. Read the generated SQL in `db/migrations/` before applying it. Check for destructive statements, table rewrites and lock-heavy operations; for rolling deploys, keep changes backward compatible with the previous release (add first, remove later).
4. Apply it:

   ```bash
   npm run db:migrate
   ```

5. Commit the SQL file together with `db/migrations/meta/`. Tests apply the same migrations, so a schema change without a migration fails the test suite.

Applied migrations are recorded in `drizzle.__drizzle_migrations`.

## Worker operations

The worker (`scripts/worker.ts`, `lib/jobs/worker.ts`) is one Node process per instance. Several instances can run at once.

| Setting | Default | Effect |
|---|---|---|
| `WORKER_CONCURRENCY` | 4 (1–32) | Jobs run in parallel per worker |
| `WORKER_POLL_MS` | 2000 (250–60000) | Sleep between polls when there is no more ready work |
| `WORKER_HEALTH_PORT` | 9464 (0 disables) | Port for `/healthz` and `/metrics` |
| `SYNC_INTERVAL_MINUTES` | 15 (5–1440) | Delay before the next scheduled sync after a successful one |
| `SCAN_INTERVAL_HOURS` | 24 (1–720) | Age after which a verified domain is rescanned |
| `SYNC_MAX_MESSAGES` | 500 (10–5000) | Messages examined per sync run |
| `INITIAL_SYNC_DAYS` | 14 (1–90) | Look-back window for the first sync and for resyncs |

### Loop timing

Each worker heartbeats every 15 seconds (`worker_heartbeats`), runs the scheduler tick about every 60 seconds, reaps stale locks every 2 minutes, and otherwise claims jobs. When a poll fills every free slot it polls again immediately; otherwise it sleeps `WORKER_POLL_MS`.

### Scheduler cadence

`schedulerTick` (`lib/jobs/scheduler.ts`) skips organisations that are suspended, demo, or have automation paused. Scheduled syncs and scans that were queued before the kill switch was turned on are skipped when they run. Periodic work uses boundary crossing between the previous and current tick, so a drifting tick does not skip a period.

| Work | When | Idempotency key |
|---|---|---|
| Mailbox sync | Every tick, for up to 500 mailboxes in state `connected` or `degraded` whose `next_sync_at` is null or due | `sync:<connectionId>` |
| Scheduled DNS scan | Every tick, for up to 200 domains that are verified, have monitoring enabled, and were last scanned more than `SCAN_INTERVAL_HOURS` ago (or never). Skipped quietly when the daily scan limit is reached. | `scan:<scanId>` |
| Alert evaluation | Each 5-minute boundary, per organisation (also on the first tick after a worker starts) | `alerts:<orgId>` |
| Health snapshots | Each hour boundary, per organisation (also on the first tick after start) | `health:<orgId>` |
| Retention purge | Checked on the first tick after start and at each hour boundary, but only between 03:00 and 24:00 UTC; queued if no `retention.purge` job has succeeded since 03:00 UTC that day | `retention:<YYYY-MM-DD>` |

`next_sync_at` is set to now + `SYNC_INTERVAL_MINUTES` after a complete sync, now + 30 seconds when the provider has more messages waiting, and to an exponential backoff (`SYNC_INTERVAL_MINUTES × 2^(failures−1)`, capped at 6 hours) after provider failures. After 3 consecutive failures the connection becomes `degraded`. Outside the schedule, alert evaluation and health snapshots are queued 5 seconds after every completed scan, and alert evaluation is queued 10 seconds after a sync that created events.

For scheduled scans, an existing `queued` or `running` scan of the same domain is reused instead of creating a second one.

Idempotency keys only de-duplicate while a job is `queued` or `running`. With several workers, a periodic job can occasionally run twice in one period; the handlers are idempotent.

A worker that was down at 03:00 UTC runs the purge at the next hourly check the same UTC day. To run it immediately (for example after a long outage):

```bash
npm run retention:purge
```

### Retries, backoff and dead-letter

- Default `max_attempts` is 5 (user-requested campaign actions: 3).
- Retry delay: `min(30 s × 2^(attempts−1), 1 h)` plus up to 20% jitter (at most 30 s), or the provider's `Retry-After` if longer.
- Errors marked non-retryable (for example a revoked mailbox token, a missing organisation or a missing payload field) go straight to `dead`.
- When a `domain.scan` job uses its last attempt, the scan is marked `failed`. When a `campaign.action` job uses its last attempt, the action is marked `failed`, a linked alert's outcome becomes `pause_failed`, and a `campaign.pause` / `campaign.resume` audit record with outcome `failure` is written.
- Dead jobs keep `last_error` and are listed in **Settings → Jobs** (`job:view`: Owner, Administrator, Deliverability Manager).
- Retry a dead job from Settings → Jobs or through the API (`job:retry`: Owner, Administrator). This resets `attempts` to 0 and queues it immediately. Only dead jobs of the caller's organisation can be retried; global jobs (`retention.purge`) cannot, so rerun those with the command above.

```bash
curl -X POST "$APP_URL/api/v1/jobs/<jobId>/retry" -H "Origin: $APP_URL" -H "Cookie: <session cookie>"
```

- Finished jobs (`succeeded`, `cancelled`, `dead`) are deleted 30 days after completion by the retention purge.

### Stale locks

A job left `running` with `locked_at` older than 10 minutes is reclaimed by the next reaper pass: back to `queued` (or `dead` if attempts are exhausted), with `[reclaimed: worker lock expired]` appended to `last_error`. A job that genuinely runs longer than 10 minutes would be run again; sync and scan runs are bounded (message limits, page limits, 15-second provider timeouts, 12-second DNS check budgets) to stay well under that.

### Graceful shutdown

On `SIGTERM` or `SIGINT` the worker stops claiming, waits up to 25 seconds for in-flight jobs, closes the health server and the database pool, and exits. Jobs still running at that point stay `running` until the reaper reclaims them about 10 minutes later. Give the worker a termination grace period of at least 30 seconds.

## Health and readiness

| Endpoint | Process | Semantics |
|---|---|---|
| `GET /api/health` | Web | Liveness. Always `200 {"status":"ok",...}` while the process serves requests. Checks no dependencies. |
| `GET /api/ready` | Web | Readiness. Returns `{ status, checks }` with independent checks, each with `ok` and `detail`: `config` (environment validates), `database` (`select 1`), `migrations` (rows in `drizzle.__drizzle_migrations`), `worker` (newest heartbeat younger than 90 seconds). `200` with `status: "ready"` when config, database and migrations pass and the worker check passes. `200` with `status: "degraded"` when only the worker check fails (pages work; scans, syncs and alerts do not run). `503` with `status: "unavailable"` when config, database or migrations fail. Later checks are skipped when an earlier one fails (no database check without valid config). |
| `GET :9464/healthz` | Worker | `200` when the worker loop is running and its last heartbeat is less than 60 seconds old, otherwise `503`. Body includes worker id, in-flight count, last heartbeat and last tick. |

Example failure details: `config: invalid configuration (see server logs)`, `database: unreachable`, `migrations: migrations have not been applied (run npm run db:migrate)`, `worker: no worker heartbeat recorded`.

## Metrics

Both processes keep in-memory counters (reset on restart) and expose them in Prometheus text format. Scrape every web instance and every worker.

| Endpoint | Auth |
|---|---|
| `GET /api/metrics` (web) | `Authorization: Bearer $METRICS_TOKEN`; `401` if the token is unset or wrong |
| `GET :9464/metrics` (worker) | Same token |

```bash
curl -H "Authorization: Bearer $METRICS_TOKEN" "$APP_URL/api/metrics"
```

| Metric | Type | Labels | Emitted by |
|---|---|---|---|
| `quikreach_api_requests_total` | counter | `route`, `method`, `status` | Web (`withOrgAuth`); UUIDs in paths are replaced by `:id` |
| `quikreach_jobs_total` | counter | `type`, `outcome` (`succeeded`, `retry`, `dead`) | Worker |
| `quikreach_jobs_ready` | gauge | — | Worker: queued jobs whose `run_at` has passed |
| `quikreach_sync_runs_total` | counter | `provider`, `status` (`succeeded`, `failed`) | Worker |
| `quikreach_events_ingested_total` | counter | `provider` | Worker |
| `quikreach_provider_errors_total` | counter | `provider`, `code`, `phase` (`validate`, `sync`) | Worker |
| `quikreach_dns_checks_total` | counter | `check`, `status` | Worker |

No alerting rules ship with QuikReach. Reasonable starting points: `/api/ready` returning `degraded` for more than a few minutes, growth in `quikreach_jobs_total{outcome="dead"}`, a rising `quikreach_jobs_ready`, and spikes in `quikreach_provider_errors_total{code="auth_revoked"}`.

## Logs

Both processes write one JSON object per line: `info` and `debug` to stdout, `warn` and `error` to stderr. `LOG_LEVEL` is `debug`, `info` (default), `warn`, `error` or `silent`.

Every line has `ts`, `level`, `msg` and `service` (`quikreach-web`, or `quikreach-worker` for the worker). Common messages and their fields:

| `msg` | Fields |
|---|---|
| `api_request` | `requestId`, `route`, `method`, `status`, `ms`, `orgId` |
| `unhandled_error` | `error` (`name`, `message`, first 6 stack lines) plus context such as `requestId`, `route`, `orgId`, `jobId`, `type`, `deadLettered` |
| `job_succeeded` | `worker`, `jobId`, `type`, `orgId`, `ms`, `attempt` |
| `job_failed_will_retry` | `worker`, `jobId`, `type`, `orgId`, `attempt`, `error` |
| `worker_started`, `worker_shutdown`, `worker_stopped`, `scheduler_tick`, `reaped_stale_jobs`, `worker_health_listening` | Worker lifecycle |
| `sync_cursor_reset`, `mailbox_revoke_failed`, `ai_diagnosis_failed`, `audit_write_failed`, `email_send_failed` | Component-specific warnings |

Values under keys that look like secrets, tokens, cookies, authorization headers, OAuth codes, subjects or bodies are replaced with `[redacted]`, and token-like strings are masked anywhere. See [security.md → Error handling and log redaction](security.md#error-handling-and-log-redaction) for the exact rules. Dead-lettered jobs are logged as `unhandled_error` with `deadLettered: true`.

## Backup and restore

### What to back up

1. **The PostgreSQL database.** All application state, including the job queue and audit log, is in one database.
2. **`TOKEN_ENCRYPTION_KEYS`, separately.** Stored OAuth tokens and integration signing secrets are encrypted with these keys. A database backup without the keys cannot decrypt them. If the keys are lost, every mailbox must be reconnected by its users and every integration recreated (new signing secret shared with the receiver). Store the keys in the secret manager with its own backup and access controls, not alongside database dumps.
3. **`NEXTAUTH_SECRET` and `RECIPIENT_HASH_KEY`.** Losing `NEXTAUTH_SECRET` signs everyone out; losing `RECIPIENT_HASH_KEY` breaks continuity of distinct-recipient hashes. Neither loses data.

### Managed PostgreSQL

Use the provider's automated backups with point-in-time recovery, and set backup retention in line with the approved data-retention policy. Backups contain personal data (email addresses, audit records); encrypt them and restrict access.

### Logical dumps

Create a compressed custom-format dump:

```bash
pg_dump --format=custom --no-owner --no-privileges --file="quikreach-$(date +%Y%m%d%H%M).dump" "$DATABASE_URL"
```

Restore into an empty database:

```bash
pg_restore --no-owner --no-privileges --dbname="$RESTORE_DATABASE_URL" quikreach-YYYYMMDDHHMM.dump
```

Restore over an existing database (drops and recreates the objects in the dump):

```bash
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$RESTORE_DATABASE_URL" quikreach-YYYYMMDDHHMM.dump
```

The dump includes the `drizzle` schema with the migration history, so `npm run db:migrate` after a restore applies only migrations newer than the backup.

### Restore drill

Run this on a schedule (for example quarterly) against a non-production environment:

1. Restore the latest backup (or a PITR target time) into a fresh database.
2. Point a web instance and a worker at it with the **production** `TOKEN_ENCRYPTION_KEYS`.
3. Check `/api/ready` returns `ready`.
4. Sign in, open a mailbox and confirm a manual sync succeeds (proves tokens decrypt), and send an integration test (proves signing secrets decrypt).
5. Record the time taken and any gaps.

Stop workers that point at a restored copy of production data before the drill ends, so they do not sync mailboxes or send webhooks from two places.

## Retention and deletion

Implemented in `lib/retention/purge.ts`. For each organisation, periods come from the organisation's override (Settings, `PATCH /api/v1/organization`) or the deployment default:

| Data | Period | Rule |
|---|---|---|
| `provider_events` | Event retention (default 90 days) | Deleted when `occurred_at` is older |
| `health_snapshots` | Event retention | Deleted when `computed_at` is older |
| `notifications` | Event retention | Deleted when `created_at` is older |
| `domain_scans` (and their `domain_checks`, by cascade) | Event retention | Deleted when `created_at` is older, **except the latest completed scan of each domain**, which is always kept |
| Resolved `alerts` (and their notifications, by cascade) | Event retention | Deleted when `resolved_at` is older. Open and acknowledged alerts are never purged |
| `ai_recommendations` | Diagnostic retention (default 90 days) | Deleted when `created_at` is older |
| `audit_logs` | Audit retention (default 365 days, minimum 30) | Deleted when `created_at` is older |
| `provider_syncs` | Event retention | Deleted when `started_at` is older |
| `invitations` | Event retention | Deleted when `created_at` is older **and** the invitation was accepted, revoked or has expired. Pending, unexpired invitations are kept |
| `domain_verifications` | Event retention | Deleted when `created_at` is older and the status is `failed` or `superseded`. Pending and verified records are kept |
| `campaign_actions` | Audit retention | Deleted when finished (`completed_at` set) and `created_at` is older. Unfinished actions are kept |
| `usage_ledger` | 400 days (`USAGE_LEDGER_RETENTION_DAYS` constant in `purge.ts`, not configurable per organisation) | Deleted when `occurred_at` is older |

Global housekeeping in the same run:

- `background_jobs` in `succeeded`, `cancelled` or `dead`, completed more than 30 days ago.
- `oauth_states` that expired more than a day ago.
- `rate_limit_buckets` windows older than a day.
- `worker_heartbeats` not seen for 7 days.
- `audit_logs` rows with no organisation (for example logins) older than `DEFAULT_AUDIT_RETENTION_DAYS`.

Each organisation with at least one deletion gets a `retention.purge` audit record with the counts and periods used. All default periods, including the 400-day usage-ledger period, are **placeholders pending product, security and legal review**.

Not covered by the purge: `campaign_references`, `provider_capabilities`, `mailbox_connections` (including disconnected ones), `domains`, `alert_rules`, `integrations` (including revoked ones), `entitlements`, `memberships` and `users`. These stay until removed manually or until a retention rule is added.

**Mailbox disconnect** (`POST /api/v1/mailboxes/{id}/disconnect`): best-effort provider revocation, stored tokens deleted, state `disconnected`, sync cursor cleared. Events are kept until normal retention unless the request sets `deleteEvents: true`, in which case that mailbox's events are deleted in the same transaction. The connection row, its sync history and capabilities remain.

**Domain deletion** (`DELETE /api/v1/domains/{id}`): mailbox connections and campaign references keep existing with `domain_id` set to null; the domain's verifications, scans and checks are deleted by cascade.

**Organisation deletion**: deleting an `organizations` row cascades to every tenant table, but **there is no UI or API for organisation deletion in this release** (the `organization:delete` permission exists without a route). It requires a manual, reviewed database operation. There is also no user-account deletion path.

## Incident response

Find what happened first. Audit records carry the request id from the `x-request-id` response header, which also appears in `api_request` and `unhandled_error` log lines. Because clients can supply their own `x-request-id`, confirm with the timestamp and actor.

```bash
curl -G "$APP_URL/api/v1/audit" --data-urlencode "q=mailbox" --data-urlencode "from=2026-10-30T00:00:00Z" -H "Cookie: <session cookie>"
```

```sql
select created_at, actor_label, action, target_type, target_id, outcome, reason, metadata
  from audit_logs where request_id = '<request id>' order by created_at;
```

| Situation | Action |
|---|---|
| A customer webhook endpoint is compromised or misbehaving | Revoke the integration (Integrations page, or `POST /api/v1/integrations/{id}/revoke` with `status: "revoked"`). The signing secret is deleted; pending campaign actions and webhook notifications fail. Create a new integration to resume. |
| Automation is doing harm (unexpected pauses, runaway syncs) | Turn on the organisation kill switch (Settings, or `POST /api/v1/organization/automation` with `paused: true`). Queued scheduled syncs and scans are skipped when they run, and alerts stop requesting campaign pauses. Manual syncs and scans, user-requested campaign actions and other already-queued jobs (alert evaluations, notifications, campaign actions) still run; check Settings → Jobs. |
| One mailbox is misbehaving or its owner withdraws consent | Pause monitoring (`POST /api/v1/mailboxes/{id}/pause`) or disconnect it (deletes tokens; optionally its events). For Microsoft, the user must also remove consent at myapps.microsoft.com. |
| `TOKEN_ENCRYPTION_KEYS` may be exposed | Prepend a new key and deploy, run `npm run keys:rotate` (see [Encryption key rotation](#encryption-key-rotation)), then remove the old key. Re-encryption does not change the secrets themselves: treat mailbox tokens as exposed (disconnect affected mailboxes or revoke at the provider, then reconnect so new tokens are issued) and recreate integrations to rotate signing secrets. |
| `NEXTAUTH_SECRET` may be exposed, or all sessions must end | Replace `NEXTAUTH_SECRET` and redeploy all web instances. Every session becomes invalid. |
| One user's sessions must end | No UI or API exists. Increment their session version; their next request is treated as signed out. |
| One user must be locked out entirely | Disable their memberships (Settings → Members), or set the account status directly. |

```sql
update users set session_version = session_version + 1, updated_at = now() where lower(email) = lower('<email>');
```

```sql
update users set status = 'disabled', updated_at = now() where lower(email) = lower('<email>');
```

Run manual SQL changes through your change process and record them; they are not written to the audit log.

### Encryption key rotation

After prepending a new key to `TOKEN_ENCRYPTION_KEYS` and deploying web and worker, re-encrypt stored secrets with the new active key:

```bash
npm run keys:rotate
```

In the container image the same script runs as `npx tsx scripts/rotate-keys.ts`. Workers can keep running (updates are conditional, so a concurrent token refresh is never overwritten — re-run to pick up anything it skipped); check that the printed summary shows `remainingOnOldKeys: 0`, then remove the old key and deploy again. The full procedure and its caveats are in [security.md → Encryption of credentials at rest](security.md#encryption-of-credentials-at-rest).

## Known operational limitations

- No UI or API for: organisation deletion, user account deletion or disabling, ending a user's sessions, changing entitlements, or resetting the freshness settings from the UI (the API accepts `null` for `syncStaleAfterHours` and `scanStaleAfterDays` to restore the defaults).
- Metrics are per process and in memory; they reset on restart. No error tracker is wired to `reportError`.
- Configuration is validated lazily: a misconfigured production process starts, then fails on first use. The `config` check in `/api/ready` reports it; check `/api/ready` after every deploy.
- The scheduler handles at most 500 due mailboxes and 200 due domains per tick; larger backlogs drain over several ticks.
- Mailboxes are linked to their domain when the domain is added, or when they are connected or reconnected while the domain exists. Events ingested before the link keep `domain_id` empty, so domain filters on events do not include them.
- Some tables are not covered by retention (listed above).
- `docker-compose.yml` runs the production image; see [deployment.md](deployment.md#docker-compose) for the configuration it needs.
