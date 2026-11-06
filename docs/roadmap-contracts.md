# Deferred features: interfaces and open questions

These features are **not implemented**. The app shows them only as "Not available in this release" on the Roadmap and Integrations pages. Typed contracts live in `lib/roadmap/contracts.ts`, so future work fits the existing architecture: tenant scoping, the job queue, evidence references and the audit log.

## Authorized inbox-placement tests

- **Contract:** `SeedMailbox`, `PlacementTestRun`, `InboxPlacementTester`.
- **Planned tables:**
  - `seed_mailboxes`: org-scoped, with an authorization record.
  - `placement_test_runs` and `placement_test_results`: per-seed observation, timestamp and evidence ref.
- **Usage metering:** already in place. The ledger has an `inbox_test` metric, and the usage page shows it as unavailable.
- **Rules:**
  - Only mailboxes the customer controls and has authorized can be seeds.
  - A result describes that seed only. It is never extrapolated to "X% inbox placement".
  - Nothing is shown until a genuine implementation exists.

## Controlled warm-up scheduler

- **Contract:** `WarmupPlan`, `WarmupScheduler`.
- **Rules:**
  - QuikReach proposes daily volume caps and guardrails. The customer's sending tool sends.
  - No automated engagement exchanges.
  - No fabricated opens or replies.
  - Guardrails reuse the alert metrics (bounce rate, complaints) and can request a hold through the campaign integration.

## Opt-in network

- **Contract:** `NetworkParticipation`.
- **Rules:** only aggregated, anonymized benchmarks (for example, bounce-rate distributions and DNS configuration patterns), with explicit opt-in and versioned terms. It is never a message-exchange network.

## QuikPilot and QuikCRM

- **QuikPilot** would implement `CampaignExecutionProvider`. That is the same contract as the signed campaign webhook: confirmed state only, idempotency keys, and manual review after critical pauses.
- **QuikCRM** would receive domain health through `CrmHealthPublisher`. This would be a read-only push of state, rule version and timestamp.
- **Placeholders:** `integrations.kind` already accepts `quikpilot` and `quikcrm`. Neither can be created through the API yet.

## Questions to answer before building

1. Seed-mailbox sourcing and consent terms; which providers' placement can be observed legitimately.
2. Warm-up: which sending platforms expose volume controls? Is a cap advisory, or enforced through an integration?
3. Network: legal basis and anonymization standard for shared benchmarks.
4. QuikPilot: authentication between QuikIT apps (service tokens versus user-delegated access).
