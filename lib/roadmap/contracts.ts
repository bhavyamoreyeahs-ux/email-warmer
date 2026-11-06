/**
 * Interfaces for DEFERRED features. Nothing here is implemented or wired into
 * the product; these contracts exist so future work plugs into the current
 * architecture without rework, and so nobody mistakes a stub for a feature.
 * See docs/roadmap-contracts.md for the planned data model and the product /
 * policy questions each one must answer before it is built.
 */
import type { OAuthProvider } from "@/lib/mailboxes/providers/types";

/* ─── Authorised inbox-placement tests (seed mailboxes) ───────────────── */

/** A seed mailbox the CUSTOMER controls and has authorised for placement tests. */
export interface SeedMailbox {
  id: string;
  orgId: string;
  provider: OAuthProvider | "other";
  address: string;
  /** Evidence of authorisation (who connected it, when, under which terms). */
  authorization: { connectedByUserId: string; connectedAt: Date; termsVersion: string };
}

export type PlacementObservation = "inbox" | "promotions" | "spam" | "not_found" | "unknown";

export interface PlacementTestRun {
  id: string;
  orgId: string;
  sendingMailboxId: string;
  seedMailboxIds: string[];
  status: "planned" | "sending" | "observing" | "completed" | "failed";
  /** Per-seed observation. A seed result describes THAT seed only — never a population estimate. */
  results: Array<{ seedMailboxId: string; observation: PlacementObservation; observedAt: Date | null; evidenceRef: string | null }>;
}

export interface InboxPlacementTester {
  plan(orgId: string, sendingMailboxId: string, seedMailboxIds: string[]): Promise<PlacementTestRun>;
  observe(run: PlacementTestRun): Promise<PlacementTestRun>;
}

/* ─── Controlled warm-up scheduler (opt-in, no fabricated engagement) ──── */

export interface WarmupPlan {
  id: string;
  orgId: string;
  mailboxConnectionId: string;
  /** Daily volume caps the CUSTOMER's sending tool should respect — QuikReach does not send. */
  dailyCaps: Array<{ day: number; maxMessages: number }>;
  /** Automatic slow-down when observed bounce/complaint signals cross these thresholds. */
  guardrails: { maxBounceRate: number; maxComplaints: number };
  status: "draft" | "active" | "paused" | "completed";
}

export interface WarmupScheduler {
  propose(mailboxConnectionId: string): Promise<WarmupPlan>;
  evaluateGuardrails(plan: WarmupPlan): Promise<{ action: "continue" | "hold" | "reduce"; evidenceRefs: string[] }>;
}

/* ─── Opt-in network (explicitly NOT an engagement exchange) ──────────── */

export interface NetworkParticipation {
  orgId: string;
  optedInAt: Date;
  /** What is shared — aggregated, anonymised benchmarks only; never messages or recipients. */
  sharedSignals: Array<"aggregate_bounce_rates" | "dns_configuration_patterns">;
  termsVersion: string;
}

/* ─── QuikCRM / QuikPilot ─────────────────────────────────────────────── */

/** QuikPilot would implement the same contract as the signed campaign webhook (lib/campaigns). */
export interface CampaignExecutionProvider {
  readonly kind: "campaign_webhook" | "quikpilot";
  pause(campaign: { externalId: string; name: string }, ctx: { idempotencyKey: string; reason: string }): Promise<{ confirmed: boolean; status: "paused" | "active" | "unknown" }>;
  resume(campaign: { externalId: string; name: string }, ctx: { idempotencyKey: string; reason: string }): Promise<{ confirmed: boolean; status: "paused" | "active" | "unknown" }>;
}

/** QuikCRM link: map deliverability health onto CRM accounts (read-only push from QuikReach). */
export interface CrmHealthPublisher {
  publishDomainHealth(orgId: string, payload: { domain: string; state: string; ruleVersion: string; computedAt: Date }): Promise<void>;
}
