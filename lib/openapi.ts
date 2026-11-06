/**
 * OpenAPI 3.1 description of the QuikReach v1 API. Served at
 * /api/v1/openapi.json. __tests__/unit/openapi.test.ts fails if a route file
 * under app/api/v1 is missing here (or documented here but missing).
 *
 * Auth: browser session cookie (NextAuth). Mutations must be same-origin
 * (Origin header checked). Responses use the envelope
 * { success: true, data } | { success: false, error, code, details? }.
 */
type Op = { summary: string; permission?: string; body?: string; query?: string[]; responses?: Record<string, string>; tags: string[] };

const op = (o: Op) => ({
  summary: o.summary,
  tags: o.tags,
  ...(o.permission ? { description: `Requires permission \`${o.permission}\`.`, "x-permission": o.permission } : {}),
  ...(o.query ? { parameters: o.query.map((q) => ({ name: q, in: "query", required: false, schema: { type: "string" } })) } : {}),
  ...(o.body ? { requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${o.body}` } } } } } : {}),
  responses: {
    ...(o.responses ?? { "200": "Success envelope" }),
    "400": "Validation failed",
    "401": "Not signed in",
    "403": "Forbidden (role, demo workspace, CSRF or plan limit)",
    "404": "Not found (including other tenants' ids)",
    "429": "Rate limited",
  },
});

const idParam = (name = "id") => ({ name, in: "path", required: true, schema: { type: "string", format: "uuid" } });
const T = { org: ["Organization"], dom: ["Domains"], mbx: ["Mailboxes"], evt: ["Events"], alr: ["Alerts"], ai: ["Diagnostics"], rep: ["Reports & usage"], int: ["Integrations & campaigns"], ops: ["Operations"] };

function withResponses(path: Record<string, ReturnType<typeof op> | unknown>) {
  for (const [method, value] of Object.entries(path)) {
    if (method === "parameters") continue;
    const v = value as { responses: Record<string, string | { description: string }> };
    v.responses = Object.fromEntries(Object.entries(v.responses).map(([code, d]) => [code, typeof d === "string" ? { description: d } : d]));
  }
  return path;
}

const paths: Record<string, Record<string, unknown>> = {
  "/me": { get: op({ summary: "Current user, active organization, role and permissions", tags: T.org }) },
  "/me/organization": { post: op({ summary: "Switch active organization (membership verified)", body: "SwitchOrg", tags: T.org }) },
  "/organizations": { post: op({ summary: "Create a workspace; caller becomes owner", body: "CreateOrg", tags: T.org, responses: { "201": "Created" } }) },
  "/organization": {
    get: op({ summary: "Organization settings and retention", permission: "organization:view", tags: T.org }),
    patch: op({ summary: "Update settings / retention (audited)", permission: "organization:update", body: "OrgPatch", tags: T.org }),
  },
  "/organization/automation": { post: op({ summary: "Pause/resume all automation (kill switch)", permission: "organization:update", body: "PauseToggle", tags: T.org }) },
  "/members": { get: op({ summary: "List members", permission: "member:view", tags: T.org }) },
  "/members/{id}": {
    parameters: [idParam()],
    patch: op({ summary: "Change role or enable/disable a member", permission: "member:update | member:disable", body: "MemberPatch", tags: T.org }),
    delete: op({ summary: "Remove a member", permission: "member:disable", query: ["reason"], tags: T.org, responses: { "204": "Removed" } }),
  },
  "/invitations": {
    get: op({ summary: "List invitations", permission: "member:view", tags: T.org }),
    post: op({ summary: "Invite by email (accept URL returned once)", permission: "member:invite", body: "Invite", tags: T.org, responses: { "201": "Created" } }),
  },
  "/invitations/{id}": { parameters: [idParam()], delete: op({ summary: "Revoke a pending invitation", permission: "member:invite", tags: T.org, responses: { "204": "Revoked" } }) },
  "/domains": {
    get: op({ summary: "List domains with latest scan summary", permission: "domain:view", tags: T.dom }),
    post: op({ summary: "Add a domain (creates verification token, queues setup scan)", permission: "domain:create", body: "CreateDomain", tags: T.dom, responses: { "201": "Created" } }),
  },
  "/domains/{id}": {
    parameters: [idParam()],
    get: op({ summary: "Domain detail: verification, latest checks with evidence, scan history, comparison", permission: "domain:view", tags: T.dom }),
    patch: op({ summary: "Update DKIM selectors / monitoring", permission: "domain:update", body: "DomainPatch", tags: T.dom }),
    delete: op({ summary: "Delete a domain", permission: "domain:delete", query: ["reason"], tags: T.dom, responses: { "204": "Deleted" } }),
  },
  "/domains/{id}/scan": { parameters: [idParam()], post: op({ summary: "Queue a DNS scan (MX, SPF, DKIM, DMARC)", permission: "domain:scan", query: ["trigger"], tags: T.dom, responses: { "202": "Queued" } }) },
  "/domains/{id}/verify": { parameters: [idParam()], post: op({ summary: "Check the ownership TXT record now", permission: "domain:update", tags: T.dom }) },
  "/mailboxes": { get: op({ summary: "List mailbox connections (no credentials)", permission: "mailbox:view", tags: T.mbx }) },
  "/mailboxes/providers": { get: op({ summary: "Configured providers, requested scopes and why", permission: "mailbox:view", tags: T.mbx }) },
  "/mailboxes/{id}": { parameters: [idParam()], get: op({ summary: "Mailbox detail: capabilities, syncs, recent events", permission: "mailbox:view", tags: T.mbx }) },
  "/mailboxes/{id}/sync": { parameters: [idParam()], post: op({ summary: "Queue a manual sync", permission: "mailbox:sync", tags: T.mbx, responses: { "202": "Queued" } }) },
  "/mailboxes/{id}/pause": { parameters: [idParam()], post: op({ summary: "Pause/resume monitoring for one mailbox", permission: "mailbox:pause", body: "PauseToggle", tags: T.mbx }) },
  "/mailboxes/{id}/disconnect": { parameters: [idParam()], post: op({ summary: "Disconnect: revoke (best effort), delete tokens, optionally delete events", permission: "mailbox:disconnect", body: "Disconnect", tags: T.mbx }) },
  "/mailboxes/oauth/start": { post: op({ summary: "Start Google/Microsoft OAuth (PKCE); returns authorization URL", permission: "mailbox:connect", body: "OAuthStart", tags: T.mbx }) },
  "/mailboxes/oauth/callback/{provider}": {
    parameters: [{ name: "provider", in: "path", required: true, schema: { type: "string", enum: ["google", "microsoft"] } }],
    get: op({ summary: "OAuth redirect target (browser). Redirects to the mailbox page or /mailboxes?oauth_error=code", query: ["code", "state", "error"], tags: T.mbx, responses: { "307": "Redirect" } }),
  },
  "/events": { get: op({ summary: "Search normalized events", permission: "event:view", query: ["provider", "domainId", "connectionId", "category", "from", "to", "includeSent", "limit", "offset"], tags: T.evt }) },
  "/events/export": { get: op({ summary: "CSV export with the same filters (formula-injection safe, audited)", permission: "event:export", query: ["provider", "domainId", "connectionId", "category", "from", "to", "includeSent"], tags: T.evt, responses: { "200": "text/csv" } }) },
  "/alert-rules": {
    get: op({ summary: "List alert rules", permission: "alert_rule:view", tags: T.alr }),
    post: op({ summary: "Create an alert rule", permission: "alert_rule:manage", body: "AlertRule", tags: T.alr, responses: { "201": "Created" } }),
  },
  "/alert-rules/{id}": {
    parameters: [idParam()],
    get: op({ summary: "Get an alert rule", permission: "alert_rule:view", tags: T.alr }),
    put: op({ summary: "Replace an alert rule (version++)", permission: "alert_rule:manage", body: "AlertRule", tags: T.alr }),
    delete: op({ summary: "Delete an alert rule", permission: "alert_rule:manage", tags: T.alr, responses: { "204": "Deleted" } }),
  },
  "/alert-rules/test": { post: op({ summary: "Dry-run a rule against current data (no side effects)", permission: "alert_rule:test", body: "AlertRule", tags: T.alr }) },
  "/alerts": { get: op({ summary: "List alerts", permission: "alert:view", query: ["status", "severity"], tags: T.alr }) },
  "/alerts/{id}": { parameters: [idParam()], get: op({ summary: "Alert detail with expanded evidence", permission: "alert:view", tags: T.alr }) },
  "/alerts/{id}/acknowledge": { parameters: [idParam()], post: op({ summary: "Acknowledge", permission: "alert:acknowledge", tags: T.alr }) },
  "/alerts/{id}/resolve": { parameters: [idParam()], post: op({ summary: "Resolve with a note", permission: "alert:resolve", body: "Resolve", tags: T.alr }) },
  "/diagnostics": {
    get: op({ summary: "Diagnosis history", permission: "diagnostic:view", tags: T.ai }),
    post: op({ summary: "Run an evidence-grounded diagnosis (AI model or rules engine)", permission: "diagnostic:run", body: "Diagnose", tags: T.ai, responses: { "201": "Created" } }),
  },
  "/diagnostics/{id}": { parameters: [idParam()], get: op({ summary: "Get one diagnosis", permission: "diagnostic:view", tags: T.ai }) },
  "/reports/summary": { get: op({ summary: "Period summary: daily series, per-mailbox totals, coverage", permission: "report:view", query: ["from", "to"], tags: T.rep }) },
  "/reports/export": { get: op({ summary: "CSV export of the period report", permission: "report:export", query: ["from", "to", "kind"], tags: T.rep, responses: { "200": "text/csv" } }) },
  "/usage": { get: op({ summary: "Usage vs. plan limits", permission: "usage:view", tags: T.rep }) },
  "/audit": { get: op({ summary: "Search audit history", permission: "audit:view", query: ["q", "action", "outcome", "from", "to", "limit", "offset"], tags: T.ops }) },
  "/health": { get: op({ summary: "Domain, mailbox and campaign-safety health with inputs and missing data", permission: "domain:view", tags: T.ops }) },
  "/notifications": { get: op({ summary: "Recent notifications", permission: "alert:view", tags: T.alr }) },
  "/jobs": { get: op({ summary: "Background jobs for this organization", permission: "job:view", query: ["status"], tags: T.ops }) },
  "/jobs/{id}/retry": { parameters: [idParam()], post: op({ summary: "Retry a dead-lettered job", permission: "job:retry", tags: T.ops }) },
  "/integrations": {
    get: op({ summary: "Integrations, mailbox provider status and roadmap items", permission: "integration:view", tags: T.int }),
    post: op({ summary: "Create a signed webhook integration (secret returned once)", permission: "integration:manage", body: "Integration", tags: T.int, responses: { "201": "Created" } }),
  },
  "/integrations/{id}/test": { parameters: [idParam()], post: op({ summary: "Send a signed ping; activates on success", permission: "integration:manage", tags: T.int }) },
  "/integrations/{id}/revoke": { parameters: [idParam()], post: op({ summary: "Disable or revoke an integration", permission: "integration:manage", body: "Revoke", tags: T.int }) },
  "/campaigns": {
    get: op({ summary: "Linked campaigns and action history", permission: "campaign:view", tags: T.int }),
    post: op({ summary: "Link an external campaign to a mailbox/domain", permission: "campaign:manage", body: "Campaign", tags: T.int, responses: { "201": "Created" } }),
  },
  "/campaigns/{id}/actions": { parameters: [idParam()], post: op({ summary: "Request pause/resume (confirmed only by the sending system)", permission: "campaign:pause | campaign:resume (+ campaign:review after critical pauses)", body: "CampaignAction", tags: T.int, responses: { "202": "Requested" } }) },
  "/openapi.json": { get: op({ summary: "This document", tags: T.ops }) },
};

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = { type: "string" };
const uuid = { type: "string", format: "uuid" };

export function openApiDocument(serverUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "QuikReach API",
      version: "1.0.0",
      description:
        "Email-domain health, mailbox monitoring, deliverability diagnostics and campaign safety. All data is tenant-scoped to the caller's active organization; organization ids in requests are never treated as authorization.",
    },
    servers: [{ url: `${serverUrl}/api/v1` }],
    security: [{ session: [] }],
    paths: Object.fromEntries(Object.entries(paths).map(([k, v]) => [k, withResponses(v)])),
    components: {
      securitySchemes: { session: { type: "apiKey", in: "cookie", name: "next-auth.session-token", description: "NextAuth session cookie (__Secure- prefixed over HTTPS)." } },
      schemas: {
        Error: obj({ success: { const: false }, error: str, code: str, details: { type: "object" } }, ["success", "error", "code"]),
        SwitchOrg: obj({ orgId: uuid }, ["orgId"]),
        CreateOrg: obj({ name: str }, ["name"]),
        OrgPatch: obj({ name: str, eventRetentionDays: { type: ["integer", "null"] }, diagnosticRetentionDays: { type: ["integer", "null"] }, auditRetentionDays: { type: ["integer", "null"] }, settings: { type: "object" } }),
        PauseToggle: obj({ paused: { type: "boolean" }, reason: str }, ["paused", "reason"]),
        MemberPatch: obj({ role: { enum: ["owner", "admin", "deliverability_manager", "campaign_manager", "analyst"] }, status: { enum: ["active", "disabled"] }, reason: str }),
        Invite: obj({ email: { type: "string", format: "email" }, role: { enum: ["owner", "admin", "deliverability_manager", "campaign_manager", "analyst"] } }, ["email", "role"]),
        CreateDomain: obj({ name: str }, ["name"]),
        DomainPatch: obj({ dkimSelectors: { type: "array", items: str }, monitoringEnabled: { type: "boolean" } }),
        Disconnect: obj({ reason: str, deleteEvents: { type: "boolean" } }, ["reason"]),
        OAuthStart: obj({ provider: { enum: ["google", "microsoft"] }, reconnectConnectionId: uuid }, ["provider"]),
        AlertRule: obj(
          {
            name: str,
            description: str,
            metric: { enum: ["bounce_rate", "hard_bounce_rate", "complaint_count", "provider_error_count", "sent_volume", "dns_check_failing", "mailbox_connection_unhealthy", "sync_stale"] },
            scopeType: { enum: ["organization", "domain", "mailbox"] },
            scopeId: { type: ["string", "null"], format: "uuid" },
            comparator: { enum: ["gt", "gte"] },
            threshold: { type: "number" },
            windowMinutes: { type: "integer" },
            minSample: { type: "integer" },
            severity: { enum: ["info", "warning", "critical"] },
            notificationTargets: obj({ inApp: { type: "boolean" }, emails: { type: "array", items: str }, webhookIntegrationId: { type: ["string", "null"] } }),
            actionPolicy: { enum: ["notify_only", "pause_campaigns"] },
            requireManualResume: { type: "boolean" },
            cooldownMinutes: { type: "integer" },
            enabled: { type: "boolean" },
          },
          ["name", "metric", "threshold", "windowMinutes", "severity", "notificationTargets"],
        ),
        Resolve: obj({ note: str }, ["note"]),
        Diagnose: obj({ subjectType: { enum: ["organization", "domain", "mailbox", "alert"] }, subjectId: uuid, question: str }, ["subjectType"]),
        Integration: obj({ kind: { enum: ["campaign_webhook", "notification_webhook"] }, name: str, endpointUrl: { type: "string", format: "uri" } }, ["kind", "name", "endpointUrl"]),
        Revoke: obj({ status: { enum: ["disabled", "revoked"] }, reason: str }, ["reason"]),
        Campaign: obj({ integrationId: uuid, externalId: str, name: str, mailboxConnectionId: uuid, domainId: uuid }, ["integrationId", "externalId", "name"]),
        CampaignAction: obj({ action: { enum: ["pause", "resume"] }, reason: str }, ["action", "reason"]),
      },
    },
  };
}

export const DOCUMENTED_PATHS = Object.keys(paths);
