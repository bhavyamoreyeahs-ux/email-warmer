# Roles and permissions

The single source of truth is `lib/rbac.ts` (`PERMISSIONS`, `ROLE_PERMISSIONS`, `canAssignRole`). This page was generated from that file; if they disagree, the code wins and this page needs updating. `__tests__/unit/rbac.test.ts` asserts the key rules below.

Permissions are checked server-side on every request after the membership is re-read from the database (`withOrgAuth` in `lib/api/with-org-auth.ts`). Hidden or disabled buttons in the UI are a convenience only.

## Roles

| Role (id) | Name in UI | Summary |
|---|---|---|
| `owner` | Owner | Every permission, including `organization:delete`. Only owners can grant, change or remove the Owner role. |
| `admin` | Administrator | Every permission except `organization:delete`. Manages members, settings, integrations and all deliverability features. |
| `deliverability_manager` | Deliverability Manager | Manages domains, mailboxes, alert rules and diagnostics; can pause campaigns and approve resumption after serious alerts (`campaign:review`). Cannot manage members, integrations or settings, cannot link campaigns, cannot view the audit log. |
| `campaign_manager` | Campaign Manager | Views everything in `VIEW_ALL`, connects mailboxes, links campaigns, pauses and resumes linked campaigns, acknowledges alerts, dry-runs rules, runs diagnostics. Cannot change alert rules and cannot resume a campaign that a critical alert paused. |
| `analyst` | Read-only Analyst | Views dashboards, domains, mailboxes, events, alerts, campaigns, integrations, reports, usage and diagnoses; can export CSV. Cannot change anything and cannot view the audit log or jobs. |

## Permission matrix

✓ = granted, — = not granted.

| Permission | Owner | Admin | Deliverability Manager | Campaign Manager | Analyst |
|---|:-:|:-:|:-:|:-:|:-:|
| `organization:view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `organization:update` | ✓ | ✓ | — | — | — |
| `organization:delete` | ✓ | — | — | — | — |
| `member:view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `member:invite` | ✓ | ✓ | — | — | — |
| `member:update` | ✓ | ✓ | — | — | — |
| `member:disable` | ✓ | ✓ | — | — | — |
| `domain:view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `domain:create` | ✓ | ✓ | ✓ | — | — |
| `domain:update` | ✓ | ✓ | ✓ | — | — |
| `domain:delete` | ✓ | ✓ | ✓ | — | — |
| `domain:scan` | ✓ | ✓ | ✓ | — | — |
| `mailbox:view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `mailbox:connect` | ✓ | ✓ | ✓ | ✓ | — |
| `mailbox:disconnect` | ✓ | ✓ | ✓ | — | — |
| `mailbox:sync` | ✓ | ✓ | ✓ | — | — |
| `mailbox:pause` | ✓ | ✓ | ✓ | — | — |
| `event:view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `event:export` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `alert_rule:view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `alert_rule:manage` | ✓ | ✓ | ✓ | — | — |
| `alert_rule:test` | ✓ | ✓ | ✓ | ✓ | — |
| `alert:view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `alert:acknowledge` | ✓ | ✓ | ✓ | ✓ | — |
| `alert:resolve` | ✓ | ✓ | ✓ | — | — |
| `campaign:view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `campaign:manage` | ✓ | ✓ | — | ✓ | — |
| `campaign:pause` | ✓ | ✓ | ✓ | ✓ | — |
| `campaign:resume` | ✓ | ✓ | — | ✓ | — |
| `campaign:review` | ✓ | ✓ | ✓ | — | — |
| `integration:view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `integration:manage` | ✓ | ✓ | — | — | — |
| `report:view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `report:export` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `usage:view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `audit:view` | ✓ | ✓ | — | — | — |
| `diagnostic:view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `diagnostic:run` | ✓ | ✓ | ✓ | ✓ | — |
| `job:view` | ✓ | ✓ | ✓ | — | — |
| `job:retry` | ✓ | ✓ | — | — | — |

Totals: Owner 40, Administrator 39, Deliverability Manager 30, Campaign Manager 21, Analyst 14.

Notes on how some permissions are applied:

- `organization:delete` exists in the matrix, but there is no route or UI that deletes an organisation in this release.
- `GET /api/v1/health` is gated by `domain:view`; `GET /api/v1/notifications` by `alert:view`; `GET /api/v1/me` has no permission requirement beyond an active membership.
- `PATCH /api/v1/members/{id}` passes the guard with `member:view`, then requires `member:update` to change a role and `member:disable` to change status.
- `POST /api/v1/campaigns/{id}/actions` passes the guard with `campaign:view`, then requires `campaign:pause` for a pause, and `campaign:resume` **or** `campaign:review` for a resume. A Deliverability Manager can therefore resume campaigns through `campaign:review` even though it does not hold `campaign:resume`.
- Denials raised inside a handler (the two cases above, and role-assignment rules) return `403 FORBIDDEN`. On mutating requests they are audited as `authz.denied` with target type `route`, in the same way as guard-level denials (target type `permission`).

## Role assignment rules

From `canAssignRole(actor, target)` and `lib/tenancy/members.ts` / `lib/tenancy/invitations.ts`:

| Actor | May assign / invite / change / disable / remove |
|---|---|
| Owner | Any role, including Owner |
| Administrator | Administrator, Deliverability Manager, Campaign Manager, Analyst (not Owner) |
| Deliverability Manager, Campaign Manager, Analyst | Nobody |

Additional invariants:

- Changing a member's role requires that the actor can assign both the member's current role and the new role. An Administrator cannot demote an Owner.
- An organisation must keep at least one active Owner. Demoting, disabling or removing the last active Owner returns `409 CONFLICT`.
- Members cannot change their own membership status or remove themselves.
- Invitations follow the same rule: only an Owner can invite an Owner. A new invitation for an email address revokes any pending invitation for that address in the same organisation.
- A disabled membership loses access on its next request, because the principal is re-read from the database per request.
- The user who creates an organisation (signup or `POST /api/v1/organizations`) becomes its Owner.

## Separation of duties: `campaign:review`

When a pause request linked to an alert is **confirmed** by the sending system, and that alert has severity `critical` and its rule has `requireManualResume` (default `true`; also treated as `true` if the rule was deleted), the campaign reference is marked `requires_review`. While that flag is set, only a role with `campaign:review` (Owner, Administrator, Deliverability Manager) may request a resume. A Campaign Manager receives `403 FORBIDDEN` with an explanation. The flag is cleared when a resume is confirmed.

The alert-rule validator refuses a rule with severity `critical`, action policy `pause_campaigns` and `requireManualResume: false`.

Campaign Managers also cannot change detection rules (`alert_rule:manage`), so the people who run campaigns cannot both loosen a threshold and resume a campaign that the threshold paused.
