# Deployment

QuikIT's hosting environment details (platform, orchestrator, network layout, secret manager) were not available when this was written. This page is a practical baseline that matches what the code expects; adapt it to the target platform. It does not describe a reviewed or production-ready deployment; see [security.md → Reviews required before launch](security.md#reviews-required-before-launch).

## Components

| Component | Runs | Scaling |
|---|---|---|
| Web | Next.js standalone server (`node server.js`) | Stateless; any number of instances behind a load balancer |
| Worker | `npx tsx scripts/worker.ts` | One or more instances |
| Migrations | `npx tsx scripts/migrate.ts` | One-off job per release |
| PostgreSQL | Managed service, 15 or later | Single primary |

Outbound network access needed: PostgreSQL; `accounts.google.com`, `oauth2.googleapis.com`, `openidconnect.googleapis.com`, `gmail.googleapis.com`; `login.microsoftonline.com`, `graph.microsoft.com`; DNS resolvers (`DNS_RESOLVERS` or the system resolver); customer webhook endpoints (arbitrary public HTTPS hosts); the SMTP server if `SMTP_URL` is set; the Anthropic API if `AI_PROVIDER=anthropic`; the QuikIT IdP in SSO mode.

## Container image

The `Dockerfile` builds one image for all three roles:

- `deps` stage: `npm ci` (all dependencies, used only for the build).
- `prod-deps` stage: `npm ci --omit=dev` (production dependencies only).
- `build` stage: `npm run build` (Next.js `output: "standalone"`).
- `runtime` stage: `node:22-bookworm-slim`, `NODE_ENV=production`, `HOSTNAME=0.0.0.0`, `PORT=3000`, non-root user `app`. Contains the standalone server and static assets, the production `node_modules` from `prod-deps`, and `lib/`, `scripts/`, `db/` and `tsconfig.json` so the worker, migrations and scripts can run TypeScript through `tsx` (a runtime dependency). Exposes 3000 (web) and 9464 (worker health/metrics).

Build:

```bash
docker build -t quikreach:<version> .
```

Run each role from the same image with a different command:

| Role | Command | Listens on |
|---|---|---|
| Web | `node server.js` (image default) | `PORT` (default 3000) |
| Worker | `npx tsx scripts/worker.ts` | `WORKER_HEALTH_PORT` (default 9464) |
| Migrations | `npx tsx scripts/migrate.ts` | — (exits when done) |
| Retention purge (manual) | `npx tsx scripts/retention-purge.ts` | — (exits when done) |
| Key re-encryption (manual) | `npx tsx scripts/rotate-keys.ts` | — (exits when done) |

Notes:

- The Next.js standalone server binds to `HOSTNAME`; the image sets it to `0.0.0.0` so in-container health checks against `localhost` work. Do not override it with the container name.
- `npm start` (`next start -p 3020`) is for local use, not for the image.
- Development tooling (`embedded-postgres`, test and lint tools, `drizzle-kit`) is not in the runtime image. `npm run db:generate` therefore does not work inside it; generate migrations in a development checkout.
- The image contains no secrets: `.env` files are excluded by `.dockerignore`, as are `.next`, `.next-build` and `.data`.

## Rollout order

1. Build and push the image.
2. Run migrations as a one-off job with the new image and production environment, and wait for it to succeed:

   ```bash
   docker run --rm --env-file /path/to/prod.env quikreach:<version> npx tsx scripts/migrate.ts
   ```

3. Roll out web instances, then workers.
4. Check `GET /api/ready` returns `ready`. Configuration is validated on first use, so its `config` check is the first point where a missing or invalid variable shows up.

During a rolling deploy, old and new code run against the migrated schema at the same time. Write migrations to be backward compatible with the previous release (add columns and tables first, remove them in a later release).

## PostgreSQL

- PostgreSQL 15 or later (`docker-compose.yml` and the embedded development server use 17). The schema uses `gen_random_uuid()`, partial unique indexes and `CHECK` constraints; no extensions are required.
- Use a managed service with automated backups and point-in-time recovery. See [operations.md → Backup and restore](operations.md#backup-and-restore).
- Set `DATABASE_SSL=true`. The client then requires TLS and verifies the server certificate (`rejectUnauthorized: true`). If the provider's certificate chains to a CA that Node does not trust by default, provide it with `NODE_EXTRA_CA_CERTS`.
- Each web and worker process opens its own pool of up to `DATABASE_POOL_MAX` connections (default 10). Size the server's connection limit for `(web instances + worker instances) × DATABASE_POOL_MAX`, plus migrations and administration. Every statement has a 30-second `statement_timeout`.
- The application user needs DDL rights for migrations. If the platform separates roles, run migrations with an owner role and the app with a role limited to DML on the `public` schema plus read access to `drizzle.__drizzle_migrations` (used by `/api/ready`).

## TLS, proxy and HSTS

- Terminate TLS at a load balancer or reverse proxy and forward plain HTTP to the web containers on a private network.
- Set `APP_URL` (and `NEXTAUTH_URL`, to the same value) to the public `https://` URL. Production refuses an `http://` `APP_URL`. `APP_URL` is used for OAuth redirect URIs, links in emails, the same-origin check on mutations, and the `Secure` cookie decision.
- The proxy must set or overwrite `X-Forwarded-For` with the real client IP. QuikReach takes the first value for per-IP rate limits (signup, invitation acceptance) and audit IP hashes; a proxy that appends to a client-supplied header lets clients choose their own IP.
- Production builds send `Strict-Transport-Security: max-age=63072000; includeSubDomains` on every response. Browsers only honour it over HTTPS. `includeSubDomains` applies to every subdomain of the host that serves QuikReach; confirm that is acceptable for the chosen hostname before launch.
- Do not expose the worker's port 9464 publicly. `/metrics` requires the bearer token, but `/healthz` does not.

## Scaling

- **Web** is stateless: sessions are JWT cookies, rate limits are in PostgreSQL, and nothing is kept in process memory except metrics counters. Add instances freely.
- **Workers** can run as several instances. Claims use `FOR UPDATE SKIP LOCKED`, so two workers never run the same job at the same time. Every worker runs the scheduler tick; enqueues use idempotency keys, so concurrent ticks do not create duplicate queued jobs (a periodic job can occasionally run twice in one period; handlers are idempotent). Throughput per worker is `WORKER_CONCURRENCY`.
- Each additional instance adds a database connection pool; watch the connection limit before the CPU.

## Environment variables

Every variable is documented in `.env.example` and validated by `lib/env.ts`.

### Required in production

`lib/env.ts` throws on first use when `NODE_ENV=production` and any of these is missing or invalid:

| Variable | Requirement |
|---|---|
| `DATABASE_URL` | Set |
| `NEXTAUTH_SECRET` | Set (at least 32 random bytes recommended) |
| `TOKEN_ENCRYPTION_KEYS` | Set; `keyId:base64(32 bytes)` entries, first one encrypts |
| `RECIPIENT_HASH_KEY` | Set |
| `APP_URL` | Starts with `https://` |
| `ALLOW_PRIVATE_WEBHOOK_TARGETS` | Not enabled |

### Strongly recommended in production

| Variable | Why |
|---|---|
| `NEXTAUTH_URL` | NextAuth reads it directly; keep it identical to `APP_URL` |
| `DATABASE_SSL=true` | TLS to the database |
| `METRICS_TOKEN` | Without it both metrics endpoints always return 401 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT` | Without them the provider is shown as not configured; see [oauth-setup.md](oauth-setup.md) |
| `QUIKIT_URL` (or `QUIKIT_ISSUER_URL`), `QUIKIT_CLIENT_ID`, `QUIKIT_CLIENT_SECRET` | QuikIT SSO; otherwise the app uses local email + password accounts |
| `ALLOW_SELF_SIGNUP` | Defaults to false in production; leave it unset or false unless self-serve signup is intended (no email verification exists) |
| `SMTP_URL`, `EMAIL_FROM` | Alert and invitation emails; without them email notifications are recorded as `not_configured` |
| `AI_PROVIDER`, `ANTHROPIC_API_KEY`, `AI_MODEL`, `AI_TIMEOUT_MS` | AI diagnostics; default `none` uses the rules engine only |
| `DEFAULT_*_RETENTION_DAYS` | Placeholders; set approved values |
| `LOG_LEVEL` | Default `info` |

`ALLOW_PRIVATE_WEBHOOK_TARGETS=true` is for local development only; `lib/env.ts` refuses it in production (see the table above).

### Secret injection

Inject secrets from the platform secret manager as environment variables at runtime: `DATABASE_URL`, `NEXTAUTH_SECRET`, `TOKEN_ENCRYPTION_KEYS`, `RECIPIENT_HASH_KEY`, the OAuth client secrets, `ANTHROPIC_API_KEY`, `SMTP_URL`, `METRICS_TOKEN`. Web and worker must receive the same `TOKEN_ENCRYPTION_KEYS` and `RECIPIENT_HASH_KEY`. Do not bake them into the image or commit them. A KMS-backed key provider is not implemented; the keys are read from the environment.

## Health checks for orchestrators

| Container | Liveness | Readiness |
|---|---|---|
| Web | `GET /api/health` (200 while the process serves) | `GET /api/ready`: 200 for `ready` and `degraded`, 503 for `unavailable` (the `config`, `database` or `migrations` check failed; the body says which) |
| Worker | `GET :9464/healthz` (200 when the loop is running and heartbeated in the last 60 s, else 503) | Same as liveness |

Give the worker a termination grace period of at least 30 seconds (it waits up to 25 seconds for in-flight jobs on `SIGTERM`). Alert on `/api/ready` reporting `degraded` for more than a few minutes: it means no worker has heartbeated in 90 seconds.

## Docker Compose

`docker-compose.yml` defines `db` (PostgreSQL 17 with a fixed development password), `migrate`, `web` (host port 3020 → container 3000) and `worker`, all built from the `Dockerfile`. It is a **local or pilot topology only**: no TLS, no backups, a hard-coded database password, a single database container, and the database port published on the host.

The `migrate`, `web` and `worker` services run the production image, so `NODE_ENV=production` applies and `lib/env.ts` enforces the production checks; the file's header comment says the same. With the values copied from `.env.example` (`APP_URL=http://localhost:3020`, empty secrets) those processes fail on first use. To run the full stack in Compose you need a production-grade `.env`: an `https://` `APP_URL` served through a TLS-terminating proxy in front of `web`, plus all four required secrets. For day-to-day development run only the database (`docker compose up -d db`) with `npm run dev` and `npm run worker` ([operations.md](operations.md#local-setup)).

## Vercel (serverless) deployment

QuikReach also runs on Vercel, with these differences from the container baseline:

| Concern | On Vercel |
|---|---|
| Web app | Built and served by Vercel (`next build`); TLS and HSTS handled by the platform. |
| Background jobs | No always-on worker. Three triggers run `runWorkerBatch` (scheduler tick + due jobs, bounded time): **(1)** user-triggered work (add domain, re-scan, sync now, mailbox connect, campaign actions) starts a ~40 s pass right after the response via Next.js `after()` (`lib/jobs/kick.ts`; on when `VERCEL=1`, override with `INLINE_JOB_KICK`); **(2)** `.github/workflows/worker-trigger.yml` calls `GET /api/cron/worker` every 30 minutes (needs the `CRON_SECRET` secret and `QUIKREACH_APP_URL` variable in the GitHub repo; each private-repo run bills ≥ 1 Actions minute); **(3)** Vercel Cron calls the same endpoint daily at 03:00 UTC (Hobby allows daily crons only — on Pro, change `vercel.json` to `* * * * *` and drop the workflow). Jobs cut off by a function time limit are reclaimed after the 10-minute stale-lock timeout and retried. |
| Cron security | Set `CRON_SECRET`; Vercel Cron sends it as `Authorization: Bearer …` and the GitHub workflow does the same. Without it the endpoint returns 503 and never runs. |
| Readiness | Each batch writes a heartbeat (`vercel-cron` / `inline-kick`). Between triggers `/api/ready` reports `degraded` (no heartbeat in the last 90 s) — expected on serverless; pages keep working. |
| Database | Managed Postgres (e.g. Neon via the Vercel Marketplace). Use the **pooled** URL as `DATABASE_URL` with `DATABASE_POOL_MAX=3`, and the **unpooled** URL for migrations. |
| Migrations | Run from a trusted machine before each deploy that adds a migration: `DATABASE_URL=<unpooled url> npm run db:migrate`. |
| First owner | Self-signup is off in production. Create the workspace and a one-time owner invite: `npm run bootstrap:owner -- --org "Name" --email owner@example.com` (with production `DATABASE_URL` and `APP_URL`). |
| OAuth redirect URIs | Add `https://<your-domain>/api/v1/mailboxes/oauth/callback/microsoft` (and `/google`) to the provider app registrations. |

Required production variables are the same as above (`APP_URL`/`NEXTAUTH_URL` = the https Vercel or custom domain, `NEXTAUTH_SECRET`, `TOKEN_ENCRYPTION_KEYS`, `RECIPIENT_HASH_KEY`, `DATABASE_URL`), plus `CRON_SECRET`. Never set `ALLOW_PRIVATE_WEBHOOK_TARGETS` (startup refuses it in production).

## Integrating into the QuikIT monorepo later

QuikReach was built as a standalone repository that mirrors QuikIT conventions ([ADR-001 and ADR-002 in decisions.md](decisions.md)). Points to resolve when it moves into the monorepo:

- **App manifest.** `manifest.ts` declares `appId: "quikreach"`, `routePrefix: "/reach"`, the navigation entries and an empty `permissions` array. The QuikIT permission strings must be agreed with the integration owner. The app does not currently set a Next.js `basePath`; mounting it under `/reach` changes every URL, including the OAuth redirect URIs registered with Google and Microsoft and `APP_URL`.
- **`@quikit/*` packages.** None were available to this build. Authentication uses a generic OIDC provider (`lib/auth/options.ts`) that assumes standard discovery; replace or confirm it against `@quikit/auth`. UI primitives in `components/ui/` would be replaced by the shared design system.
- **Prisma vs Drizzle.** QuikReach uses Drizzle with SQL migrations. Porting to Prisma means translating `lib/db/schema.ts`, including composite foreign keys `(org_id, id)`, partial unique indexes (`background_jobs_idem_uq`, `alerts_open_dedupe_uq`, `domains_verified_name_uq`), expression indexes (`lower(email)`) and `CHECK` constraints, and re-checking the raw SQL in the job queue, rate limiter, retention and reports. Keeping Drizzle for this app is the lower-risk option.
- **`withOrgAuth` contract parity.** QuikReach's guard mirrors QuikIT's: the `{ success: true, data }` / `{ success: false, error, code, details? }` envelope, 401 for no session, 403 for no membership or missing permission, 404 for other tenants' records, and a `permission` option per route. Confirm status codes, error codes, the organisation-selection mechanism (`qr_org` cookie here) and session shape against the QuikIT implementation before swapping guards.
- **Users and organisations.** QuikReach has its own `users`, `organizations` and `memberships` tables. In the monorepo these may map to QuikIT's shared tenancy model; plan the data migration and the meaning of `users.session_version`.
