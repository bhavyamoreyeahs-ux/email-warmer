import Link from "next/link";
import { ArrowLeft, ArrowRight, Check, CircleCheckBig } from "lucide-react";
import { requirePage } from "@/lib/auth/page";
import { can } from "@/lib/rbac";
import { getAlertDetail } from "@/lib/alerts/service";
import { getRule } from "@/lib/alerts/rules";
import { METRIC_INFO } from "@/lib/alerts/schemas";
import { listDomains } from "@/lib/domains/service";
import { mailboxLabels } from "@/lib/mailboxes/service";
import { listCampaigns } from "@/lib/campaigns/service";
import { listIntegrations } from "@/lib/integrations/service";
import type { AlertMetric } from "@/lib/db/schema";
import { orNotFound, assertUuid } from "@/lib/ui/server";
import { Callout, Card, CheckPill, EmptyState, KeyValue, LinkButton, PageHeader, PermissionDenied, Pill, SeverityPill, Stat, Table, Td } from "@/components/ui/primitives";
import { ActionButton } from "@/components/ui/interactive";
import { DiagnoseButton } from "@/components/copilot/diagnose-form";
import { CATEGORY_LABEL, dateTime, relativeTime } from "@/lib/ui/format";
import {
  ACTION_OUTCOME,
  ACTION_POLICY_LABEL,
  ALERT_STATUS,
  CAMPAIGN_ACTION_STATUS,
  METRIC_EVENT_CATEGORIES,
  NOTIFICATION_CHANNEL,
  NOTIFICATION_STATUS,
  formatMetricValue,
  isRateMetric,
} from "@/components/alerts/alert-labels";

export const metadata = { title: "Alert" };

const NUMERATOR_LABEL: Partial<Record<AlertMetric, string>> = {
  bounce_rate: "bounces",
  hard_bounce_rate: "hard bounces",
  complaint_count: "complaint reports",
  provider_error_count: "provider errors and limit notices",
  sent_volume: "provider-recorded sends",
};

function eventsHref(params: Record<string, string | string[] | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => q.append(k, x));
    else if (v) q.set(k, v);
  }
  return `/events?${q.toString()}`;
}

export default async function AlertDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { principal, allowed } = await requirePage("alert:view");
  if (!allowed) {
    return (
      <>
        <PageHeader title="Alert" />
        <PermissionDenied permission="alert:view" />
      </>
    );
  }
  const id = assertUuid((await params).id);
  const { alert, events, checks, notifications, campaignActions } = await orNotFound(getAlertDetail(principal.orgId, id));
  const ev = alert.evidence;

  const canViewRules = can(principal.role, "alert_rule:view");
  const connectionIds = [...new Set([...ev.connectionIds, ...events.map((e) => e.connectionId), ...(alert.scopeType === "mailbox" && alert.scopeId ? [alert.scopeId] : [])])];
  const [rule, mailboxes, domains, campaigns, integrations] = await Promise.all([
    alert.ruleId && canViewRules ? getRule(principal.orgId, alert.ruleId).catch(() => null) : Promise.resolve(null),
    mailboxLabels(principal.orgId, connectionIds),
    listDomains(principal.orgId),
    campaignActions.length ? listCampaigns(principal.orgId) : Promise.resolve([]),
    notifications.some((n) => n.channel === "webhook") ? listIntegrations(principal.orgId) : Promise.resolve([]),
  ]);
  const domainName = new Map(domains.map((d) => [d.id, d.name]));
  const campaignName = new Map(campaigns.map((c) => [c.id, c.name]));
  const integrationName = new Map(integrations.map((i) => [i.id, i.name]));

  const metric = METRIC_INFO[alert.metric];
  const rate = isRateMetric(alert.metric);
  const outcome = ACTION_OUTCOME[alert.actionOutcome];
  const status = ALERT_STATUS[alert.status];
  const scopeLabel =
    alert.scopeType === "mailbox" && alert.scopeId
      ? (mailboxes.get(alert.scopeId) ?? "Removed mailbox")
      : alert.scopeType === "domain" && alert.scopeId
        ? (domainName.get(alert.scopeId) ?? "Deleted domain")
        : "Whole organization";
  const scopeHref = alert.scopeType === "mailbox" && alert.scopeId ? `/mailboxes/${alert.scopeId}` : alert.scopeType === "domain" && alert.scopeId ? `/domains/${alert.scopeId}` : null;
  const numeratorLabel = NUMERATOR_LABEL[alert.metric];
  const sampleText =
    ev.numerator !== undefined && ev.denominator !== undefined
      ? `${ev.numerator} ${numeratorLabel ?? "events"} of ${ev.denominator} provider-recorded sends`
      : ev.numerator !== undefined
        ? `${ev.numerator} ${numeratorLabel ?? "events"} counted`
        : null;
  const metricCategories = METRIC_EVENT_CATEGORIES[alert.metric];
  const matchingEventsHref = metricCategories
    ? eventsHref({
        connectionId: alert.scopeType === "mailbox" && alert.scopeId ? alert.scopeId : undefined,
        domainId: alert.scopeType === "domain" && alert.scopeId ? alert.scopeId : undefined,
        category: metricCategories,
        from: ev.window.start,
        to: ev.window.end,
      })
    : null;

  const canAck = alert.status === "open" && can(principal.role, "alert:acknowledge");
  const canResolve = alert.status !== "resolved" && can(principal.role, "alert:resolve");
  const canDiagnose = can(principal.role, "diagnostic:run");

  return (
    <>
      <Link href="/alerts" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft aria-hidden className="h-4 w-4" />
        All alerts
      </Link>
      <PageHeader
        title={alert.title}
        lede={`${metric.label}: ${metric.help}`}
        meta={
          <>
            <SeverityPill severity={alert.severity} />
            <Pill tone={status.tone}>{status.label}</Pill>
            {alert.isDemo ? <Pill tone="demo">Demo data</Pill> : null}
            <span>First triggered {dateTime(alert.firstTriggeredAt)}</span>
            <span>Last triggered {relativeTime(alert.lastTriggeredAt)}</span>
          </>
        }
        actions={
          canAck || canResolve || canDiagnose ? (
            <>
              {canAck ? <ActionButton label="Acknowledge" path={`/api/v1/alerts/${alert.id}/acknowledge`} successMessage="Alert acknowledged." icon={<Check aria-hidden className="h-4 w-4" />} /> : null}
              {canResolve ? (
                <ActionButton
                  label="Resolve"
                  path={`/api/v1/alerts/${alert.id}/resolve`}
                  variant="primary"
                  icon={<CircleCheckBig aria-hidden className="h-4 w-4" />}
                  successMessage="Alert resolved."
                  confirm={{
                    title: "Resolve this alert?",
                    description: (
                      <>
                        Describe what was done or why no action is needed. Resolving does not resume any campaign. The same rule will not re-open an alert for this target until its cooldown passes.
                      </>
                    ),
                    confirmLabel: "Resolve alert",
                    requireReason: true,
                    reasonField: "note",
                    reasonLabel: "Resolution note (required, recorded in the audit log)",
                  }}
                />
              ) : null}
              {canDiagnose ? <DiagnoseButton subjectType="alert" subjectId={alert.id} /> : null}
            </>
          ) : undefined
        }
      />

      {alert.isDemo ? (
        <div className="mb-4">
          <Callout tone="demo">This alert was produced from demo (sample) data, not from a live mailbox or domain.</Callout>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Observed" value={formatMetricValue(alert.metric, alert.observedValue)} tone={alert.observedValue === null ? "unknown" : alert.severity === "critical" ? "bad" : "warn"} hint="At the most recent trigger" />
        <Stat label="Threshold" value={alert.threshold === null ? "—" : formatMetricValue(alert.metric, alert.threshold)} hint={`Rule threshold when triggered${rate ? " (rate)" : ""}`} />
        <Stat
          label="Sample"
          value={ev.denominator !== undefined ? `${ev.numerator ?? "?"} / ${ev.denominator}` : ev.numerator !== undefined ? String(ev.numerator) : "n/a"}
          tone={ev.denominator === undefined && ev.numerator === undefined ? "unknown" : "neutral"}
          hint={sampleText ?? "This metric has no event sample (state or DNS based)."}
        />
        <Stat label="Occurrences" value={alert.occurrences} hint="Re-triggers update this alert instead of creating new ones" />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card title="Details" className="lg:col-span-2">
          <KeyValue
            items={[
              ["Severity", <SeverityPill key="s" severity={alert.severity} />],
              [
                "Status",
                <span key="st" className="flex flex-col gap-1">
                  <span>
                    <Pill tone={status.tone}>{status.label}</Pill>
                  </span>
                  {alert.acknowledgedAt ? <span className="text-xs text-muted">Acknowledged {dateTime(alert.acknowledgedAt)}</span> : null}
                  {alert.resolvedAt ? <span className="text-xs text-muted">Resolved {dateTime(alert.resolvedAt)}</span> : null}
                  {alert.resolutionNote ? <span className="text-xs text-ink">Note: {alert.resolutionNote}</span> : null}
                </span>,
              ],
              ["Metric", metric.label],
              ["Observed value", formatMetricValue(alert.metric, alert.observedValue)],
              ["Threshold", alert.threshold === null ? "—" : formatMetricValue(alert.metric, alert.threshold)],
              ["Sample size", sampleText ?? <span className="text-muted">Not applicable for this metric</span>],
              ["Window", `${dateTime(ev.window.start)} → ${dateTime(ev.window.end)}`],
              ["Target", scopeHref ? <Link key="t" href={scopeHref} className="underline underline-offset-2">{scopeLabel}</Link> : scopeLabel],
              ["Occurrences", alert.occurrences],
              ["First triggered", dateTime(alert.firstTriggeredAt)],
              ["Last triggered", dateTime(alert.lastTriggeredAt)],
              [
                "Rule",
                alert.ruleId === null ? (
                  <span key="r" className="text-muted">The rule has been deleted{alert.ruleVersion ? ` (was v${alert.ruleVersion})` : ""}.</span>
                ) : rule ? (
                  <span key="r">
                    <Link href={`/alerts/rules/${rule.id}`} className="underline underline-offset-2">
                      {rule.name}
                    </Link>{" "}
                    <span className="text-muted">
                      · v{alert.ruleVersion ?? "?"} when triggered{rule.version !== alert.ruleVersion ? ` (now v${rule.version})` : ""}
                    </span>
                  </span>
                ) : (
                  <span key="r" className="text-muted">Rule v{alert.ruleVersion ?? "?"}{canViewRules ? "" : " (your role cannot view rules)"}</span>
                ),
              ],
              [
                "Campaign action",
                <span key="ca" className="flex flex-col gap-1">
                  <span>
                    <Pill tone={outcome.tone}>{outcome.label}</Pill>
                  </span>
                  <span className="text-xs text-muted">
                    Policy: {ACTION_POLICY_LABEL[alert.actionPolicy]}. {outcome.detail}
                  </span>
                </span>,
              ],
            ]}
          />
        </Card>

        <Card title="Next steps" description="Suggested by QuikReach. Nothing here is done automatically.">
          {alert.nextSteps.length ? (
            <ol className="list-decimal space-y-2 pl-5 text-sm text-ink">
              {alert.nextSteps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted">No suggested steps recorded for this alert.</p>
          )}
        </Card>
      </div>

      <Card
        title="Evidence"
        description="What the rule saw at its most recent trigger."
        className="mt-6"
        actions={matchingEventsHref ? <LinkButton href={matchingEventsHref} variant="ghost">Matching events in window <ArrowRight aria-hidden className="h-4 w-4" /></LinkButton> : undefined}
      >
        <div className="space-y-6">
          <section aria-labelledby="ev-events">
            <h3 id="ev-events" className="text-xs font-medium uppercase tracking-[0.08em] text-muted">
              Sample events ({events.length})
            </h3>
            {events.length ? (
              <div className="mt-2 -mx-4">
                <Table caption="Sample events attached to this alert" head={["Occurred (UTC)", "Outcome", "Mailbox", "Recipient domain", "Confidence", ""]}>
                  {events.map((e) => (
                    <tr key={e.id}>
                      <Td className="whitespace-nowrap">{dateTime(e.occurredAt)}</Td>
                      <Td>
                        {CATEGORY_LABEL[e.category]}
                        {e.isDemo ? (
                          <span className="ml-1.5">
                            <Pill tone="demo">Demo</Pill>
                          </span>
                        ) : null}
                      </Td>
                      <Td className="break-words">{mailboxes.get(e.connectionId) ?? <span className="text-muted">Removed mailbox</span>}</Td>
                      <Td>{e.recipientDomain ?? <span className="text-muted">Not recorded</span>}</Td>
                      <Td className="capitalize">{e.confidence}</Td>
                      <Td>
                        <Link href={eventsHref({ connectionId: e.connectionId, category: e.category, from: ev.window.start, to: ev.window.end })} className="whitespace-nowrap text-sm underline underline-offset-2">
                          View in timeline<span className="sr-only"> ({CATEGORY_LABEL[e.category]} at {dateTime(e.occurredAt)})</span>
                        </Link>
                      </Td>
                    </tr>
                  ))}
                </Table>
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted">{metricCategories ? "No sample events were attached (they may have been removed by retention)." : "This metric is not based on events."}</p>
            )}
          </section>

          <section aria-labelledby="ev-checks">
            <h3 id="ev-checks" className="text-xs font-medium uppercase tracking-[0.08em] text-muted">
              DNS checks ({checks.length})
            </h3>
            {checks.length ? (
              <ul className="mt-2 divide-y divide-line rounded-md border border-line">
                {checks.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-start gap-3 px-3 py-2.5 text-sm">
                    <CheckPill status={c.status} />
                    <div className="min-w-0 flex-1">
                      <div className="text-ink">
                        {c.checkType.toUpperCase()} ·{" "}
                        <Link href={`/domains/${c.domainId}`} className="underline underline-offset-2">
                          {domainName.get(c.domainId) ?? "Domain"}
                        </Link>
                      </div>
                      <p className="mt-0.5 text-xs text-muted">{c.summary}</p>
                    </div>
                    <span className="whitespace-nowrap text-xs text-muted">Checked {dateTime(c.checkedAt)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted">{alert.metric === "dns_check_failing" ? "No check records attached (a newer scan may have replaced them)." : "Not applicable for this metric."}</p>
            )}
          </section>

          <section aria-labelledby="ev-conns">
            <h3 id="ev-conns" className="text-xs font-medium uppercase tracking-[0.08em] text-muted">
              Mailbox connections ({ev.connectionIds.length})
            </h3>
            {ev.connectionIds.length ? (
              <ul className="mt-2 flex flex-wrap gap-2">
                {ev.connectionIds.map((cid) => (
                  <li key={cid}>
                    {mailboxes.has(cid) ? (
                      <Link href={`/mailboxes/${cid}`} className="inline-block rounded-md border border-line px-2 py-1 text-sm text-ink hover:bg-canvas">
                        {mailboxes.get(cid)}
                      </Link>
                    ) : (
                      <span className="inline-block rounded-md border border-line px-2 py-1 font-mono text-xs text-muted" title="This mailbox connection no longer exists">
                        Removed · {cid.slice(0, 8)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted">No mailbox connections involved.</p>
            )}
          </section>

          <section aria-labelledby="ev-notes">
            <h3 id="ev-notes" className="text-xs font-medium uppercase tracking-[0.08em] text-muted">
              Notes
            </h3>
            {ev.notes.length ? (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink">
                {ev.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted">No evidence notes.</p>
            )}
          </section>
        </div>
      </Card>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Campaign actions" description="A campaign counts as paused only when the sending system confirms it." padded={false}>
          {campaignActions.length ? (
            <Table caption="Campaign actions requested for this alert" head={["Campaign", "Action", "Status", "Requested", "Completed"]}>
              {campaignActions.map((a) => {
                const s = CAMPAIGN_ACTION_STATUS[a.status];
                return (
                  <tr key={a.id}>
                    <Td>{campaignName.get(a.campaignId) ?? <span className="text-muted">Removed campaign</span>}</Td>
                    <Td className="capitalize">{a.action}</Td>
                    <Td>
                      <Pill tone={s.tone}>{a.action === "pause" ? s.pause : s.resume}</Pill>
                      {a.error ? <p className="mt-1 text-xs text-red-700">{a.error}</p> : null}
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-muted">
                      {dateTime(a.createdAt)}
                      <div>by {a.requestedByType === "automation" ? "automation" : "a user"}</div>
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-muted">{a.completedAt ? dateTime(a.completedAt) : "—"}</Td>
                  </tr>
                );
              })}
            </Table>
          ) : (
            <EmptyState title="No campaign actions">{outcome.detail}</EmptyState>
          )}
        </Card>

        <Card title="Notifications" description="Who was told about this alert, and whether delivery worked." padded={false}>
          {notifications.length ? (
            <Table caption="Notifications for this alert" head={["Channel", "Target", "Status", "Created", "Sent"]}>
              {notifications.map((n) => {
                const s = NOTIFICATION_STATUS[n.status];
                return (
                  <tr key={n.id}>
                    <Td>{NOTIFICATION_CHANNEL[n.channel]}</Td>
                    <Td className="break-words">
                      {n.channel === "in_app" ? "Everyone in this workspace" : n.channel === "webhook" ? (integrationName.get(n.target) ?? "Removed webhook") : n.target}
                    </Td>
                    <Td>
                      <Pill tone={s.tone}>{s.label}</Pill>
                      {n.status === "not_configured" ? <p className="mt-1 text-xs text-muted">This server has no outgoing email (SMTP) settings, so the email was recorded but never sent.</p> : null}
                      {n.lastError ? <p className="mt-1 text-xs text-red-700">{n.lastError}</p> : null}
                      {n.attempts > 1 ? <p className="mt-1 text-xs text-muted">{n.attempts} attempts</p> : null}
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-muted">{dateTime(n.createdAt)}</Td>
                    <Td className="whitespace-nowrap text-xs text-muted">{n.sentAt ? dateTime(n.sentAt) : "—"}</Td>
                  </tr>
                );
              })}
            </Table>
          ) : (
            <EmptyState title="No notifications">The rule had no notification targets when this alert was created.</EmptyState>
          )}
        </Card>
      </div>
    </>
  );
}
