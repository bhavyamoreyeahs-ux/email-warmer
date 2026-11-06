# Health model

QuikReach reports three separate health states and never blends them into one score ([ADR-006 in decisions.md](decisions.md)):

1. **Domain configuration**: the latest DNS authentication checks for a domain, and how fresh they are.
2. **Mailbox health**: connection state, data freshness and observed event rates for one connected mailbox.
3. **Campaign safety**: open alerts, monitoring coverage and whether campaign controls exist, for the whole organisation.

These are QuikReach's own heuristics, versioned in code. They are **not** a mailbox provider's reputation score, they do not predict inbox placement, and the thresholds below are QuikReach defaults, not provider guarantees.

Code: `lib/health/evaluate.ts` (rules and thresholds), `lib/health/service.ts` (inputs and snapshots), `lib/alerts/evaluate.ts` (alert metrics).

## States and how they combine

| State | Meaning |
|---|---|
| `healthy` | Inputs observed and within thresholds |
| `at_risk` | A warning-level problem was observed |
| `critical` | A failure-level problem was observed |
| `stale` | Data exists but is older than the freshness threshold |
| `unknown` | The data needed to judge is missing, inconclusive or not measurable |

Each state is the worst of its inputs, in this order: **`critical` > `at_risk` > `stale` > `unknown` > `healthy`**. A state with no inputs is `unknown`. Missing or stale data never produces `healthy`: if every observed input is fine but one is unknown, the result is `unknown`.

Every evaluation returns its inputs (key, label, state, detail, observation time, evidence references) and a `missing` list in plain language, so the UI can show why a state is what it is. An input flagged `informational` is context only: the UI shows it with an "Info" label and it is **excluded** from the combined state. Two inputs use this flag today: `mailbox.complaints` when no complaints were observed, and `safety.controls`.

Rule version: `HEALTH_RULE_VERSION = "health-2026.10.1"`, stored on every snapshot.

## Domain configuration

Inputs, for the domain's latest **completed** scan:

| Input key | Source | State mapping |
|---|---|---|
| `dns.mx`, `dns.spf`, `dns.dkim`, `dns.dmarc` | The check of that type in the latest completed scan | `pass` → healthy, `warn` → at_risk, `fail` → critical, `inconclusive` → unknown (and added to `missing`). No check yet → unknown (and added to `missing`). |
| `dns.freshness` | `domains.last_scan_at` | `stale` if never scanned or older than the organisation's `scanStaleAfterDays` setting (default **7 days**); otherwise healthy |

An unverified domain adds a `missing` entry ("scheduled monitoring and alerts are limited") but does not change the state by itself. Scheduled rescans only run for verified domains with monitoring enabled.

A DNS check is `inconclusive` when the answer could not be determined (timeout, resolver failure, check exceeding its 12-second budget, unexpected error). It is never reported as pass or fail. Each check stores its own rule version: `mx-2026.10.1`, `spf-2026.10.1`, `dkim-2026.10.1`, `dmarc-2026.10.1` (`demo-seed` for seeded demo data).

## Mailbox health

Evaluated for every connection that is not `disconnected`. Event counts cover the last **7 days** (`MAILBOX_THRESHOLDS.windowDays`) up to now.

```ts
MAILBOX_THRESHOLDS = { minSentForRate: 20, bounceRateAtRisk: 0.02, bounceRateCritical: 0.05, windowDays: 7 }
```

| Input key | Source | State mapping |
|---|---|---|
| `mailbox.connection` | `mailbox_connections.state` | `connected` → healthy; `degraded` → at_risk; `reauth_required` → critical; `pending`, `paused`, `disconnected` → unknown; `demo` → healthy (labelled as demo) |
| `mailbox.freshness` | `last_successful_sync_at` | healthy if within the organisation's `syncStaleAfterHours` setting (default **2 hours**), or if the connection is a demo; otherwise `stale` (and added to `missing`) |
| `mailbox.bounce_rate` | 7-day counts | **unknown** if the `sent_volume` or `bounce_detection` capability is `unavailable`. **unknown** if fewer than **20** sent messages were observed (insufficient sample). Otherwise rate = (`hard_bounce` + `soft_bounce` + `bounce_unclassified`) ÷ `sent`: ≥ **0.05** → critical, ≥ **0.02** → at_risk, else healthy. |
| `mailbox.provider_errors` | 7-day `provider_error` + `sending_limit` | > 0 → at_risk; 0 and data fresh → healthy; 0 and data not fresh → unknown |
| `mailbox.complaints` | 7-day `complaint` | > 0 → at_risk; 0 → unknown and flagged `informational`, because mailbox APIs only see feedback reports delivered to that mailbox. Being informational, it is excluded from the combined state, so it does not on its own make every mailbox unknown. |

The `missing` list always includes "Inbox placement: not measured".

`sent` is the number of outbound messages the provider recorded (Gmail SENT label, Microsoft Sent Items). It is not proof that a message reached an inbox. Bounce counts are bounce notifications observed in that mailbox only.

## Campaign safety

One state per organisation.

| Input key | Source | State mapping |
|---|---|---|
| `safety.alerts` | Alerts with status `open` or `acknowledged` | Any `critical` → critical; else any `warning` → at_risk; else healthy. `info` alerts do not count. |
| `safety.coverage` | Mailboxes that are not `disconnected` and not `paused` (demo, pending and reauth-required connections are included) | No such mailboxes → unknown (and "Connect a mailbox" added to `missing`); all with fresh data (`mailbox.freshness` healthy) → healthy; none fresh → stale; some fresh → at_risk |
| `safety.controls` | Active `campaign_webhook` integration | Informational (state `unknown`, shown as Info) and excluded from the combined state. The detail says whether QuikReach can request pauses or is monitor-only. |

## When health is computed

- `GET /api/v1/health` and the dashboard compute it live on each request.
- The `health.compute` job stores snapshots in `health_snapshots` for every domain, every non-disconnected mailbox and the campaign-safety state: hourly per organisation from the scheduler, and 5 seconds after each completed DNS scan. Snapshots are kept for the event-retention period and drive trend charts.

## Alert metrics

Alert rules (`alert_rules`) are evaluated by the `alerts.evaluate` job every 5 minutes per organisation, after scans, and after syncs that create events. The window is `window_minutes` back from evaluation time. Comparators are `gt` (>) or `gte` (≥) against `threshold`.

| Metric | Evaluated per | Observed value | Notes |
|---|---|---|---|
| `bounce_rate` | Mailbox (organisation or mailbox scope) or the domain's mailboxes combined (domain scope) | (`hard_bounce` + `soft_bounce` + `bounce_unclassified`) ÷ `sent` in the window | Rate rule; see minimum sample below. Threshold is a fraction (0.05 = 5%). |
| `hard_bounce_rate` | Same | `hard_bounce` ÷ `sent` | Rate rule. Hard/soft classification is header and subject based and can be partial. |
| `complaint_count` | Same | Count of `complaint` events | Evidence notes that complaint visibility is partial. |
| `provider_error_count` | Same | Count of `provider_error` + `sending_limit` events | |
| `sent_volume` | Same | Count of `sent` events | Provider-recorded sends, not deliveries. |
| `dns_check_failing` | Domain (monitoring enabled; one domain if domain-scoped) | Number of checks with status `fail` in the domain's latest completed scan | A domain with no completed scan is `no_data` and never triggers. `warn` and `inconclusive` do not count. The window is not used. |
| `mailbox_connection_unhealthy` | Mailbox | 1 if state is `reauth_required` or `consecutive_failures` ≥ 3, else 0 | Includes demo mailboxes. |
| `sync_stale` | Mailbox | 1 if the state is `connected` or `degraded` and there has been no successful sync within the organisation's `syncStaleAfterHours` setting (default **2 hours**, the same threshold as `mailbox.freshness`), else 0 | Demo mailboxes excluded. |

Mailboxes in state `disconnected` are excluded from every mailbox-based metric; `paused` and `reauth_required` mailboxes are still evaluated.

### Minimum sample rules

- Rate metrics: if `sent` in the window is below `max(1, min_sample)`, the result is `insufficient_data`, never triggered. The API refuses rate rules with `min_sample` below 1 and recommends 50 or more; the starter bounce rules use 50.
- Count metrics: if `min_sample` > 0 and `sent` in the window is below it, the result is `insufficient_data`.
- Connection-state and DNS metrics ignore `min_sample`.

### From evaluation to alert

- Only `triggered` results create or update alerts. The dedupe key is `<rule id>:<target type>:<target id or "org">`; there is at most one open or acknowledged alert per key. A repeat trigger increments `occurrences` and updates the observed value, sample size and evidence.
- A resolved alert for the same key does not re-open within the rule's `cooldown_minutes` (default 60).
- Evidence stored with each alert: the window, numerator and denominator, observed value, up to 10 sample event ids, failing check ids, connection ids and notes.
- Alerts record `rule_version` (the rule's integer version, incremented on every edit) and fixed next-step suggestions per metric.
- Notifications are sent only when an alert is first created: in-app if the rule enables it, email to the rule's addresses plus the organisation's `defaultAlertEmails` setting (recorded as `not_configured` when SMTP is not set up), and the rule's notification webhook if one is selected.
- `POST /api/v1/alert-rules/test` runs the same evaluation as a dry run and creates nothing.

### Starter rules

Every new organisation gets these monitor-only rules (`lib/alerts/starter-rules.ts`). The thresholds are conservative starting points that still need product-owner sign-off.

| Rule | Metric | Threshold | Window | Min sample | Severity |
|---|---|---|---|---|---|
| Bounce rate elevated (24h) | `bounce_rate` | ≥ 0.05 | 24 h | 50 | warning |
| Bounce rate critical (24h) | `bounce_rate` | ≥ 0.10 | 24 h | 50 | critical |
| Complaint feedback received (7d) | `complaint_count` | ≥ 1 | 7 days | 0 | warning |
| Provider errors (24h) | `provider_error_count` | ≥ 5 | 24 h | 0 | warning |
| DNS authentication check failing | `dns_check_failing` | ≥ 1 | — | 0 | critical |
| Mailbox connection needs attention | `mailbox_connection_unhealthy` | ≥ 1 | — | 0 | warning |
| Mailbox data is stale | `sync_stale` | ≥ 1 | — | 0 | info |

Note that the starter bounce rules (24-hour window, 5% and 10%) and the mailbox health bounce thresholds (7-day window, 2% and 5%, minimum 20 sends) are separate and can disagree.

## What is not measured

- **Inbox placement** (inbox vs spam folder at the recipient). Mailbox APIs cannot see recipients' mailboxes. Seed-list placement tests are not implemented ([roadmap-contracts.md](roadmap-contracts.md)).
- **Opens and clicks.** QuikReach does not track them.
- **Sender or domain reputation** as computed by mailbox providers (for example Google Postmaster Tools, Microsoft SNDS/JMRP). These are separate, aggregate products and are not integrated.
- **Complaint rates.** Only standard feedback reports (ARF) that arrive in a connected mailbox are counted; most providers do not deliver individual complaints to senders' mailboxes. Zero observed complaints is not evidence of zero complaints.
- **One-click (HTTPS) unsubscribes.** Only unsubscribe requests sent by email to the mailbox are seen.
- **SMTP status codes** inside bounce message bodies, and Microsoft sending-limit notices (which are inside NDR bodies).
- **Mail sent outside connected mailboxes**, for example through a sending platform's own infrastructure.

A `healthy` state means "nothing QuikReach can observe is wrong right now". It does not mean mail is being delivered to inboxes.
