/**
 * QuikReach database schema (PostgreSQL, Drizzle ORM).
 *
 * TENANCY RULES (enforced in code, reinforced here)
 *   - Every tenant-owned table carries `org_id`. Every query in lib/ filters by
 *     the org id resolved server-side from the session + membership — never from
 *     a request body or query string.
 *   - Child tables reference their parent with a COMPOSITE foreign key
 *     (org_id, parent_id) → parent(org_id, id). A row can therefore never point
 *     at a parent that belongs to another organisation, even if application code
 *     has a bug.
 *
 * DATA MINIMISATION
 *   - No email bodies are stored anywhere. Provider events keep provider ids,
 *     header-derived classifications, recipient DOMAIN and a keyed hash of the
 *     recipient address (for de-duplication / counting), never the address.
 *   - OAuth tokens live only in `mailbox_credentials`, encrypted (AES-256-GCM)
 *     with a versioned key id; they are never selected by list queries.
 *
 * Status vocabularies are text + CHECK constraints rather than Postgres enums so
 * they can evolve with ordinary migrations.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });
const orgId = () => uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" });

/* ─── Shared vocabularies ─────────────────────────────────────────────── */

export const ROLES = ["owner", "admin", "deliverability_manager", "campaign_manager", "analyst"] as const;
export type Role = (typeof ROLES)[number];

export const CHECK_TYPES = ["mx", "spf", "dkim", "dmarc"] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

/** `inconclusive` = we could not determine the answer (timeout, unknown selector…). Never "pass". */
export const CHECK_STATUSES = ["pass", "warn", "fail", "inconclusive"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const PROVIDERS = ["google", "microsoft", "demo"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const CONNECTION_STATES = [
  "pending", // OAuth completed, capability validation not finished yet
  "connected",
  "degraded", // token valid, but recent provider errors (quota, outage)
  "reauth_required", // refresh failed / revoked / insufficient scope — needs the user
  "disconnected", // user disconnected; tokens deleted
  "paused", // monitoring paused by an administrator (abuse / kill switch)
  "demo", // seeded demo record — NOT a live connection
] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export const CAPABILITY_STATUSES = ["available", "partial", "unavailable", "unknown"] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export const EVENT_CATEGORIES = [
  "sent", // provider recorded an outbound message (NOT proof of inbox delivery)
  "hard_bounce",
  "soft_bounce",
  "bounce_unclassified", // a bounce whose hard/soft class could not be determined
  "complaint",
  "unsubscribe",
  "reply",
  "auto_reply",
  "provider_error",
  "sending_limit",
  "unknown",
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const HEALTH_STATES = ["healthy", "at_risk", "critical", "unknown", "stale"] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export const SEVERITIES = ["info", "warning", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "dead", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

const inList = (column: string, values: readonly string[]) =>
  sql.raw(`${column} in (${values.map((v) => `'${v}'`).join(", ")})`);

/* ─── Identity & tenancy ──────────────────────────────────────────────── */

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name").notNull().default(""),
    /** bcrypt hash. Null for users who only sign in through QuikIT SSO. */
    passwordHash: text("password_hash"),
    /** Subject from the QuikIT identity provider, when federated. */
    externalSubject: text("external_subject"),
    status: text("status").$type<"active" | "disabled">().notNull().default("active"),
    /** Incremented to revoke every outstanding session for this user. */
    sessionVersion: integer("session_version").notNull().default(0),
    lastLoginAt: ts("last_login_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`),
    uniqueIndex("users_external_subject_uq").on(t.externalSubject),
    check("users_status_ck", inList("status", ["active", "disabled"])),
  ],
);

export const organizations = pgTable(
  "organizations",
  {
    id: id(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /** Demo organisations hold seeded sample data only. Live data is never written here. */
    isDemo: boolean("is_demo").notNull().default(false),
    status: text("status").$type<"active" | "suspended">().notNull().default("active"),
    /** Organisation-wide kill switch: pauses syncs, scheduled scans and automated actions. */
    automationPaused: boolean("automation_paused").notNull().default(false),
    /** Null = use the deployment default (DEFAULT_EVENT_RETENTION_DAYS). */
    eventRetentionDays: integer("event_retention_days"),
    diagnosticRetentionDays: integer("diagnostic_retention_days"),
    auditRetentionDays: integer("audit_retention_days"),
    settings: jsonb("settings").$type<OrgSettings>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("organizations_slug_uq").on(t.slug),
    check("organizations_status_ck", inList("status", ["active", "suspended"])),
    check(
      "organizations_retention_ck",
      sql`(event_retention_days is null or event_retention_days between 1 and 3650)
          and (diagnostic_retention_days is null or diagnostic_retention_days between 1 and 3650)
          and (audit_retention_days is null or audit_retention_days between 30 and 3650)`,
    ),
  ],
);

export interface OrgSettings {
  timezone?: string;
  /** Email addresses that receive alert notifications by default. */
  defaultAlertEmails?: string[];
  /** Hours after which a mailbox sync is considered stale (null/absent = default). */
  syncStaleAfterHours?: number | null;
  /** Days after which a domain scan is considered stale (null/absent = default). */
  scanStaleAfterDays?: number | null;
}

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    orgId: orgId(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<Role>().notNull(),
    status: text("status").$type<"active" | "disabled">().notNull().default("active"),
    disabledAt: ts("disabled_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("memberships_org_user_uq").on(t.orgId, t.userId),
    index("memberships_user_idx").on(t.userId),
    check("memberships_role_ck", inList("role", ROLES)),
    check("memberships_status_ck", inList("status", ["active", "disabled"])),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    orgId: orgId(),
    email: text("email").notNull(),
    role: text("role").$type<Role>().notNull(),
    /** SHA-256 of the raw token. The raw token is shown once and never stored. */
    tokenHash: text("token_hash").notNull(),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
    expiresAt: ts("expires_at").notNull(),
    acceptedAt: ts("accepted_at"),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("invitations_token_hash_uq").on(t.tokenHash),
    index("invitations_org_idx").on(t.orgId),
    check("invitations_role_ck", inList("role", ROLES)),
  ],
);

/* ─── Domains & DNS ───────────────────────────────────────────────────── */

export const domains = pgTable(
  "domains",
  {
    id: id(),
    orgId: orgId(),
    /** Lower-case, IDNA (punycode) form, no trailing dot. */
    name: text("name").notNull(),
    verificationStatus: text("verification_status")
      .$type<"unverified" | "pending" | "verified" | "failed">()
      .notNull()
      .default("unverified"),
    verifiedAt: ts("verified_at"),
    /** DKIM selectors supplied by the customer (from a sent message's DKIM-Signature s= tag). */
    dkimSelectors: text("dkim_selectors").array().notNull().default(sql`'{}'::text[]`),
    monitoringEnabled: boolean("monitoring_enabled").notNull().default(true),
    lastScanAt: ts("last_scan_at"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("domains_org_id_uq").on(t.orgId, t.id),
    unique("domains_org_name_uq").on(t.orgId, t.name),
    // Ownership can be proven by only one organisation at a time.
    uniqueIndex("domains_verified_name_uq").on(t.name).where(sql`verification_status = 'verified'`),
    check("domains_verification_ck", inList("verification_status", ["unverified", "pending", "verified", "failed"])),
  ],
);

export const domainVerifications = pgTable(
  "domain_verifications",
  {
    id: id(),
    orgId: uuid("org_id").notNull(),
    domainId: uuid("domain_id").notNull(),
    method: text("method").$type<"dns_txt">().notNull().default("dns_txt"),
    /** Fully-qualified name where the TXT record must be published. */
    recordName: text("record_name").notNull(),
    /** Value the customer publishes. Public by design once in DNS; not a secret. */
    token: text("token").notNull(),
    status: text("status").$type<"pending" | "verified" | "failed" | "superseded">().notNull().default("pending"),
    lastCheckedAt: ts("last_checked_at"),
    verifiedAt: ts("verified_at"),
    evidence: jsonb("evidence").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.domainId], foreignColumns: [domains.orgId, domains.id] }).onDelete("cascade"),
    index("domain_verifications_domain_idx").on(t.domainId),
    check("domain_verifications_status_ck", inList("status", ["pending", "verified", "failed", "superseded"])),
  ],
);

export const domainScans = pgTable(
  "domain_scans",
  {
    id: id(),
    orgId: uuid("org_id").notNull(),
    domainId: uuid("domain_id").notNull(),
    trigger: text("trigger").$type<"manual" | "scheduled" | "setup" | "recheck">().notNull(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, { onDelete: "set null" }),
    status: text("status").$type<"queued" | "running" | "completed" | "failed">().notNull().default("queued"),
    ruleVersion: text("rule_version"),
    resolver: text("resolver"),
    summary: jsonb("summary").$type<Partial<Record<CheckType, CheckStatus>>>(),
    error: text("error"),
    startedAt: ts("started_at"),
    completedAt: ts("completed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("domain_scans_org_id_uq").on(t.orgId, t.id),
    foreignKey({ columns: [t.orgId, t.domainId], foreignColumns: [domains.orgId, domains.id] }).onDelete("cascade"),
    index("domain_scans_domain_created_idx").on(t.orgId, t.domainId, t.createdAt),
  ],
);

export interface CheckFinding {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  recommendation?: string;
}

export interface DnsQueryEvidence {
  name: string;
  type: "TXT" | "MX" | "A" | "AAAA" | "CNAME";
  /** Answers exactly as resolved (TXT chunks joined). */
  answers: string[];
  /** NOERROR, NXDOMAIN, NODATA, TIMEOUT, SERVFAIL, REFUSED, ERROR */
  outcome: string;
  durationMs: number;
}

export interface CheckEvidence {
  queries: DnsQueryEvidence[];
  parsed?: Record<string, unknown>;
}

export const domainChecks = pgTable(
  "domain_checks",
  {
    id: id(),
    orgId: uuid("org_id").notNull(),
    domainId: uuid("domain_id").notNull(),
    scanId: uuid("scan_id").notNull(),
    checkType: text("check_type").$type<CheckType>().notNull(),
    status: text("status").$type<CheckStatus>().notNull(),
    summary: text("summary").notNull(),
    findings: jsonb("findings").$type<CheckFinding[]>().notNull().default([]),
    evidence: jsonb("evidence").$type<CheckEvidence>().notNull(),
    ruleVersion: text("rule_version").notNull(),
    resolver: text("resolver").notNull(),
    durationMs: integer("duration_ms").notNull().default(0),
    checkedAt: ts("checked_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.domainId], foreignColumns: [domains.orgId, domains.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.orgId, t.scanId], foreignColumns: [domainScans.orgId, domainScans.id] }).onDelete("cascade"),
    unique("domain_checks_scan_type_uq").on(t.scanId, t.checkType),
    index("domain_checks_domain_checked_idx").on(t.orgId, t.domainId, t.checkedAt),
    check("domain_checks_type_ck", inList("check_type", CHECK_TYPES)),
    check("domain_checks_status_ck", inList("status", CHECK_STATUSES)),
  ],
);

/* ─── Mailbox connections ─────────────────────────────────────────────── */

export const mailboxConnections = pgTable(
  "mailbox_connections",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    domainId: uuid("domain_id"),
    provider: text("provider").$type<Provider>().notNull(),
    emailAddress: text("email_address").notNull(),
    providerAccountId: text("provider_account_id"),
    displayName: text("display_name"),
    state: text("state").$type<ConnectionState>().notNull().default("pending"),
    /** Human-readable, sanitised explanation of the current state. Never contains tokens. */
    stateReason: text("state_reason"),
    grantedScopes: text("granted_scopes").array().notNull().default(sql`'{}'::text[]`),
    connectedByUserId: uuid("connected_by_user_id").references(() => users.id, { onDelete: "set null" }),
    lastSuccessfulSyncAt: ts("last_successful_sync_at"),
    lastSyncAttemptAt: ts("last_sync_attempt_at"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    nextSyncAt: ts("next_sync_at"),
    /** Provider cursor (Gmail historyId / Graph deltaLink). Opaque. */
    syncCursor: jsonb("sync_cursor").$type<Record<string, string>>(),
    isDemo: boolean("is_demo").notNull().default(false),
    disconnectedAt: ts("disconnected_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("mailbox_connections_org_id_uq").on(t.orgId, t.id),
    unique("mailbox_connections_org_provider_email_uq").on(t.orgId, t.provider, t.emailAddress),
    foreignKey({ columns: [t.orgId, t.domainId], foreignColumns: [domains.orgId, domains.id] }),
    index("mailbox_connections_next_sync_idx").on(t.state, t.nextSyncAt),
    check("mailbox_connections_provider_ck", inList("provider", PROVIDERS)),
    check("mailbox_connections_state_ck", inList("state", CONNECTION_STATES)),
    // Demo records can only ever be demo-provider rows, and vice versa.
    check("mailbox_connections_demo_ck", sql`(provider = 'demo') = is_demo`),
  ],
);

export const mailboxCredentials = pgTable(
  "mailbox_credentials",
  {
    connectionId: uuid("connection_id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    encryptedAccessToken: text("encrypted_access_token").notNull(),
    encryptedRefreshToken: text("encrypted_refresh_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    keyId: text("key_id").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.connectionId],
      foreignColumns: [mailboxConnections.orgId, mailboxConnections.id],
    }).onDelete("cascade"),
  ],
);

export const providerCapabilities = pgTable(
  "provider_capabilities",
  {
    id: id(),
    orgId: uuid("org_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    capability: text("capability").notNull(),
    status: text("status").$type<CapabilityStatus>().notNull(),
    detail: text("detail").notNull(),
    checkedAt: ts("checked_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.connectionId],
      foreignColumns: [mailboxConnections.orgId, mailboxConnections.id],
    }).onDelete("cascade"),
    unique("provider_capabilities_conn_cap_uq").on(t.connectionId, t.capability),
    check("provider_capabilities_status_ck", inList("status", CAPABILITY_STATUSES)),
  ],
);

export const providerSyncs = pgTable(
  "provider_syncs",
  {
    id: id(),
    orgId: uuid("org_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    trigger: text("trigger").$type<"initial" | "scheduled" | "manual">().notNull(),
    status: text("status").$type<"running" | "succeeded" | "failed" | "partial">().notNull().default("running"),
    messagesExamined: integer("messages_examined").notNull().default(0),
    eventsCreated: integer("events_created").notNull().default(0),
    eventsDuplicate: integer("events_duplicate").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.connectionId],
      foreignColumns: [mailboxConnections.orgId, mailboxConnections.id],
    }).onDelete("cascade"),
    index("provider_syncs_conn_started_idx").on(t.orgId, t.connectionId, t.startedAt),
  ],
);

/** Short-lived OAuth authorisation state (CSRF + PKCE). Single use. */
export const oauthStates = pgTable(
  "oauth_states",
  {
    id: id(),
    stateHash: text("state_hash").notNull(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").$type<"google" | "microsoft">().notNull(),
    encryptedCodeVerifier: text("encrypted_code_verifier").notNull(),
    reconnectConnectionId: uuid("reconnect_connection_id"),
    expiresAt: ts("expires_at").notNull(),
    consumedAt: ts("consumed_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("oauth_states_state_hash_uq").on(t.stateHash)],
);

/* ─── Events & health ─────────────────────────────────────────────────── */

export const providerEvents = pgTable(
  "provider_events",
  {
    id: id(),
    orgId: uuid("org_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    domainId: uuid("domain_id"),
    provider: text("provider").$type<Provider>().notNull(),
    /** gmail_api | graph_api | demo_seed */
    source: text("source").notNull(),
    category: text("category").$type<EventCategory>().notNull(),
    /** Idempotency key: provider + mailbox + provider message id + category. */
    dedupeKey: text("dedupe_key").notNull(),
    providerMessageRef: text("provider_message_ref"),
    occurredAt: ts("occurred_at").notNull(),
    ingestedAt: ts("ingested_at").notNull().defaultNow(),
    recipientDomain: text("recipient_domain"),
    /** HMAC of the counterparty address — lets us count distinct recipients without storing them. */
    recipientHash: text("recipient_hash"),
    confidence: text("confidence").$type<"high" | "medium" | "low">().notNull(),
    /** What the classification was based on, e.g. "header:X-Failed-Recipients + subject:(Failure)". */
    classificationBasis: text("classification_basis").notNull(),
    diagnosticCode: text("diagnostic_code"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    isDemo: boolean("is_demo").notNull().default(false),
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.connectionId],
      foreignColumns: [mailboxConnections.orgId, mailboxConnections.id],
    }).onDelete("cascade"),
    unique("provider_events_org_dedupe_uq").on(t.orgId, t.dedupeKey),
    index("provider_events_org_occurred_idx").on(t.orgId, t.occurredAt),
    index("provider_events_conn_occurred_idx").on(t.orgId, t.connectionId, t.occurredAt),
    index("provider_events_org_category_idx").on(t.orgId, t.category, t.occurredAt),
    check("provider_events_category_ck", inList("category", EVENT_CATEGORIES)),
    check("provider_events_confidence_ck", inList("confidence", ["high", "medium", "low"])),
  ],
);

export interface HealthInput {
  key: string;
  label: string;
  state: HealthState;
  detail: string;
  observedAt: string | null;
  evidenceRefs: string[];
  /** Context only (e.g. "monitor-only"): shown with an Info label and excluded from the combined state. */
  informational?: boolean;
}

export const healthSnapshots = pgTable(
  "health_snapshots",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").$type<"domain" | "mailbox" | "campaign_safety">().notNull(),
    subjectId: uuid("subject_id"),
    state: text("state").$type<HealthState>().notNull(),
    inputs: jsonb("inputs").$type<HealthInput[]>().notNull(),
    missing: jsonb("missing").$type<string[]>().notNull().default([]),
    ruleVersion: text("rule_version").notNull(),
    computedAt: ts("computed_at").notNull().defaultNow(),
  },
  (t) => [
    index("health_snapshots_subject_idx").on(t.orgId, t.subjectType, t.subjectId, t.computedAt),
    check("health_snapshots_state_ck", inList("state", HEALTH_STATES)),
  ],
);

/* ─── Alerts, notifications, campaign safety ──────────────────────────── */

export const ALERT_METRICS = [
  "bounce_rate", // (hard + soft + unclassified bounces) / sent
  "hard_bounce_rate",
  "complaint_count",
  "provider_error_count",
  "sent_volume", // outbound messages recorded by the provider in the window
  "dns_check_failing",
  "mailbox_connection_unhealthy",
  "sync_stale",
] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];

export interface NotificationTargets {
  inApp: boolean;
  emails: string[];
  webhookIntegrationId?: string | null;
}

export const alertRules = pgTable(
  "alert_rules",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    metric: text("metric").$type<AlertMetric>().notNull(),
    scopeType: text("scope_type").$type<"organization" | "domain" | "mailbox">().notNull().default("organization"),
    scopeId: uuid("scope_id"),
    comparator: text("comparator").$type<"gt" | "gte">().notNull().default("gte"),
    threshold: doublePrecision("threshold").notNull(),
    windowMinutes: integer("window_minutes").notNull().default(1440),
    /** Minimum denominator (e.g. sent messages) before a rate rule may fire. */
    minSample: integer("min_sample").notNull().default(0),
    severity: text("severity").$type<Severity>().notNull().default("warning"),
    notificationTargets: jsonb("notification_targets").$type<NotificationTargets>().notNull(),
    actionPolicy: text("action_policy").$type<"notify_only" | "pause_campaigns">().notNull().default("notify_only"),
    requireManualResume: boolean("require_manual_resume").notNull().default(true),
    cooldownMinutes: integer("cooldown_minutes").notNull().default(60),
    enabled: boolean("enabled").notNull().default(true),
    version: integer("version").notNull().default(1),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("alert_rules_org_id_uq").on(t.orgId, t.id),
    check("alert_rules_metric_ck", inList("metric", ALERT_METRICS)),
    check("alert_rules_severity_ck", inList("severity", SEVERITIES)),
    check("alert_rules_window_ck", sql`window_minutes between 5 and 43200`),
    check("alert_rules_min_sample_ck", sql`min_sample >= 0`),
  ],
);

export interface AlertEvidence {
  window: { start: string; end: string };
  numerator?: number;
  denominator?: number;
  observedValue: number | null;
  sampleEventIds: string[];
  checkIds: string[];
  connectionIds: string[];
  notes: string[];
}

export const alerts = pgTable(
  "alerts",
  {
    id: id(),
    orgId: orgId(),
    ruleId: uuid("rule_id").references(() => alertRules.id, { onDelete: "set null" }),
    ruleVersion: integer("rule_version"),
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status").$type<"open" | "acknowledged" | "resolved">().notNull().default("open"),
    severity: text("severity").$type<Severity>().notNull(),
    title: text("title").notNull(),
    metric: text("metric").$type<AlertMetric>().notNull(),
    observedValue: doublePrecision("observed_value"),
    threshold: doublePrecision("threshold"),
    sampleSize: integer("sample_size"),
    scopeType: text("scope_type").notNull(),
    scopeId: uuid("scope_id"),
    evidence: jsonb("evidence").$type<AlertEvidence>().notNull(),
    nextSteps: jsonb("next_steps").$type<string[]>().notNull().default([]),
    actionPolicy: text("action_policy").$type<"notify_only" | "pause_campaigns">().notNull(),
    /** What actually happened to campaigns. Only "pause_confirmed" means a pause happened. */
    actionOutcome: text("action_outcome")
      .$type<"notify_only" | "no_campaign_integration" | "no_linked_campaigns" | "pause_requested" | "pause_confirmed" | "pause_failed">()
      .notNull(),
    occurrences: integer("occurrences").notNull().default(1),
    firstTriggeredAt: ts("first_triggered_at").notNull().defaultNow(),
    lastTriggeredAt: ts("last_triggered_at").notNull().defaultNow(),
    acknowledgedByUserId: uuid("acknowledged_by_user_id").references(() => users.id, { onDelete: "set null" }),
    acknowledgedAt: ts("acknowledged_at"),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: ts("resolved_at"),
    resolutionNote: text("resolution_note"),
    isDemo: boolean("is_demo").notNull().default(false),
  },
  (t) => [
    unique("alerts_org_id_uq").on(t.orgId, t.id),
    // One open/acknowledged alert per dedupe key: repeat triggers update it.
    uniqueIndex("alerts_open_dedupe_uq").on(t.orgId, t.dedupeKey).where(sql`status <> 'resolved'`),
    index("alerts_org_status_idx").on(t.orgId, t.status, t.lastTriggeredAt),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    orgId: orgId(),
    alertId: uuid("alert_id").references(() => alerts.id, { onDelete: "cascade" }),
    channel: text("channel").$type<"in_app" | "email" | "webhook">().notNull(),
    target: text("target").notNull(),
    status: text("status").$type<"pending" | "sent" | "failed" | "not_configured">().notNull().default("pending"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    readAt: ts("read_at"),
    sentAt: ts("sent_at"),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_org_created_idx").on(t.orgId, t.createdAt)],
);

export const INTEGRATION_KINDS = ["campaign_webhook", "notification_webhook", "quikcrm", "quikpilot"] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export const integrations = pgTable(
  "integrations",
  {
    id: id(),
    orgId: orgId(),
    kind: text("kind").$type<IntegrationKind>().notNull(),
    name: text("name").notNull(),
    status: text("status").$type<"active" | "disabled" | "error" | "pending_setup" | "revoked">().notNull().default("pending_setup"),
    /** Non-secret configuration (endpoint URL etc.). */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    /** Encrypted signing secret / credential. Never returned by the API. */
    encryptedSecret: text("encrypted_secret"),
    keyId: text("key_id"),
    lastTestedAt: ts("last_tested_at"),
    lastTestOutcome: text("last_test_outcome"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("integrations_org_id_uq").on(t.orgId, t.id),
    check("integrations_kind_ck", inList("kind", INTEGRATION_KINDS)),
  ],
);

export const campaignReferences = pgTable(
  "campaign_references",
  {
    id: id(),
    orgId: uuid("org_id").notNull(),
    integrationId: uuid("integration_id").notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    mailboxConnectionId: uuid("mailbox_connection_id"),
    domainId: uuid("domain_id"),
    /** Status as last CONFIRMED by the execution system. */
    status: text("status").$type<"active" | "paused" | "unknown">().notNull().default("unknown"),
    statusConfirmedAt: ts("status_confirmed_at"),
    pausedByQuikreach: boolean("paused_by_quikreach").notNull().default(false),
    /** Set when a serious-severity pause happened; resume needs a reviewer. */
    requiresReview: boolean("requires_review").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("campaign_references_org_id_uq").on(t.orgId, t.id),
    unique("campaign_references_ext_uq").on(t.orgId, t.integrationId, t.externalId),
    foreignKey({ columns: [t.orgId, t.integrationId], foreignColumns: [integrations.orgId, integrations.id] }).onDelete("cascade"),
    foreignKey({
      columns: [t.orgId, t.mailboxConnectionId],
      foreignColumns: [mailboxConnections.orgId, mailboxConnections.id],
    }),
    foreignKey({ columns: [t.orgId, t.domainId], foreignColumns: [domains.orgId, domains.id] }),
  ],
);

export const campaignActions = pgTable(
  "campaign_actions",
  {
    id: id(),
    orgId: uuid("org_id").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    action: text("action").$type<"pause" | "resume">().notNull(),
    requestedByType: text("requested_by_type").$type<"user" | "automation">().notNull(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, { onDelete: "set null" }),
    alertId: uuid("alert_id"),
    reason: text("reason").notNull(),
    /** confirmed = the execution system confirmed the new state. Anything else is NOT a completed action. */
    status: text("status").$type<"queued" | "sent" | "confirmed" | "failed" | "unconfirmed">().notNull().default("queued"),
    idempotencyKey: text("idempotency_key").notNull(),
    externalResponse: jsonb("external_response").$type<Record<string, unknown>>(),
    error: text("error"),
    createdAt: createdAt(),
    completedAt: ts("completed_at"),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.campaignId], foreignColumns: [campaignReferences.orgId, campaignReferences.id] }).onDelete("cascade"),
    uniqueIndex("campaign_actions_idem_uq").on(t.orgId, t.idempotencyKey),
  ],
);

/* ─── AI diagnostics ──────────────────────────────────────────────────── */

export const aiRecommendations = pgTable(
  "ai_recommendations",
  {
    id: id(),
    orgId: orgId(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, { onDelete: "set null" }),
    subjectType: text("subject_type").$type<"organization" | "domain" | "mailbox" | "alert">().notNull(),
    subjectId: uuid("subject_id"),
    question: text("question"),
    /** "anthropic" (LLM) or "rules" (deterministic engine, no model). */
    engine: text("engine").$type<"anthropic" | "rules">().notNull(),
    model: text("model"),
    promptVersion: text("prompt_version").notNull(),
    evidenceRefs: jsonb("evidence_refs").$type<string[]>().notNull(),
    output: jsonb("output").$type<Record<string, unknown>>().notNull(),
    confidence: text("confidence").$type<"low" | "medium" | "high">(),
    status: text("status").$type<"completed" | "failed" | "insufficient_evidence">().notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms"),
    createdAt: createdAt(),
  },
  (t) => [index("ai_recommendations_org_created_idx").on(t.orgId, t.createdAt)],
);

/* ─── Usage, entitlements, audit, jobs ────────────────────────────────── */

export const USAGE_METRICS = ["dns_scan", "mailbox_connected", "event_ingested", "ai_diagnosis", "inbox_test"] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

export const usageLedger = pgTable(
  "usage_ledger",
  {
    id: id(),
    orgId: orgId(),
    metric: text("metric").$type<UsageMetric>().notNull(),
    quantity: integer("quantity").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    source: text("source").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("usage_ledger_idem_uq").on(t.orgId, t.idempotencyKey),
    index("usage_ledger_org_metric_idx").on(t.orgId, t.metric, t.occurredAt),
    check("usage_ledger_metric_ck", inList("metric", USAGE_METRICS)),
  ],
);

export interface EntitlementLimits {
  maxDomains: number;
  maxMailboxes: number;
  maxMembers: number;
  dnsScansPerDay: number;
  aiDiagnosesPerMonth: number;
  eventsPerMonth: number;
}

export const entitlements = pgTable(
  "entitlements",
  {
    id: id(),
    orgId: orgId(),
    plan: text("plan").notNull().default("trial"),
    limits: jsonb("limits").$type<EntitlementLimits>().notNull(),
    status: text("status").$type<"active" | "expired" | "suspended">().notNull().default("active"),
    validUntil: ts("valid_until"),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("entitlements_org_uq").on(t.orgId)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    actorType: text("actor_type").$type<"user" | "system" | "automation">().notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Denormalised for history: the actor's email at the time, or the automation name. */
    actorLabel: text("actor_label").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    reason: text("reason"),
    outcome: text("outcome").$type<"success" | "failure" | "denied" | "pending">().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    requestId: text("request_id"),
    ipHash: text("ip_hash"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_logs_org_created_idx").on(t.orgId, t.createdAt),
    index("audit_logs_org_action_idx").on(t.orgId, t.action),
    check("audit_logs_outcome_ck", inList("outcome", ["success", "failure", "denied", "pending"])),
  ],
);

export const backgroundJobs = pgTable(
  "background_jobs",
  {
    id: id(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    priority: integer("priority").notNull().default(100),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAt: ts("run_at").notNull().defaultNow(),
    lockedAt: ts("locked_at"),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    /** De-duplicates enqueues while a job with the same key is still pending. */
    idempotencyKey: text("idempotency_key"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: ts("completed_at"),
  },
  (t) => [
    index("background_jobs_ready_idx").on(t.status, t.runAt, t.priority),
    uniqueIndex("background_jobs_idem_uq").on(t.idempotencyKey).where(sql`status in ('queued', 'running')`),
    index("background_jobs_org_idx").on(t.orgId, t.createdAt),
    check("background_jobs_status_ck", inList("status", JOB_STATUSES)),
  ],
);

export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  info: jsonb("info").$type<Record<string, unknown>>().notNull().default({}),
});

/** Fixed-window counters shared by every app instance (no Redis required). */
export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    key: text("key").notNull(),
    windowStart: ts("window_start").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);
