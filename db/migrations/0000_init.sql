CREATE TABLE "ai_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"requested_by_user_id" uuid,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"question" text,
	"engine" text NOT NULL,
	"model" text,
	"prompt_version" text NOT NULL,
	"evidence_refs" jsonb NOT NULL,
	"output" jsonb NOT NULL,
	"confidence" text,
	"status" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"metric" text NOT NULL,
	"scope_type" text DEFAULT 'organization' NOT NULL,
	"scope_id" uuid,
	"comparator" text DEFAULT 'gte' NOT NULL,
	"threshold" double precision NOT NULL,
	"window_minutes" integer DEFAULT 1440 NOT NULL,
	"min_sample" integer DEFAULT 0 NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"notification_targets" jsonb NOT NULL,
	"action_policy" text DEFAULT 'notify_only' NOT NULL,
	"require_manual_resume" boolean DEFAULT true NOT NULL,
	"cooldown_minutes" integer DEFAULT 60 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_rules_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "alert_rules_metric_ck" CHECK (metric in ('bounce_rate', 'hard_bounce_rate', 'complaint_count', 'provider_error_count', 'sent_volume', 'dns_check_failing', 'mailbox_connection_unhealthy', 'sync_stale')),
	CONSTRAINT "alert_rules_severity_ck" CHECK (severity in ('info', 'warning', 'critical')),
	CONSTRAINT "alert_rules_window_ck" CHECK (window_minutes between 5 and 43200),
	CONSTRAINT "alert_rules_min_sample_ck" CHECK (min_sample >= 0)
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"rule_id" uuid,
	"rule_version" integer,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"metric" text NOT NULL,
	"observed_value" double precision,
	"threshold" double precision,
	"sample_size" integer,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	"evidence" jsonb NOT NULL,
	"next_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"action_policy" text NOT NULL,
	"action_outcome" text NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"first_triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_by_user_id" uuid,
	"acknowledged_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	CONSTRAINT "alerts_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"actor_label" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"reason" text,
	"outcome" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_outcome_ck" CHECK (outcome in ('success', 'failure', 'denied', 'pending'))
);
--> statement-breakpoint
CREATE TABLE "background_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"idempotency_key" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "background_jobs_status_ck" CHECK (status in ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "campaign_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"action" text NOT NULL,
	"requested_by_type" text NOT NULL,
	"requested_by_user_id" uuid,
	"alert_id" uuid,
	"reason" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"external_response" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "campaign_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"mailbox_connection_id" uuid,
	"domain_id" uuid,
	"status" text DEFAULT 'unknown' NOT NULL,
	"status_confirmed_at" timestamp with time zone,
	"paused_by_quikreach" boolean DEFAULT false NOT NULL,
	"requires_review" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_references_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "campaign_references_ext_uq" UNIQUE("org_id","integration_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "domain_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"scan_id" uuid NOT NULL,
	"check_type" text NOT NULL,
	"status" text NOT NULL,
	"summary" text NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"rule_version" text NOT NULL,
	"resolver" text NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_checks_scan_type_uq" UNIQUE("scan_id","check_type"),
	CONSTRAINT "domain_checks_type_ck" CHECK (check_type in ('mx', 'spf', 'dkim', 'dmarc')),
	CONSTRAINT "domain_checks_status_ck" CHECK (status in ('pass', 'warn', 'fail', 'inconclusive'))
);
--> statement-breakpoint
CREATE TABLE "domain_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"requested_by_user_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"rule_version" text,
	"resolver" text,
	"summary" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_scans_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "domain_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"method" text DEFAULT 'dns_txt' NOT NULL,
	"record_name" text NOT NULL,
	"token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"evidence" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_verifications_status_ck" CHECK (status in ('pending', 'verified', 'failed', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"verification_status" text DEFAULT 'unverified' NOT NULL,
	"verified_at" timestamp with time zone,
	"dkim_selectors" text[] DEFAULT '{}'::text[] NOT NULL,
	"monitoring_enabled" boolean DEFAULT true NOT NULL,
	"last_scan_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domains_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "domains_org_name_uq" UNIQUE("org_id","name"),
	CONSTRAINT "domains_verification_ck" CHECK (verification_status in ('unverified', 'pending', 'verified', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"plan" text DEFAULT 'trial' NOT NULL,
	"limits" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"valid_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "health_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"state" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"missing" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rule_version" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_snapshots_state_ck" CHECK (state in ('healthy', 'at_risk', 'critical', 'unknown', 'stale'))
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'pending_setup' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"encrypted_secret" text,
	"key_id" text,
	"last_tested_at" timestamp with time zone,
	"last_test_outcome" text,
	"created_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrations_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "integrations_kind_ck" CHECK (kind in ('campaign_webhook', 'notification_webhook', 'quikcrm', 'quikpilot'))
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_role_ck" CHECK (role in ('owner', 'admin', 'deliverability_manager', 'campaign_manager', 'analyst'))
);
--> statement-breakpoint
CREATE TABLE "mailbox_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"domain_id" uuid,
	"provider" text NOT NULL,
	"email_address" text NOT NULL,
	"provider_account_id" text,
	"display_name" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"state_reason" text,
	"granted_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"connected_by_user_id" uuid,
	"last_successful_sync_at" timestamp with time zone,
	"last_sync_attempt_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"next_sync_at" timestamp with time zone,
	"sync_cursor" jsonb,
	"is_demo" boolean DEFAULT false NOT NULL,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_connections_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "mailbox_connections_org_provider_email_uq" UNIQUE("org_id","provider","email_address"),
	CONSTRAINT "mailbox_connections_provider_ck" CHECK (provider in ('google', 'microsoft', 'demo')),
	CONSTRAINT "mailbox_connections_state_ck" CHECK (state in ('pending', 'connected', 'degraded', 'reauth_required', 'disconnected', 'paused', 'demo')),
	CONSTRAINT "mailbox_connections_demo_ck" CHECK ((provider = 'demo') = is_demo)
);
--> statement-breakpoint
CREATE TABLE "mailbox_credentials" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"encrypted_refresh_token" text,
	"access_token_expires_at" timestamp with time zone,
	"key_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_org_user_uq" UNIQUE("org_id","user_id"),
	CONSTRAINT "memberships_role_ck" CHECK (role in ('owner', 'admin', 'deliverability_manager', 'campaign_manager', 'analyst')),
	CONSTRAINT "memberships_status_ck" CHECK (status in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"alert_id" uuid,
	"channel" text NOT NULL,
	"target" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"read_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_hash" text NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"encrypted_code_verifier" text NOT NULL,
	"reconnect_connection_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"automation_paused" boolean DEFAULT false NOT NULL,
	"event_retention_days" integer,
	"diagnostic_retention_days" integer,
	"audit_retention_days" integer,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_status_ck" CHECK (status in ('active', 'suspended')),
	CONSTRAINT "organizations_retention_ck" CHECK ((event_retention_days is null or event_retention_days between 1 and 3650)
          and (diagnostic_retention_days is null or diagnostic_retention_days between 1 and 3650)
          and (audit_retention_days is null or audit_retention_days between 30 and 3650))
);
--> statement-breakpoint
CREATE TABLE "provider_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"status" text NOT NULL,
	"detail" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_capabilities_conn_cap_uq" UNIQUE("connection_id","capability"),
	CONSTRAINT "provider_capabilities_status_ck" CHECK (status in ('available', 'partial', 'unavailable', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"domain_id" uuid,
	"provider" text NOT NULL,
	"source" text NOT NULL,
	"category" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"provider_message_ref" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recipient_domain" text,
	"recipient_hash" text,
	"confidence" text NOT NULL,
	"classification_basis" text NOT NULL,
	"diagnostic_code" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	CONSTRAINT "provider_events_org_dedupe_uq" UNIQUE("org_id","dedupe_key"),
	CONSTRAINT "provider_events_category_ck" CHECK (category in ('sent', 'hard_bounce', 'soft_bounce', 'bounce_unclassified', 'complaint', 'unsubscribe', 'reply', 'auto_reply', 'provider_error', 'sending_limit', 'unknown')),
	CONSTRAINT "provider_events_confidence_ck" CHECK (confidence in ('high', 'medium', 'low'))
);
--> statement-breakpoint
CREATE TABLE "provider_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"messages_examined" integer DEFAULT 0 NOT NULL,
	"events_created" integer DEFAULT 0 NOT NULL,
	"events_duplicate" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_buckets_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"quantity" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"source" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_ledger_metric_ck" CHECK (metric in ('dns_scan', 'mailbox_connected', 'event_ingested', 'ai_diagnosis', 'inbox_test'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"password_hash" text,
	"external_subject" text,
	"status" text DEFAULT 'active' NOT NULL,
	"session_version" integer DEFAULT 0 NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_status_ck" CHECK (status in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"info" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_recommendations" ADD CONSTRAINT "ai_recommendations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_recommendations" ADD CONSTRAINT "ai_recommendations_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_rule_id_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_acknowledged_by_user_id_users_id_fk" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_actions" ADD CONSTRAINT "campaign_actions_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_actions" ADD CONSTRAINT "campaign_actions_org_id_campaign_id_campaign_references_org_id_id_fk" FOREIGN KEY ("org_id","campaign_id") REFERENCES "public"."campaign_references"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_references" ADD CONSTRAINT "campaign_references_org_id_integration_id_integrations_org_id_id_fk" FOREIGN KEY ("org_id","integration_id") REFERENCES "public"."integrations"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_references" ADD CONSTRAINT "campaign_references_org_id_mailbox_connection_id_mailbox_connections_org_id_id_fk" FOREIGN KEY ("org_id","mailbox_connection_id") REFERENCES "public"."mailbox_connections"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_references" ADD CONSTRAINT "campaign_references_org_id_domain_id_domains_org_id_id_fk" FOREIGN KEY ("org_id","domain_id") REFERENCES "public"."domains"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_checks" ADD CONSTRAINT "domain_checks_org_id_domain_id_domains_org_id_id_fk" FOREIGN KEY ("org_id","domain_id") REFERENCES "public"."domains"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_checks" ADD CONSTRAINT "domain_checks_org_id_scan_id_domain_scans_org_id_id_fk" FOREIGN KEY ("org_id","scan_id") REFERENCES "public"."domain_scans"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_scans" ADD CONSTRAINT "domain_scans_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_scans" ADD CONSTRAINT "domain_scans_org_id_domain_id_domains_org_id_id_fk" FOREIGN KEY ("org_id","domain_id") REFERENCES "public"."domains"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_verifications" ADD CONSTRAINT "domain_verifications_org_id_domain_id_domains_org_id_id_fk" FOREIGN KEY ("org_id","domain_id") REFERENCES "public"."domains"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_snapshots" ADD CONSTRAINT "health_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_connections" ADD CONSTRAINT "mailbox_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_connections" ADD CONSTRAINT "mailbox_connections_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_connections" ADD CONSTRAINT "mailbox_connections_org_id_domain_id_domains_org_id_id_fk" FOREIGN KEY ("org_id","domain_id") REFERENCES "public"."domains"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_credentials" ADD CONSTRAINT "mailbox_credentials_org_id_connection_id_mailbox_connections_org_id_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "public"."mailbox_connections"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_capabilities" ADD CONSTRAINT "provider_capabilities_org_id_connection_id_mailbox_connections_org_id_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "public"."mailbox_connections"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_org_id_connection_id_mailbox_connections_org_id_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "public"."mailbox_connections"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_syncs" ADD CONSTRAINT "provider_syncs_org_id_connection_id_mailbox_connections_org_id_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "public"."mailbox_connections"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_recommendations_org_created_idx" ON "ai_recommendations" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_open_dedupe_uq" ON "alerts" USING btree ("org_id","dedupe_key") WHERE status <> 'resolved';--> statement-breakpoint
CREATE INDEX "alerts_org_status_idx" ON "alerts" USING btree ("org_id","status","last_triggered_at");--> statement-breakpoint
CREATE INDEX "audit_logs_org_created_idx" ON "audit_logs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_org_action_idx" ON "audit_logs" USING btree ("org_id","action");--> statement-breakpoint
CREATE INDEX "background_jobs_ready_idx" ON "background_jobs" USING btree ("status","run_at","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "background_jobs_idem_uq" ON "background_jobs" USING btree ("idempotency_key") WHERE status in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "background_jobs_org_idx" ON "background_jobs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_actions_idem_uq" ON "campaign_actions" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "domain_checks_domain_checked_idx" ON "domain_checks" USING btree ("org_id","domain_id","checked_at");--> statement-breakpoint
CREATE INDEX "domain_scans_domain_created_idx" ON "domain_scans" USING btree ("org_id","domain_id","created_at");--> statement-breakpoint
CREATE INDEX "domain_verifications_domain_idx" ON "domain_verifications" USING btree ("domain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "domains_verified_name_uq" ON "domains" USING btree ("name") WHERE verification_status = 'verified';--> statement-breakpoint
CREATE UNIQUE INDEX "entitlements_org_uq" ON "entitlements" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "health_snapshots_subject_idx" ON "health_snapshots" USING btree ("org_id","subject_type","subject_id","computed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_hash_uq" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invitations_org_idx" ON "invitations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "mailbox_connections_next_sync_idx" ON "mailbox_connections" USING btree ("state","next_sync_at");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_org_created_idx" ON "notifications" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_states_state_hash_uq" ON "oauth_states" USING btree ("state_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_uq" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "provider_events_org_occurred_idx" ON "provider_events" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX "provider_events_conn_occurred_idx" ON "provider_events" USING btree ("org_id","connection_id","occurred_at");--> statement-breakpoint
CREATE INDEX "provider_events_org_category_idx" ON "provider_events" USING btree ("org_id","category","occurred_at");--> statement-breakpoint
CREATE INDEX "provider_syncs_conn_started_idx" ON "provider_syncs" USING btree ("org_id","connection_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_ledger_idem_uq" ON "usage_ledger" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "usage_ledger_org_metric_idx" ON "usage_ledger" USING btree ("org_id","metric","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_external_subject_uq" ON "users" USING btree ("external_subject");