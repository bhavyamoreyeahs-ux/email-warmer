# Launch dependencies

Implementation of the MVP is complete for the scope in the README. **QuikReach is not production-ready.** The items below are outside the codebase: credentials, approvals, reviews, decisions and validation. Each one must be closed by a named owner before a commercial launch.

Status key: **Open** = not started or unknown · **Blocked** = needs something external first.

## 1. Credentials and configuration

| Item | Status | Notes |
|---|---|---|
| Google Cloud OAuth client (Gmail API enabled) | Open | Without it, Google connections are disabled. Nothing is simulated. See [oauth-setup.md](oauth-setup.md). |
| Microsoft Entra app registration | Open | Without it, Microsoft connections are disabled. |
| Production `NEXTAUTH_SECRET`, `TOKEN_ENCRYPTION_KEYS`, `RECIPIENT_HASH_KEY`, `METRICS_TOKEN` from a secret manager | Open | A KMS-backed `KeyProvider` is not implemented. Keys come from environment variables. |
| QuikIT IdP client (`QUIKIT_URL` / client id / secret) and confirmation of the OIDC contract | Blocked | The `@quikit/auth` contract was not available. The OIDC provider configuration is an assumption (ADR-004). |
| SMTP for alert and invitation email | Open | Without it, email notifications are recorded as `not_configured`. Invitation links must be copied manually. |
| Anthropic API key, if AI diagnostics are wanted | Open | Without it, the deterministic rules engine is used and labelled as such. |
| Managed PostgreSQL with TLS, PITR backups and monitoring | Open | See [deployment.md](deployment.md). |

## 2. Provider approvals and policy

| Item | Status | Notes |
|---|---|---|
| Google OAuth app verification for the restricted scope `gmail.metadata` | Open | External (public) apps need Google verification and an annual third-party security assessment. Until then, use is limited to configured test users. |
| Google API Services User Data Policy / Limited Use review | Open | Data use must match the disclosed purpose. |
| Microsoft publisher verification; admin-consent guidance for customer tenants | Open | Some tenants block user consent. |
| Live validation of the Gmail and Graph adapters against real mailboxes | Open | Adapters are unit-tested with mocked HTTP only. The adapter author flagged these items for pilot verification: Graph `$filter` on delta and `conversationId`, whether `Mail.ReadBasic` returns `internetMessageHeaders`, Gmail `fields` syntax and list ordering, and Google sending-limit notice wording. |
| Bounce, reply and complaint classification accuracy on real traffic | Open | Classification is header- and subject-heuristic, with confidence recorded. It needs measurement during the pilot. |

## 3. Security and privacy

| Item | Status | Notes |
|---|---|---|
| Independent security review / penetration test | Open | Scope: tenant isolation, OAuth flows, webhook SSRF, CSV export, session handling. |
| Privacy review (data inventory, DPIA where applicable) | Open | Stored data: message metadata derivatives, recipient domains and keyed hashes, DNS results, audit logs. |
| Email verification for self-serve signup, password reset, MFA | Open | Not implemented. Signup is disabled by default in production. |
| Session revocation ("sign out everywhere") and platform-level account disable UI/API | Open | Possible today only via `users.session_version` / `users.status` in SQL; membership disable per org exists. |
| Reverse proxy must overwrite `X-Forwarded-For` | Open | Per-IP rate limits and audit IP hashes trust the first value. |
| PostgreSQL row-level security as defense in depth | Open | Isolation is currently enforced in application code and by composite foreign keys. |
| Org deletion / data export workflow (customer offboarding) | Open | Database cascades exist, but there is no UI or API for organization deletion or full export. |
| Rate limits behind a CDN/WAF; bot protection on signup | Open | App-level Postgres rate limits only. |

## 4. Legal and commercial

| Item | Status | Notes |
|---|---|---|
| Terms of service, privacy policy, DPA / subprocessor list | Open | QuikReach makes no compliance claims. |
| Retention periods (events, diagnostics, audit) | Open | Defaults 90 / 90 / 365 days are placeholders. |
| Plans, pricing, entitlements, billing integration | Open | Limits are placeholders and hard stops. No billing exists. |
| Data residency requirements | Open | — |

## 5. Product decisions that need an owner

- Health and alert thresholds (see the [decisions.md](decisions.md) placeholder table).
- Whether to build a native integration with a specific sending platform, or QuikPilot first. Today only the signed webhook exists.
- Gmail push (Pub/Sub `watch`) versus polling cadence. Polling every 15 minutes today.
- Warm-up, inbox-placement testing and opt-in network scope (deferred). See [roadmap-contracts.md](roadmap-contracts.md).

## 6. Validation before production

| Step | Status |
|---|---|
| Pilot with real Google Workspace and Microsoft 365 mailboxes (consenting customers) | Open |
| Load test: event ingestion and alert evaluation at expected tenant volume | Open |
| Restore drill from backup, including encryption-key recovery | Open |
| Accessibility audit (WCAG 2.2 AA) with assistive technology | Open — semantic HTML, labels and keyboard support were built in but not audited |
| Production deployment and monitoring/alerting on `/api/ready`, worker `/healthz` and dead-letter counts | Open |
