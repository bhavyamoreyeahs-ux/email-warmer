# QuikReach

Email-domain health, mailbox monitoring, deliverability diagnostics and campaign safety for B2B sales teams, outbound agencies, SMBs and IT services companies. QuikReach is part of the QuikIT ecosystem.

QuikReach shows what your sending domains and connected mailboxes **actually tell you**: DNS authentication evidence, provider-observable mailbox signals, alerts with evidence, and grounded diagnostics. It keeps observed facts, estimates, hypotheses and recommendations apart. It does **not** promise inbox placement, reputation improvement or campaign performance.

> **Status:** commercial MVP, implementation complete and running locally. **Not production-ready.** Provider credentials and approvals, security, privacy and legal reviews, a pilot and production deployment are still outstanding. See [docs/launch-dependencies.md](docs/launch-dependencies.md).

## What's implemented

| Area | What works |
|---|---|
| **Tenancy & roles** | Multi-tenant organizations, memberships, invitations (hashed single-use tokens), disable/remove members, and five roles: Owner, Administrator, Deliverability Manager, Campaign Manager, Read-only Analyst. Permissions are enforced server-side on every request ([docs/permissions.md](docs/permissions.md)). |
| **Authentication** | NextAuth: QuikIT OIDC when configured, otherwise email + password. The database is re-checked on every request, so disabled users and members lose access immediately. |
| **Domains & DNS** | Ownership verification via a `_quikreach.<domain>` TXT record. MX, SPF (lookup limit, void lookups, duplicates, `+all` / `?all`, recursion), DKIM (selector-aware; no selector means **inconclusive**) and DMARC (policy, `pct`, `rua` / `ruf`, external report authorization, alignment). Each check records evidence: every DNS query, its answers and outcome, the resolver, the rule version and the timestamp. Scan history and before/after comparison are included. QuikReach never edits DNS. |
| **Mailboxes** | Google Workspace / Gmail and Microsoft 365 / Outlook connect through OAuth with PKCE, using least-privilege metadata scopes and never passwords. Tokens are encrypted with AES-256-GCM and versioned keys. Capability validation reports each signal as available, partial, unavailable or unknown. Refresh failures, revocation, quota limits and outages are handled with bounded retries, backoff and a reconnect flow; disconnect revokes and deletes tokens. |
| **Events** | Idempotent ingestion of normalized signals: sent (provider-recorded), hard / soft / unclassified bounce, complaint (ARF), unsubscribe request, reply, auto-reply, provider error, sending-limit notice and unknown. Each event records its source, timestamp, confidence and classification basis. No bodies or subjects are stored; recipients are reduced to a domain plus a keyed hash. |
| **Health** | Separate, explainable domain-configuration, mailbox-health and campaign-safety states. Each expands into its inputs and missing data, with freshness and rule versions. Stale or unknown data is never shown as healthy. |
| **Alerts & campaign safety** | Configurable rules with minimum-sample safeguards, severity, notification targets, cooldown, dedupe, evidence, dry-run testing and an audit trail. Monitor-only by default. Pause/resume works **only** through a customer-authorized, signed campaign webhook, is marked confirmed only when the receiver confirms it, and needs manual review before resuming after a critical pause. |
| **AI diagnostics** | Tenant-scoped evidence and schema-constrained output (Claude, default `claude-opus-5-5`). Server-side grounding enforcement separates confirmed findings, hypotheses and recommendations, with confidence and a list of what can't be determined. A deterministic rules engine runs when no AI key is configured. Diagnostics never execute actions. |
| **Reports & usage** | Time-filtered summaries with coverage. CSV exports honor the active filters, tenant scope and role, are formula-injection safe and are audited. A usage ledger and entitlements apply hard stops with no overbilling. |
| **Integrations** | Signed campaign-control and notification webhooks, protected against SSRF; mailbox provider status. QuikCRM and QuikPilot appear only as "not available". |
| **Ops** | Structured redacted logs, Prometheus metrics, `/api/health`, `/api/ready`, worker `/healthz`, a Postgres-backed durable job queue with a dead-letter state, a retention purge, a per-org automation kill switch, a versioned API with OpenAPI at `/api/v1/openapi.json`, a Dockerfile, Compose and CI. |

**Deferred (not built, not shown as working):** warm-up network or exchanges, inbox-placement testing, automatic DNS changes, CRM features, and QuikReach-operated campaign sending. Interfaces for the future versions are in [docs/roadmap-contracts.md](docs/roadmap-contracts.md).

## Architecture

A modular monolith: a Next.js 15 App Router web app and a Node worker share one PostgreSQL database.

```
Browser ──► Next.js (app/, app/api/v1/*) ──► withOrgAuth ──► lib/<module>/service ──► PostgreSQL
                                                                     │  enqueue in same tx
                                                                     ▼
                                              Worker (scripts/worker.ts) ◄── background_jobs (SKIP LOCKED)
                                                 ├─ domain.scan     → lib/dns (bounded-timeout resolver)
                                                 ├─ mailbox.sync    → Gmail API / Microsoft Graph adapters
                                                 ├─ alerts.evaluate → notifications, campaign actions
                                                 └─ health.compute, notification.deliver, retention.purge
```

| Module | Location |
|---|---|
| Identity & tenancy | `lib/auth`, `lib/api`, `lib/tenancy`, `lib/rbac.ts` |
| Domains / DNS | `lib/domains`, `lib/dns` |
| Mailbox connections | `lib/mailboxes` (`providers/` = Gmail + Graph adapters) |
| Event ingestion & search | `lib/events` |
| Health evaluation | `lib/health` |
| Alerts | `lib/alerts`, `lib/notify` |
| Campaign safety & integrations | `lib/campaigns`, `lib/integrations` |
| AI diagnostics | `lib/ai` |
| Reports & usage | `lib/reports`, `lib/usage` |
| Audit | `lib/audit.ts` |
| Jobs & retention | `lib/jobs`, `lib/retention` |
| Observability | `lib/observability` |

More: [architecture](docs/architecture.md) · [decisions](docs/decisions.md) · [security](docs/security.md) · [health model](docs/health-model.md) · [API](docs/api.md) · [integrations](docs/integrations.md).

## Run it locally

Requirements: Node 22+. PostgreSQL comes from either the bundled embedded server (no Docker needed) or Docker Compose.

1. Install dependencies.

```bash
npm install
```

2. Start PostgreSQL. Without Docker, this runs a real Postgres on port 54329 with its data in `./.data`; leave it running in its own terminal.

```bash
npm run db:local
```

Or with Docker:

```bash
docker compose up -d db
```

3. Create `.env` from the template, then fill in `NEXTAUTH_SECRET`, `TOKEN_ENCRYPTION_KEYS` and `RECIPIENT_HASH_KEY` (generation commands are in the comments). If you used Docker, change `DATABASE_URL` to port 5432.

```bash
cp .env.example .env
```

4. Apply migrations.

```bash
npm run db:migrate
```

5. Optional: create the isolated **DEMO** workspace (sample data only, clearly labelled). The script prints the demo login.

```bash
npm run db:seed:demo
```

6. Start the web app at http://localhost:3020.

```bash
npm run dev
```

7. In another terminal, start the worker. It runs scans, syncs, alerts, notifications and retention.

```bash
npm run worker
```

Sign up at `/signup` to create a real workspace, or sign in with the demo account. To connect real mailboxes, configure OAuth apps first ([docs/oauth-setup.md](docs/oauth-setup.md)). Until then, the connect buttons are disabled and say why.

### Checks

```bash
npm run typecheck
```

```bash
npm run lint
```

Tests use in-memory PGlite (real PostgreSQL in WASM), so no database is needed.

```bash
npm test
```

```bash
npm run build
```

Operations (worker monitoring, metrics, backup/restore, retention, incident response): [docs/operations.md](docs/operations.md). Deployment baseline: [docs/deployment.md](docs/deployment.md). On Vercel, background jobs run through a per-minute Vercel Cron instead of `npm run worker` (see the Vercel section there).

## Integrations: live vs. pending

| Integration | State in this build |
|---|---|
| DNS checks | **Live.** Real resolvers with bounded timeouts. |
| Google Workspace / Gmail | **Code complete, awaiting credentials and Google verification.** Unit-tested with mocked HTTP only. |
| Microsoft 365 / Outlook | **Code complete, awaiting app registration.** Unit-tested with mocked HTTP only. |
| Campaign control | **Signed webhook implemented and tested.** No native sending-platform integration. |
| Email notifications | **Implemented; requires SMTP configuration.** Recorded as "not configured" otherwise. |
| AI diagnostics | **Implemented; requires an Anthropic API key.** The rules engine is used otherwise. |
| QuikIT SSO | **OIDC provider configured by assumption.** Needs the QuikIT contract and credentials. |
| QuikCRM / QuikPilot | **Not implemented.** Shown as "not available". |

## Product language rules (enforced in UI and code)

- A provider "sent" record is not proof of delivery. Inbox placement is never claimed.
- Missing, stale, unsupported or inconclusive signals show as unknown or unavailable, never zero or healthy.
- QuikReach health states are QuikReach heuristics, not provider reputation scores.
- A campaign is shown as paused only when the sending system confirms it.
- Demo data lives only in demo workspaces, behind a persistent banner.

## Project layout

```
app/                 Next.js routes: (app)/ product pages, api/v1/ versioned API, auth pages
components/          UI kit (ui/), app shell, page-specific client components
lib/                 Server modules (see table above); db/schema.ts is the data model
db/migrations/       Generated, reviewed SQL migrations
scripts/             worker, migrate, seed-demo, retention-purge, local-postgres
__tests__/           unit/ (DNS, providers, RBAC, crypto, grounding, OpenAPI) and integration/ (PGlite)
docs/                Architecture, decisions, security, operations, deployment, launch dependencies
manifest.ts          QuikIT app manifest
```
