# Decisions and assumptions

Architecture decision records for the QuikReach commercial MVP. Each entry states the decision, why it was made, and what would change it. Items marked **Needs owner** are product, security or commercial decisions that have a placeholder in code and must be confirmed by a named person before launch (see [launch-dependencies.md](launch-dependencies.md)).

## ADR-001 — Standalone repository that mirrors QuikIT conventions

**Decision.** QuikReach is a standalone Next.js app, not a package inside the QuikIT monorepo. It mirrors the QuikIT conventions observed in sibling apps (quikims): a `withOrgAuth` route guard, the `{ success, data } | { success: false, error }` envelope, `orgId` tenant scoping, NextAuth with an SSO-or-credentials split, a `manifest.ts`, lowercase file names, `catch (error: unknown)`, no `as any`, and the near-monochrome QuikIT design tokens with a dark navigation rail.

**Why.** The project owner chose a new standalone repository. The shared `@quikit/auth`, `@quikit/database`, `@quikit/shared` and `@quikit/ui` packages were not available here (quikims references them through a monorepo path that does not exist outside it), so they could not be imported.

**Consequence.** Moving into the monorepo means swapping local equivalents for `@quikit/*` packages, porting the schema (ADR-002), and approving the manifest and permissions with the QuikIT integration owner.

## ADR-002 — Drizzle ORM with SQL migrations (not Prisma)

**Decision.** PostgreSQL through Drizzle ORM. Migrations are generated SQL files in `db/migrations`, reviewed before commit.

**Why.** Tests run against real PostgreSQL semantics in-process (PGlite, Postgres compiled to WASM) with the same migrations, so there's no database service in CI. Drizzle supports node-postgres and PGlite with one schema. The migrations are plain SQL, so porting to Prisma (QuikIT's ORM) is mechanical.

**Would change if** the QuikIT integration owner requires Prisma inside the monorepo.

## ADR-003 — PostgreSQL-backed job queue instead of Redis/BullMQ

**Decision.** Background jobs live in `background_jobs`. Workers claim them with `FOR UPDATE SKIP LOCKED`. The queue provides bounded retries with exponential backoff, a `dead` (dead-letter) state, idempotency keys, stale-lock reclaim and visibility in Settings → Jobs.

**Why.**
- The brief requires a transactional outbox and a `BackgroundJob` model. Enqueuing in the same transaction as the domain change gives the outbox for free, with no "row committed, job lost" window.
- The workload is low-volume and correctness-sensitive.
- It removes Redis from the required infrastructure. No Redis was available in the build environment either.

**Would change if** job volume needs a dedicated broker. `JobQueue` in `lib/jobs/queue.ts` is the seam.

## ADR-004 — Authentication: QuikIT OIDC when configured, otherwise credentials

**Decision.** NextAuth v4 runs in one of two modes:
- **SSO mode:** sign-in through the QuikIT identity provider using standard OIDC discovery, enabled by `QUIKIT_URL`, `QUIKIT_CLIENT_ID` and `QUIKIT_CLIENT_SECRET`.
- **Credentials mode:** email and password, hashed with bcrypt at cost 12.

The session JWT only proves identity. Every request re-reads the user and membership from the database, so a disabled user or member, or a bumped `sessionVersion`, loses access immediately.

**Assumption.** The QuikIT IdP exposes standard OIDC. Its real contract (`@quikit/auth`) was not available. **Needs owner:** QuikIT integration owner to confirm.

**Not implemented:** email verification for self-serve signup (signup is disabled by default in production), password reset, MFA.

## ADR-005 — Least-privilege mailbox scopes

**Decision.**
- **Google:** `openid email https://www.googleapis.com/auth/gmail.metadata`, for headers and labels without bodies.
- **Microsoft:** `offline_access openid email User.Read Mail.ReadBasic`, which excludes bodies and attachments.

**Consequences.**
- `gmail.metadata` cannot use Gmail search (`q`), so sync pages through labels and history.
- Bounce hard/soft classification is header- and subject-based. The SMTP status lives in the bounce body, which QuikReach does not read. Capabilities report this as `partial`.
- Complaint visibility is limited to ARF reports delivered to the mailbox.
- `gmail.metadata` is a Google **restricted** scope, so external apps need Google verification and a security assessment (launch dependency).

## ADR-006 — Separate categorical health states, not a single score

**Decision.** Domain configuration, mailbox health and campaign safety are evaluated separately. Each uses the states healthy, at risk, critical, unknown or stale, expands into its inputs with evidence references, and lists missing data. There is no numeric "reputation score".

**Why.** The brief forbids presenting a QuikReach-derived score as provider reputation and requires unknown and stale data to stay distinct. A single number hides missing inputs.

**Needs owner:** the thresholds in `lib/health/evaluate.ts` and the starter alert-rule thresholds are QuikReach heuristics: bounce rate is at risk at 2% and critical at 5%, with a 20-send minimum sample.

## ADR-007 — Campaign protection through a customer-authorized signed webhook

**Decision.** QuikReach has no native integration with a sending platform. Campaign pause and resume run only through a customer-configured, signature-verified webhook. That integration becomes `active` only after a successful signed `ping`. An action counts as `confirmed` only when the receiver's response confirms the new state of that exact campaign. Without an active integration, rules record `no_campaign_integration`, and the UI states that QuikReach can alert but cannot pause.

**Separation of duties.** A campaign paused by a critical alert whose rule requires manual review can only be resumed by a role with `campaign:review`: Deliverability Manager, Administrator or Owner. Campaign Managers cannot resume it.

**Would change with** a QuikPilot integration, which would implement the same `CampaignExecutionProvider` contract (`lib/roadmap/contracts.ts`).

## ADR-008 — Demo data isolation

**Decision.**
- Demo data exists only in organizations flagged `is_demo`, created by `npm run db:seed:demo`.
- A database check constraint ties `provider = 'demo'` to `is_demo = true` on mailbox connections.
- The API rejects live-data operations (adding domains, connecting mailboxes, creating integrations) in demo workspaces.
- The scheduler skips demo organizations.
- A persistent banner marks every page of a demo workspace.
- Demo DNS checks carry `rule_version = demo-seed` and resolver `demo-seed (not a live DNS query)`.

## ADR-009 — Evidence-grounded diagnostics with server-side enforcement

**Decision.**
- The assistant receives only tenant-scoped evidence items, each with a `ref`. Output is schema-constrained (`output_config.format`).
- Server-side grounding (`lib/ai/grounding.ts`) downgrades any "confirmed" finding without valid refs to a low-confidence hypothesis, strips invented refs, and caps confidence when nothing is confirmed.
- The prompt treats evidence as untrusted data, because DNS TXT records are attacker-controllable.
- Without an AI key, a deterministic rules engine produces the same structure, clearly labelled.
- The model is `AI_MODEL`, default `claude-opus-5-5`. Server-side refusal fallback (`fallbacks: "default"`) is enabled.
- Recommendations are never executed.

## ADR-010 — Local PostgreSQL without Docker for development

**Decision.**
- **Local development:** `npm run db:local` runs real PostgreSQL binaries through the `embedded-postgres` dev dependency. Docker Compose is the alternative.
- **Tests:** PGlite.
- **Production:** managed PostgreSQL only.

`embedded-postgres` is a devDependency used only by `scripts/local-postgres.ts`; no application or worker code imports it, and it is never started in a deployed environment.

## Placeholders that need an owner

| Item | Current placeholder | Where |
|---|---|---|
| Event / diagnostic / audit retention defaults | 90 / 90 / 365 days | `.env.example`, `lib/env.ts` |
| Trial plan limits | 5 domains, 10 mailboxes, 10 members, 50 scans/day, 100 diagnoses/month, 100k events/month | `lib/usage/entitlements.ts` |
| Health thresholds | bounce at risk 2%, critical 5%, min 20 sends, 7-day window | `lib/health/evaluate.ts` |
| Starter alert rules | 5% / 10% bounce (min 50), complaints ≥1, provider errors ≥5, failing DNS, unhealthy connection, stale sync | `lib/alerts/starter-rules.ts` |
| Pricing, plans, billing | none implemented; limits are hard stops, never overage | — |
| Sync and scan cadence | sync every 15 min, scheduled scan every 24 h (verified domains only) | `.env.example` |
