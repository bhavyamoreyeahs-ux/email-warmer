import Link from "next/link";
import { clsx } from "clsx";
import { Plus } from "lucide-react";
import { requirePage } from "@/lib/auth/page";
import { can } from "@/lib/rbac";
import { listAlerts } from "@/lib/alerts/service";
import { listRules } from "@/lib/alerts/rules";
import { METRIC_INFO } from "@/lib/alerts/schemas";
import { listIntegrations } from "@/lib/integrations/service";
import { listDomains } from "@/lib/domains/service";
import { listMailboxes } from "@/lib/mailboxes/service";
import { Callout, Card, EmptyState, LinkButton, PageHeader, PermissionDenied, Pill, SeverityPill, Table, Td } from "@/components/ui/primitives";
import { dateTime, relativeTime } from "@/lib/ui/format";
import { ACTION_OUTCOME, ACTION_POLICY_LABEL, ALERT_STATUS, COMPARATOR_SYMBOL, formatMetricValue, formatWindow, isRateMetric } from "@/components/alerts/alert-labels";

export const metadata = { title: "Alerts & rules" };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function AlertsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { principal, allowed } = await requirePage("alert:view");
  if (!allowed) {
    return (
      <>
        <PageHeader title="Alerts & rules" />
        <PermissionDenied permission="alert:view" />
      </>
    );
  }

  const sp = await searchParams;
  const status: "active" | "resolved" = sp.status === "resolved" ? "resolved" : "active";
  const canViewRules = can(principal.role, "alert_rule:view");
  const canManageRules = can(principal.role, "alert_rule:manage");

  const [alerts, rules, integrations, domains, mailboxes] = await Promise.all([
    listAlerts(principal.orgId, { status, limit: 200 }),
    canViewRules ? listRules(principal.orgId) : Promise.resolve(null),
    listIntegrations(principal.orgId),
    listDomains(principal.orgId),
    listMailboxes(principal.orgId),
  ]);

  const campaignIntegrationActive = integrations.some((i) => i.kind === "campaign_webhook" && i.status === "active");
  const domainName = new Map(domains.map((d) => [d.id, d.name]));
  const mailboxName = new Map(mailboxes.map((m) => [m.id, m.emailAddress]));
  const scopeLabel = (type: string, id: string | null) =>
    type === "organization" || !id ? "Whole organization" : type === "domain" ? (domainName.get(id) ?? "Deleted domain") : (mailboxName.get(id) ?? "Removed mailbox");

  const tabs = [
    { key: "active", label: "Active", href: "/alerts" },
    { key: "resolved", label: "Resolved", href: "/alerts?status=resolved" },
  ] as const;

  return (
    <>
      <PageHeader
        title="Alerts & rules"
        lede="Alerts are raised by rules evaluated every 5 minutes and after each sync or scan. Rate rules never fire below their minimum sample — too little data is reported as insufficient, not as healthy."
        actions={canManageRules ? <LinkButton href="/alerts/rules/new" variant="primary"><Plus aria-hidden className="h-4 w-4" />New rule</LinkButton> : undefined}
      />

      {!campaignIntegrationActive ? (
        <div className="mb-6">
          <Callout tone="warn" title="QuikReach can alert but cannot pause campaigns — no campaign integration is configured.">
            Rules set to pause campaigns will notify only and record &ldquo;Not paused&rdquo;.{" "}
            {can(principal.role, "integration:view") ? (
              <Link href="/integrations" className="font-medium underline underline-offset-2">
                Set up a campaign integration
              </Link>
            ) : (
              "Ask an Administrator to set up a campaign integration."
            )}
          </Callout>
        </div>
      ) : null}

      <section aria-labelledby="alerts-heading" className="mb-8">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <h2 id="alerts-heading" className="text-lg font-medium tracking-tighter text-ink">
            Alerts
          </h2>
          <nav aria-label="Alert status" className="inline-flex rounded-md border border-line bg-panel p-0.5">
            {tabs.map((t) => (
              <Link
                key={t.key}
                href={t.href}
                aria-current={status === t.key ? "page" : undefined}
                className={clsx("rounded px-3 py-1 text-sm font-medium", status === t.key ? "bg-ink text-white" : "text-muted hover:bg-canvas hover:text-ink")}
              >
                {t.label}
              </Link>
            ))}
          </nav>
        </div>
        <Card padded={false}>
          {alerts.length ? (
            <Table
              caption={status === "active" ? "Open and acknowledged alerts" : "Resolved alerts"}
              head={["Severity", "Alert", "Metric", "Observed vs threshold", "Sample", "Campaign action", "Occurrences", status === "active" ? "Last triggered" : "Resolved"]}
            >
              {alerts.map((a) => (
                <tr key={a.id}>
                  <Td>
                    <SeverityPill severity={a.severity} />
                  </Td>
                  <Td className="min-w-[14rem]">
                    <Link href={`/alerts/${a.id}`} className="font-medium text-ink underline-offset-2 hover:underline">
                      {a.title}
                    </Link>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <Pill tone={ALERT_STATUS[a.status].tone}>{ALERT_STATUS[a.status].label}</Pill>
                      {a.isDemo ? <Pill tone="demo">Demo</Pill> : null}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap">{METRIC_INFO[a.metric].label}</Td>
                  <Td className="whitespace-nowrap">
                    <span className="font-medium text-ink">{formatMetricValue(a.metric, a.observedValue)}</span>
                    <span className="text-muted"> vs {a.threshold === null ? "—" : formatMetricValue(a.metric, a.threshold)}</span>
                  </Td>
                  <Td className="whitespace-nowrap">
                    {isRateMetric(a.metric) ? (a.sampleSize === null ? <span className="text-muted">Unknown</span> : `${a.sampleSize} sent`) : <span className="text-muted">n/a</span>}
                  </Td>
                  <Td>
                    <Pill tone={ACTION_OUTCOME[a.actionOutcome].tone} title={ACTION_OUTCOME[a.actionOutcome].detail}>
                      {ACTION_OUTCOME[a.actionOutcome].label}
                    </Pill>
                  </Td>
                  <Td className="text-right tabular-nums">{a.occurrences}</Td>
                  <Td className="whitespace-nowrap text-xs text-muted">
                    {status === "active" ? (
                      <span title={dateTime(a.lastTriggeredAt)}>{relativeTime(a.lastTriggeredAt)}</span>
                    ) : (
                      <span title={dateTime(a.resolvedAt)}>{relativeTime(a.resolvedAt)}</span>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          ) : status === "active" ? (
            <EmptyState title="No active alerts">
              No rule is currently over its threshold. That is not proof of good deliverability: rules only see data from connected mailboxes and scanned domains, and stale data is flagged separately.
            </EmptyState>
          ) : (
            <EmptyState title="No resolved alerts">Resolved alerts appear here with their resolution note.</EmptyState>
          )}
        </Card>
      </section>

      <section aria-labelledby="rules-heading">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="rules-heading" className="text-lg font-medium tracking-tighter text-ink">
              Rules
            </h2>
            <p className="mt-0.5 text-xs text-muted">Every change creates a new version and is recorded in the audit log.</p>
          </div>
          {canManageRules ? (
            <LinkButton href="/alerts/rules/new">
              <Plus aria-hidden className="h-4 w-4" />
              New rule
            </LinkButton>
          ) : null}
        </div>
        <Card padded={false}>
          {rules === null ? (
            <div className="p-4">
              <Callout tone="unknown">Your role cannot view alert rules.</Callout>
            </div>
          ) : rules.length ? (
            <Table caption="Alert rules" head={["Rule", "Metric", "Threshold", "Window", "Min sample", "Severity", "Action policy", "Status", "Version"]}>
              {rules.map((r) => (
                <tr key={r.id}>
                  <Td className="min-w-[12rem]">
                    <Link href={`/alerts/rules/${r.id}`} className="font-medium text-ink underline-offset-2 hover:underline">
                      {r.name}
                    </Link>
                    <div className="mt-0.5 text-xs text-muted">
                      {scopeLabel(r.scopeType, r.scopeId)} · <Link href={`/alerts/rules/${r.id}`} className="underline underline-offset-2">{canManageRules ? "Edit" : "View"}<span className="sr-only"> {r.name}</span></Link>
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap">{METRIC_INFO[r.metric].label}</Td>
                  <Td className="whitespace-nowrap">
                    {COMPARATOR_SYMBOL[r.comparator]} {formatMetricValue(r.metric, r.threshold)}
                  </Td>
                  <Td className="whitespace-nowrap">{formatWindow(r.windowMinutes)}</Td>
                  <Td className="whitespace-nowrap">{r.minSample > 0 ? `${r.minSample} sent` : <span className="text-muted">None</span>}</Td>
                  <Td>
                    <SeverityPill severity={r.severity} />
                  </Td>
                  <Td>
                    <div className="whitespace-nowrap">{ACTION_POLICY_LABEL[r.actionPolicy]}</div>
                    {r.actionPolicy === "pause_campaigns" && !campaignIntegrationActive ? (
                      <div className="mt-1">
                        <Pill tone="unknown">Unavailable — no campaign integration</Pill>
                      </div>
                    ) : null}
                  </Td>
                  <Td>{r.enabled ? <Pill tone="good">Enabled</Pill> : <Pill tone="unknown">Disabled</Pill>}</Td>
                  <Td className="whitespace-nowrap tabular-nums">v{r.version}</Td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title="No rules yet" action={canManageRules ? <LinkButton href="/alerts/rules/new" variant="primary">Create a rule</LinkButton> : undefined}>
              Without rules, QuikReach records events and DNS results but raises no alerts.
            </EmptyState>
          )}
        </Card>
      </section>
    </>
  );
}
