# Integrations: signed webhooks

QuikReach does not send email campaigns and cannot pause anything by itself. It can ask **your** system to pause or resume a campaign through a webhook you build and authorise, and it can post alert notifications to a webhook. This page is the contract for those webhooks.

**No third-party sending platform (Smartlead, Instantly or any other) is integrated natively in this release.** To protect campaigns in such a tool, you build a small receiver that verifies QuikReach's signature and calls that tool's API. QuikCRM and QuikPilot appear in the product as planned integrations only and are never shown as connected.

Code: `lib/integrations/service.ts`, `lib/integrations/webhook.ts`, `lib/campaigns/service.ts`, `lib/notify/deliver.ts`, `lib/alerts/evaluate.ts`.

## Integration kinds and lifecycle

| Kind | Purpose |
|---|---|
| `campaign_webhook` | Receives `campaign.pause` and `campaign.resume` requests for linked campaigns |
| `notification_webhook` | Receives `alert.notification` messages for alert rules that select it |

1. **Create** (`POST /api/v1/integrations`, `integration:manage`) with `kind`, `name` and an `https://` `endpointUrl`. The URL passes the SSRF checks below. QuikReach generates a signing secret (`qrwh_` followed by 32 random bytes, base64url), returns it **once** in the response, and stores it encrypted. Status: `pending_setup`.
2. **Test** (`POST /api/v1/integrations/{id}/test`) sends a signed `ping`. On success the status becomes `active`. On failure an `active` integration becomes `error`; other statuses are left unchanged.
3. **Disable or revoke** (`POST /api/v1/integrations/{id}/revoke` with `status` `disabled` or `revoked`). `disabled` keeps the secret; a later successful test re-activates it. `revoked` deletes the secret; the integration cannot be tested or used again.

Only `active` integrations are used. Campaign pause/resume requests against an integration that is not active are refused with `400 BAD_REQUEST`, and queued requests for it fail.

## Linking campaigns

`POST /api/v1/campaigns` (`campaign:manage`) creates a campaign reference: `integrationId` (a `campaign_webhook` integration in the same organisation), `externalId` (your campaign id, 1–200 characters), `name`, and optionally `mailboxConnectionId` and/or `domainId`. Linking the same `externalId` twice through the same integration returns `409 CONFLICT`. The link decides which alerts can pause the campaign:

- An alert about a mailbox pauses campaigns linked to that mailbox.
- An alert about a domain (domain-scoped event rules, and `dns_check_failing`) pauses campaigns linked to that domain.

## Requests QuikReach sends

All requests are `POST` with a JSON body.

### Headers

| Header | Value |
|---|---|
| `content-type` | `application/json` |
| `user-agent` | `QuikReach-Webhook/1.0` |
| `idempotency-key` | Stable per logical request; see each message type |
| `x-quikreach-signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>` |

### `ping` (integration test)

```json
{
  "type": "ping",
  "integrationId": "3f0c8f1e-1b7a-4c1e-9a52-0d6c2f1b9a10",
  "sentAt": "2026-10-31T12:00:00.000Z"
}
```

`idempotency-key`: `test:<integrationId>:<milliseconds since epoch>` (new on every test).

### `campaign.pause` and `campaign.resume`

```json
{
  "type": "campaign.pause",
  "actionId": "9b1d6c2e-4f3a-4d8e-b7a1-2c5e8f0a1b3c",
  "campaign": { "externalId": "cmp_12345", "name": "Q4 outbound — EU" },
  "reason": "Alert: Bounce rate critical (24h) — sales@example.com",
  "requestedBy": "automation"
}
```

| Field | Meaning |
|---|---|
| `type` | `campaign.pause` or `campaign.resume` |
| `actionId` | QuikReach's id for this request (`campaign_actions.id`) |
| `campaign.externalId`, `campaign.name` | As linked in QuikReach |
| `reason` | For automated pauses: `Alert: <rule name> — <target>`, where the target is a mailbox address or a domain label. For user requests: the reason the user typed (3–500 characters). |
| `requestedBy` | `automation` (alert rule) or `user` |

`idempotency-key`:

- Automated pause: `alert:<alertId>:pause:<campaignReferenceId>`.
- User request: `user:<random UUID>:<pause|resume>:<campaignReferenceId>`. Every user request gets a new UUID, so two separate requests from users are two different keys.

The same key is sent on every retry of the same request.

### `alert.notification`

```json
{
  "type": "alert.notification",
  "notificationId": "5e2a9c41-7d3b-4f0e-8a6c-1b9d2e3f4a5b",
  "alertId": "a7c3e1d2-9b8f-4e6a-b5c4-3d2e1f0a9b8c",
  "title": "Bounce rate critical (24h) — sales@example.com",
  "body": "sales@example.com: 11.20% (56/500) vs threshold 10.00%. Severity: critical. Monitor-only rule: no campaign action taken."
}
```

`idempotency-key`: `notification:<notificationId>`.

Notifications are created only when an alert is first created, not when an existing open alert re-triggers. `title` and `body` are human-readable text and can contain mailbox addresses and domain names.

## Verifying the signature

Verify against the **raw request body** before parsing it, reject timestamps more than 5 minutes from your clock, and compare with a constant-time function. Reference implementation (Node.js, TypeScript):

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 5 * 60;

export function verifyQuikReachSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!signatureHeader) return false;

  const parts = new Map<string, string>();
  for (const piece of signatureHeader.split(",")) {
    const i = piece.indexOf("=");
    if (i > 0) parts.set(piece.slice(0, i).trim(), piece.slice(i + 1).trim());
  }
  const t = Number(parts.get("t"));
  const v1 = parts.get("v1") ?? "";
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(v1)) return false;
  if (Math.abs(nowSeconds - t) > TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const received = Buffer.from(v1, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}
```

Example receiver (any framework that exposes a Fetch API `Request`):

```ts
export async function POST(req: Request): Promise<Response> {
  const raw = await req.text();
  if (!verifyQuikReachSignature(raw, req.headers.get("x-quikreach-signature"), process.env.QUIKREACH_SIGNING_SECRET!)) {
    return new Response("invalid signature", { status: 401 });
  }
  const idempotencyKey = req.headers.get("idempotency-key");
  const event = JSON.parse(raw) as { type: string; campaign?: { externalId: string } };

  // If idempotencyKey was already processed, return the stored response unchanged.

  if (event.type === "ping") return Response.json({ ok: true });

  if (event.type === "campaign.pause" && event.campaign) {
    // Call your sending platform here and read back the campaign's real state.
    return Response.json({ ok: true, campaign: { externalId: event.campaign.externalId, status: "paused" } });
  }

  return Response.json({ ok: false }, { status: 400 });
}
```

Store processed `idempotency-key` values with the response you returned, and return the same response for repeats.

## Required responses

| Request | Response QuikReach treats as success |
|---|---|
| `ping` to a `campaign_webhook` | HTTP 2xx **and** JSON body `{ "ok": true }` |
| `ping` to a `notification_webhook` | Any HTTP 2xx |
| `campaign.pause` | HTTP 2xx and `{ "ok": true, "campaign": { "externalId": "<same externalId>", "status": "paused" } }` |
| `campaign.resume` | HTTP 2xx and `{ "ok": true, "campaign": { "externalId": "<same externalId>", "status": "active" } }` |
| `alert.notification` | Any HTTP 2xx |

Return `"status": "paused"` or `"active"` only after your system has actually changed (or confirmed) the campaign's state. Extra fields are ignored. QuikReach keeps only the first 10,000 bytes of the response.

## How QuikReach interprets campaign responses

| Outcome | Condition | What QuikReach records |
|---|---|---|
| **Confirmed** | 2xx, `ok === true`, `campaign.externalId` equals the linked id, `campaign.status` equals the requested state | Action `confirmed`. Campaign status and `status_confirmed_at` updated. For a pause: marked as paused by QuikReach, and `requires_review` set if the pause came from a critical alert whose rule requires manual resume. Alert outcome `pause_confirmed`. |
| **Unconfirmed** | 2xx but the body does not match the above (including non-JSON or truncated bodies) | Action `unconfirmed`. Campaign status unchanged. Alert outcome stays `pause_requested`. Shown to users as not confirmed. |
| **Failed** | Non-2xx below 500, including 3xx (redirects are not followed) and 4xx | Action `failed` with `HTTP <status>`. Alert outcome `pause_failed`. Not retried. |
| **Retried** | 5xx, timeout (no data for 10 s), network error, or the endpoint failing the SSRF checks at send time | Action set back to `queued` with the error, and the job is retried with exponential backoff (about 30 s, 60 s, 120 s, ... plus jitter). User-requested actions get 3 attempts, automated pauses 5. |

When the last attempt also fails, the action is marked `failed` with the last error, a linked alert's outcome becomes `pause_failed`, a `campaign.pause` or `campaign.resume` audit record with outcome `failure` ("Gave up after retries") is written, and the job moves to the dead-letter state (visible in Settings → Jobs).

Only `confirmed` means the campaign changed state. The UI and reports count only confirmed actions as completed.

Notification webhooks: any 2xx marks the notification `sent`; anything else marks it `failed` and it is retried until it has been attempted 3 times.

## When QuikReach requests a pause automatically

All of these must hold when an alert is first created:

1. The alert rule's action policy is `pause_campaigns` (starter rules are all `notify_only`).
2. The organisation has at least one `active` `campaign_webhook` integration.
3. The organisation's automation kill switch is off. If it is on, no pause is requested and the alert says so.
4. At least one campaign of an active integration is linked to the alert's mailbox or domain.

Otherwise the alert records why nothing was paused: `no_campaign_integration`, `no_linked_campaigns` or `notify_only`. A re-trigger of an already open alert does not send another pause. If the alert is resolved and triggers again after the rule's cooldown, a new alert and new pause requests are created.

## Manual review after critical pauses

When a confirmed pause came from an alert with severity `critical` and the rule requires manual resume (the default, and mandatory for critical rules that pause campaigns), the campaign is flagged `requires_review`. Only a role with `campaign:review` (Owner, Administrator, Deliverability Manager) can then request a resume; a Campaign Manager gets `403 FORBIDDEN`. The flag clears when a resume is confirmed. Every request and outcome is audited (`campaign.pause.request`, `campaign.resume.request`, `campaign.pause`, `campaign.resume`). See [permissions.md](permissions.md#separation-of-duties-campaignreview).

## SSRF rules for webhook endpoints

Checked when the integration is created and again on every request:

- `https://` only. `http://` is accepted only outside production with `ALLOW_PRIVATE_WEBHOOK_TARGETS=true`, which `lib/env.ts` refuses in production.
- No username or password in the URL.
- No IP literal in a private or reserved range, and no `localhost`, `*.localhost`, `*.local` or `*.internal` hostname.
- At creation, every address the hostname resolves to must be public. On each request, the socket's own DNS lookup drops private and reserved addresses (including IPv4-mapped IPv6 in any form) and connects only to a public one, so the address checked is the address used.
- Redirects are not followed.
- 10-second socket timeout.

The full list of blocked ranges is in [security.md → Outbound webhook SSRF protections](security.md#outbound-webhook-ssrf-protections).

## Receiver checklist

- Serve HTTPS with a publicly trusted certificate on a public address.
- Verify the signature and timestamp before doing anything else; return 401 on failure (QuikReach records it as `failed`).
- De-duplicate on `idempotency-key`.
- Respond within 10 seconds. If the sending platform is slow, confirm only what you know; an `unconfirmed` result is better than a false confirmation.
- Return 5xx only for transient problems you want retried; return 4xx for permanent rejections.
- Store the signing secret in a secret manager. To rotate it, create a new integration, update the receiver, link campaigns to the new integration, and revoke the old one.
