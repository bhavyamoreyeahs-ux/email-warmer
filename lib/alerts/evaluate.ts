/**
 * Alert-rule evaluation.
 *
 *  - Rate rules (bounce_rate, hard_bounce_rate) never fire below `minSample`
 *    provider-recorded sends: they report `insufficient_data` instead.
 *  - Event-count rules evaluate per mailbox for organisation scope, so an alert
 *    always names the mailbox that needs attention.
 *  - Each trigger carries evidence: window, numerator/denominator, sample event
 *    ids, check ids, connection ids.
 *  - Dedupe: one open/acknowledged alert per (rule, target). Re-triggers update
 *    it (occurrences, last value) instead of creating noise; a resolved alert
 *    does not re-open within the rule's cooldown.
 *  - Campaign actions: only `pause_campaigns` rules with an ACTIVE campaign
 *    integration and linked campaigns create pause requests, and the outcome is
 *    `pause_requested` until the execution system confirms. Otherwise the alert
 *    records exactly why nothing was paused.
 */
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  alertRules,
  alerts,
  campaignActions,
  campaignReferences,
  domainChecks,
  domainScans,
  domains,
  integrations,
  mailboxConnections,
  notifications,
  organizations,
  type AlertEvidence,
  type AlertMetric,
} from "@/lib/db/schema";
import { enqueueJob } from "@/lib/jobs/queue";
import { recordAudit, automationActor } from "@/lib/audit";
import { emailConfigured } from "@/lib/notify/email";

export type RuleLike = Pick<
  typeof alertRules.$inferSelect,
  "metric" | "scopeType" | "scopeId" | "comparator" | "threshold" | "windowMinutes" | "minSample" | "severity" | "name"
> & { id?: string; orgId: string };

export interface TargetEvaluation {
  targetType: "mailbox" | "domain" | "organization";
  targetId: string | null;
  targetLabel: string;
  status: "triggered" | "ok" | "insufficient_data" | "no_data";
  observedValue: number | null;
  numerator?: number;
  denominator?: number;
  evidence: AlertEvidence;
  message: string;
}

const RATE_METRICS = new Set<AlertMetric>(["bounce_rate", "hard_bounce_rate"]);
const BOUNCE_CATEGORIES = ["hard_bounce", "soft_bounce", "bounce_unclassified"];

const compare = (value: number, comparator: "gt" | "gte", threshold: number) => (comparator === "gt" ? value > threshold : value >= threshold);

const fmt = (metric: AlertMetric, v: number | null) =>
  v === null ? "n/a" : RATE_METRICS.has(metric) ? `${(v * 100).toFixed(2)}%` : String(Math.round(v * 100) / 100);

async function scopedConnections(rule: RuleLike) {
  const conds = [eq(mailboxConnections.orgId, rule.orgId), sql`${mailboxConnections.state} not in ('disconnected')`];
  if (rule.scopeType === "mailbox" && rule.scopeId) conds.push(eq(mailboxConnections.id, rule.scopeId));
  if (rule.scopeType === "domain" && rule.scopeId) conds.push(eq(mailboxConnections.domainId, rule.scopeId));
  return db
    .select({
      id: mailboxConnections.id,
      email: mailboxConnections.emailAddress,
      state: mailboxConnections.state,
      consecutiveFailures: mailboxConnections.consecutiveFailures,
      lastSuccessfulSyncAt: mailboxConnections.lastSuccessfulSyncAt,
      domainId: mailboxConnections.domainId,
    })
    .from(mailboxConnections)
    .where(and(...conds));
}

async function eventStats(orgId: string, connectionIds: string[], since: Date, until: Date) {
  if (!connectionIds.length) return new Map<string, Record<string, number>>();
  const result = await db.execute<{ connection_id: string; category: string; n: number }>(sql`
    select connection_id, category, count(*)::int as n from provider_events
     where org_id = ${orgId} and occurred_at >= ${since.toISOString()} and occurred_at < ${until.toISOString()}
       and connection_id in (${sql.join(connectionIds.map((c) => sql`${c}`), sql`, `)})
     group by connection_id, category`);
  const map = new Map<string, Record<string, number>>();
  for (const r of (result as unknown as { rows: Array<{ connection_id: string; category: string; n: number }> }).rows) {
    const m = map.get(r.connection_id) ?? {};
    m[r.category] = Number(r.n);
    map.set(r.connection_id, m);
  }
  return map;
}

async function sampleEventIds(orgId: string, connectionIds: string[], categories: string[], since: Date, until: Date) {
  if (!connectionIds.length) return [];
  const result = await db.execute<{ id: string }>(sql`
    select id from provider_events
     where org_id = ${orgId} and occurred_at >= ${since.toISOString()} and occurred_at < ${until.toISOString()}
       and connection_id in (${sql.join(connectionIds.map((c) => sql`${c}`), sql`, `)})
       and category in (${sql.join(categories.map((c) => sql`${c}`), sql`, `)})
     order by occurred_at desc limit 10`);
  return (result as unknown as { rows: Array<{ id: string }> }).rows.map((r) => r.id);
}

function numeratorCategories(metric: AlertMetric): string[] {
  switch (metric) {
    case "bounce_rate":
      return BOUNCE_CATEGORIES;
    case "hard_bounce_rate":
      return ["hard_bounce"];
    case "complaint_count":
      return ["complaint"];
    case "provider_error_count":
      return ["provider_error", "sending_limit"];
    case "sent_volume":
      return ["sent"];
    default:
      return [];
  }
}

export async function evaluateRule(rule: RuleLike, now = new Date()): Promise<TargetEvaluation[]> {
  const since = new Date(now.getTime() - rule.windowMinutes * 60_000);
  const window = { start: since.toISOString(), end: now.toISOString() };
  const base = (): AlertEvidence => ({ window, observedValue: null, sampleEventIds: [], checkIds: [], connectionIds: [], notes: [] });

  /* DNS rule: per domain, latest completed scan has a failing check. */
  if (rule.metric === "dns_check_failing") {
    const dconds = [eq(domains.orgId, rule.orgId), eq(domains.monitoringEnabled, true)];
    if (rule.scopeType === "domain" && rule.scopeId) dconds.push(eq(domains.id, rule.scopeId));
    const ds = await db.select({ id: domains.id, name: domains.name }).from(domains).where(and(...dconds));
    if (!ds.length) return [];
    const latest = await db
      .selectDistinctOn([domainScans.domainId], { domainId: domainScans.domainId, id: domainScans.id, completedAt: domainScans.completedAt })
      .from(domainScans)
      .where(and(eq(domainScans.orgId, rule.orgId), eq(domainScans.status, "completed"), inArray(domainScans.domainId, ds.map((d) => d.id))))
      .orderBy(domainScans.domainId, desc(domainScans.completedAt));
    const checks = latest.length
      ? await db
          .select({ id: domainChecks.id, domainId: domainChecks.domainId, status: domainChecks.status, checkType: domainChecks.checkType })
          .from(domainChecks)
          .where(and(eq(domainChecks.orgId, rule.orgId), inArray(domainChecks.scanId, latest.map((l) => l.id))))
      : [];
    return ds.map((d) => {
      const scanned = latest.some((l) => l.domainId === d.id);
      const failing = checks.filter((c) => c.domainId === d.id && c.status === "fail");
      const ev = base();
      ev.checkIds = failing.map((c) => c.id);
      ev.observedValue = scanned ? failing.length : null;
      if (!scanned) ev.notes.push("No completed scan yet — not evaluated.");
      return {
        targetType: "domain" as const,
        targetId: d.id,
        targetLabel: d.name,
        status: !scanned ? ("no_data" as const) : compare(failing.length, rule.comparator, rule.threshold) ? ("triggered" as const) : ("ok" as const),
        observedValue: ev.observedValue,
        evidence: ev,
        message: !scanned ? `${d.name}: not scanned yet.` : failing.length ? `${d.name}: failing ${failing.map((c) => c.checkType.toUpperCase()).join(", ")}.` : `${d.name}: no failing checks.`,
      };
    });
  }

  const conns = await scopedConnections(rule);

  /* Connection-state rules: per mailbox. */
  if (rule.metric === "mailbox_connection_unhealthy" || rule.metric === "sync_stale") {
    const [orgRow] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, rule.orgId)).limit(1);
    const staleMs = (orgRow?.settings.syncStaleAfterHours ?? 2) * 3_600_000;
    return conns
      .filter((c) => c.state !== "demo" || rule.metric === "mailbox_connection_unhealthy")
      .map((c) => {
        const ev = base();
        ev.connectionIds = [c.id];
        let bad: boolean;
        let message: string;
        if (rule.metric === "mailbox_connection_unhealthy") {
          bad = c.state === "reauth_required" || c.consecutiveFailures >= 3;
          message = bad ? `${c.email}: ${c.state === "reauth_required" ? "re-authentication required" : `${c.consecutiveFailures} consecutive sync failures`}.` : `${c.email}: connection OK.`;
        } else {
          const syncing = ["connected", "degraded"].includes(c.state);
          bad = syncing && (!c.lastSuccessfulSyncAt || now.getTime() - c.lastSuccessfulSyncAt.getTime() > staleMs);
          message = bad ? `${c.email}: no successful sync since ${c.lastSuccessfulSyncAt?.toISOString() ?? "connection"}. Health is unknown.` : `${c.email}: data fresh or not syncing.`;
        }
        ev.observedValue = bad ? 1 : 0;
        return {
          targetType: "mailbox" as const,
          targetId: c.id,
          targetLabel: c.email,
          status: compare(ev.observedValue, rule.comparator, rule.threshold) ? ("triggered" as const) : ("ok" as const),
          observedValue: ev.observedValue,
          evidence: ev,
          message,
        };
      });
  }

  /* Event rules. Domain/mailbox scope aggregate; org scope evaluates per mailbox. */
  const stats = await eventStats(rule.orgId, conns.map((c) => c.id), since, now);
  const groups: Array<{ targetType: "mailbox" | "domain"; targetId: string; label: string; ids: string[] }> =
    rule.scopeType === "domain" && rule.scopeId
      ? [{ targetType: "domain", targetId: rule.scopeId, label: "domain mailboxes", ids: conns.map((c) => c.id) }]
      : conns.map((c) => ({ targetType: "mailbox" as const, targetId: c.id, label: c.email, ids: [c.id] }));

  const results: TargetEvaluation[] = [];
  for (const g of groups) {
    const sum = (cats: string[]) => g.ids.reduce((acc, id) => acc + cats.reduce((a, cat) => a + (stats.get(id)?.[cat] ?? 0), 0), 0);
    const ev = base();
    ev.connectionIds = g.ids;
    const numerator = sum(numeratorCategories(rule.metric));
    let value: number | null;
    let status: TargetEvaluation["status"];
    let message: string;
    let denominator: number | undefined;

    if (RATE_METRICS.has(rule.metric)) {
      denominator = sum(["sent"]);
      ev.numerator = numerator;
      ev.denominator = denominator;
      if (denominator < Math.max(1, rule.minSample)) {
        value = denominator > 0 ? numerator / denominator : null;
        status = "insufficient_data";
        message = `${g.label}: ${denominator} sent in window (minimum ${rule.minSample}) — not enough data to evaluate.`;
        ev.notes.push(`Minimum sample of ${rule.minSample} provider-recorded sends not met.`);
      } else {
        value = numerator / denominator;
        status = compare(value, rule.comparator, rule.threshold) ? "triggered" : "ok";
        message = `${g.label}: ${fmt(rule.metric, value)} (${numerator}/${denominator}) vs threshold ${fmt(rule.metric, rule.threshold)}.`;
      }
    } else {
      value = numerator;
      ev.numerator = numerator;
      if (rule.minSample > 0 && sum(["sent"]) < rule.minSample) {
        status = "insufficient_data";
        message = `${g.label}: fewer than ${rule.minSample} sends in window — not evaluated.`;
      } else {
        status = compare(value, rule.comparator, rule.threshold) ? "triggered" : "ok";
        message = `${g.label}: ${value} vs threshold ${rule.threshold}.`;
      }
    }
    ev.observedValue = value;
    if (status === "triggered") ev.sampleEventIds = await sampleEventIds(rule.orgId, g.ids, numeratorCategories(rule.metric), since, now);
    if (rule.metric === "complaint_count") ev.notes.push("Complaint visibility is partial: only feedback reports delivered to connected mailboxes are observable.");
    results.push({ targetType: g.targetType, targetId: g.targetId, targetLabel: g.label, status, observedValue: value, numerator, denominator, evidence: ev, message });
  }
  return results;
}

export function nextStepsFor(metric: AlertMetric): string[] {
  switch (metric) {
    case "bounce_rate":
    case "hard_bounce_rate":
      return [
        "Open the event timeline for this mailbox and look at which recipient domains are bouncing.",
        "Pause or slow sending from this mailbox in your sending tool while you investigate (QuikReach cannot do this unless a campaign integration is configured).",
        "Validate the recipient list and remove addresses that hard-bounced.",
        "Run a DNS scan of the sending domain to rule out authentication problems.",
      ];
    case "complaint_count":
      return ["Review the complaint reports' recipient domains.", "Check that unsubscribe links work and that the audience opted in.", "Reduce volume to the affected audience."];
    case "provider_error_count":
      return ["Open the event timeline to see the provider notices.", "If you hit a sending limit, reduce daily volume for this mailbox.", "Check the provider's admin console for account restrictions."];
    case "dns_check_failing":
      return ["Open the domain's latest scan and read the failing check's evidence and recommendation.", "Make the DNS change at your DNS host (QuikReach never edits DNS).", "Re-run the scan to record before/after results."];
    case "mailbox_connection_unhealthy":
      return ["Open Mailboxes and reconnect the mailbox.", "If the error mentions admin consent, ask your Google Workspace / Entra administrator to approve QuikReach."];
    case "sync_stale":
      return ["Check the mailbox's last sync error.", "Trigger a manual sync; if it keeps failing, reconnect the mailbox."];
    default:
      return ["Review the evidence attached to this alert."];
  }
}

type FullRule = typeof alertRules.$inferSelect;

/** Persist triggered evaluations as deduplicated alerts, notify, and request campaign actions where supported. */
export async function applyEvaluations(rule: FullRule, results: TargetEvaluation[], now = new Date()) {
  const [org] = await db.select({ automationPaused: organizations.automationPaused, isDemo: organizations.isDemo, settings: organizations.settings }).from(organizations).where(eq(organizations.id, rule.orgId)).limit(1);
  // Workspace-default recipients receive every new alert in addition to the rule's own recipients.
  const defaultEmails = org?.settings.defaultAlertEmails ?? [];
  const created: string[] = [];
  const updated: string[] = [];

  for (const r of results.filter((x) => x.status === "triggered")) {
    const dedupeKey = `${rule.id}:${r.targetType}:${r.targetId ?? "org"}`;
    // Cooldown: a recently resolved alert for the same key does not re-open yet.
    const cooldownStart = new Date(now.getTime() - rule.cooldownMinutes * 60_000);
    const [recentlyResolved] = await db
      .select({ id: alerts.id })
      .from(alerts)
      .where(and(eq(alerts.orgId, rule.orgId), eq(alerts.dedupeKey, dedupeKey), eq(alerts.status, "resolved"), gte(alerts.resolvedAt, cooldownStart)))
      .limit(1);
    if (recentlyResolved) continue;

    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(alerts)
        .where(and(eq(alerts.orgId, rule.orgId), eq(alerts.dedupeKey, dedupeKey), sql`${alerts.status} <> 'resolved'`))
        .limit(1);
      if (existing) {
        await tx
          .update(alerts)
          .set({ occurrences: existing.occurrences + 1, lastTriggeredAt: now, observedValue: r.observedValue, sampleSize: r.denominator ?? null, evidence: r.evidence })
          .where(eq(alerts.id, existing.id));
        updated.push(existing.id);
        return;
      }

      let actionOutcome: (typeof alerts.$inferInsert)["actionOutcome"] = "notify_only";
      const linked: Array<{ id: string; integrationId: string }> = [];
      if (rule.actionPolicy === "pause_campaigns") {
        const activeIntegrations = await tx
          .select({ id: integrations.id })
          .from(integrations)
          .where(and(eq(integrations.orgId, rule.orgId), eq(integrations.kind, "campaign_webhook"), eq(integrations.status, "active")));
        if (!activeIntegrations.length) {
          actionOutcome = "no_campaign_integration";
        } else if (org?.automationPaused) {
          actionOutcome = "notify_only";
          r.evidence.notes.push("Automation is paused for this organization; no campaign action was requested.");
        } else {
          const targetCond =
            r.targetType === "mailbox" && r.targetId
              ? eq(campaignReferences.mailboxConnectionId, r.targetId)
              : r.targetType === "domain" && r.targetId
                ? eq(campaignReferences.domainId, r.targetId)
                : sql`true`;
          const refs = await tx
            .select({ id: campaignReferences.id, integrationId: campaignReferences.integrationId })
            .from(campaignReferences)
            .where(and(eq(campaignReferences.orgId, rule.orgId), inArray(campaignReferences.integrationId, activeIntegrations.map((i) => i.id)), targetCond));
          linked.push(...refs);
          actionOutcome = refs.length ? "pause_requested" : "no_linked_campaigns";
        }
      }

      const title = `${rule.name} — ${r.targetLabel}`;
      const [alert] = await tx
        .insert(alerts)
        .values({
          orgId: rule.orgId,
          ruleId: rule.id,
          ruleVersion: rule.version,
          dedupeKey,
          severity: rule.severity,
          title,
          metric: rule.metric,
          observedValue: r.observedValue,
          threshold: rule.threshold,
          sampleSize: r.denominator ?? null,
          scopeType: r.targetType,
          scopeId: r.targetId,
          evidence: r.evidence,
          nextSteps: nextStepsFor(rule.metric),
          actionPolicy: rule.actionPolicy,
          actionOutcome,
          firstTriggeredAt: now,
          lastTriggeredAt: now,
          isDemo: org?.isDemo ?? false,
        })
        .returning();
      created.push(alert!.id);

      for (const ref of linked) {
        const idempotencyKey = `alert:${alert!.id}:pause:${ref.id}`;
        const [action] = await tx
          .insert(campaignActions)
          .values({ orgId: rule.orgId, campaignId: ref.id, action: "pause", requestedByType: "automation", alertId: alert!.id, reason: `Alert: ${title}`, idempotencyKey })
          .onConflictDoNothing()
          .returning({ id: campaignActions.id });
        if (action) {
          await enqueueJob({ type: "campaign.action", orgId: rule.orgId, payload: { actionId: action.id }, idempotencyKey: `campaign-action:${action.id}`, priority: 10 }, tx);
        }
      }

      // Notifications. In-app is delivered by being written; email/webhook go through the queue.
      const body = `${r.message} Severity: ${rule.severity}. ${
        actionOutcome === "no_campaign_integration"
          ? "This rule asks to pause campaigns, but no campaign integration is configured — QuikReach has NOT paused anything."
          : actionOutcome === "no_linked_campaigns"
            ? "No campaigns are linked to this mailbox/domain — nothing was paused."
            : actionOutcome === "pause_requested"
              ? `Pause requested for ${linked.length} linked campaign(s); awaiting confirmation from the sending system.`
              : "Monitor-only rule: no campaign action taken."
      }`;
      const targets = rule.notificationTargets;
      if (targets.inApp) {
        await tx.insert(notifications).values({ orgId: rule.orgId, alertId: alert!.id, channel: "in_app", target: "org", status: "sent", sentAt: now, title, body });
      }
      const emailTargets = [...new Set([...(targets.emails ?? []), ...defaultEmails].map((e) => e.trim().toLowerCase()).filter(Boolean))];
      for (const email of emailTargets) {
        const [n] = await tx
          .insert(notifications)
          .values({ orgId: rule.orgId, alertId: alert!.id, channel: "email", target: email, status: emailConfigured() ? "pending" : "not_configured", title, body })
          .returning({ id: notifications.id, status: notifications.status });
        if (n?.status === "pending") await enqueueJob({ type: "notification.deliver", orgId: rule.orgId, payload: { notificationId: n.id }, idempotencyKey: `notify:${n.id}` }, tx);
      }
      if (targets.webhookIntegrationId) {
        const [n] = await tx
          .insert(notifications)
          .values({ orgId: rule.orgId, alertId: alert!.id, channel: "webhook", target: targets.webhookIntegrationId, status: "pending", title, body })
          .returning({ id: notifications.id });
        await enqueueJob({ type: "notification.deliver", orgId: rule.orgId, payload: { notificationId: n!.id }, idempotencyKey: `notify:${n!.id}` }, tx);
      }

      await recordAudit(
        {
          orgId: rule.orgId,
          actor: automationActor(`alert-rule:${rule.name}`),
          action: "alert.triggered",
          targetType: "alert",
          targetId: alert!.id,
          outcome: "success",
          reason: r.message,
          metadata: { ruleId: rule.id, ruleVersion: rule.version, metric: rule.metric, observedValue: r.observedValue, threshold: rule.threshold, actionOutcome, campaignsRequested: linked.length },
        },
        tx,
      );
    });
  }
  return { created, updated };
}

/** Evaluate every enabled rule for an organisation (alerts.evaluate job). */
export async function evaluateOrgRules(orgId: string, now = new Date()) {
  const rules = await db.select().from(alertRules).where(and(eq(alertRules.orgId, orgId), eq(alertRules.enabled, true)));
  const summary = { rules: rules.length, triggered: 0, created: 0, updated: 0, insufficient: 0 };
  for (const rule of rules) {
    const results = await evaluateRule(rule, now);
    summary.triggered += results.filter((r) => r.status === "triggered").length;
    summary.insufficient += results.filter((r) => r.status === "insufficient_data").length;
    const applied = await applyEvaluations(rule, results, now);
    summary.created += applied.created.length;
    summary.updated += applied.updated.length;
  }
  return summary;
}

/** Exposed for the purge job. */
export async function deleteResolvedAlertsBefore(orgId: string, before: Date) {
  return db.delete(alerts).where(and(eq(alerts.orgId, orgId), eq(alerts.status, "resolved"), lt(alerts.resolvedAt, before))).returning({ id: alerts.id });
}
