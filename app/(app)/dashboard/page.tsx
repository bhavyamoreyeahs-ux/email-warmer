import Link from "next/link";
import { ArrowRight, CircleCheck, CircleDashed } from "lucide-react";
import { requirePage } from "@/lib/auth/page";
import { getOrgHealth, summarizeStates } from "@/lib/health/service";
import { listAlerts } from "@/lib/alerts/service";
import { searchAudit } from "@/lib/audit";
import { dailyEventSeries } from "@/lib/reports/summary";
import { can } from "@/lib/rbac";
import { Callout, Card, EmptyState, HealthPill, LinkButton, PageHeader, Pill, SeverityPill, Stat } from "@/components/ui/primitives";
import { BarChart, LineChart } from "@/components/ui/charts";
import { dateTime, HEALTH_LABEL, relativeTime } from "@/lib/ui/format";
import type { HealthState } from "@/lib/db/schema";

export const metadata = { title: "Dashboard" };

const tone = (s: HealthState) => (s === "healthy" ? "good" : s === "at_risk" ? "warn" : s === "critical" ? "bad" : "unknown") as "good" | "warn" | "bad" | "unknown";

export default async function DashboardPage() {
  const { principal } = await requirePage();
  const now = new Date();
  const [health, activeAlerts, series, recent] = await Promise.all([
    getOrgHealth(principal.orgId, now),
    listAlerts(principal.orgId, { status: "active", limit: 6 }),
    dailyEventSeries(principal.orgId, { from: new Date(now.getTime() - 14 * 86_400_000), to: now }),
    can(principal.role, "audit:view") ? searchAudit(principal.orgId, { limit: 6 }) : Promise.resolve(null),
  ]);

  const domainStates = summarizeStates(health.domains.map((d) => d.health.state));
  const mailboxStates = summarizeStates(health.mailboxes.map((m) => m.health.state));
  const verified = health.domains.filter((d) => d.verified).length;
  const missing = [...new Set([...health.domains.flatMap((d) => d.health.missing.map((m) => `${d.name}: ${m}`)), ...health.mailboxes.flatMap((m) => m.health.missing.map((x) => `${m.emailAddress}: ${x}`)), ...health.campaignSafety.missing])];

  const steps = [
    { done: health.domains.length > 0, label: "Add a sending domain", href: "/domains" },
    { done: verified > 0, label: "Verify domain ownership (DNS TXT record)", href: "/domains" },
    { done: health.domains.some((d) => d.lastScanAt), label: "Run a DNS authentication scan", href: "/domains" },
    { done: health.mailboxes.length > 0, label: "Connect a Google or Microsoft mailbox", href: "/mailboxes" },
    { done: health.mailboxes.some((m) => m.lastSuccessfulSyncAt), label: "Complete a first mailbox sync", href: "/mailboxes" },
  ];
  const setupDone = steps.every((s) => s.done);

  return (
    <>
      <PageHeader
        title="Dashboard"
        lede="Readiness across domain configuration, mailbox health and campaign safety. Each state expands into its inputs; unknown and stale data are never shown as healthy."
        meta={<span>Computed {dateTime(health.computedAt)} · rules {health.campaignSafety.ruleVersion}</span>}
      />

      {!setupDone ? (
        <Card title="Get set up" description="Complete these steps to start monitoring." className="mb-6">
          <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {steps.map((s, i) => (
              <li key={s.label}>
                <Link href={s.href} className="flex items-start gap-2 rounded-md p-2 text-sm hover:bg-canvas">
                  {s.done ? <CircleCheck aria-hidden className="mt-0.5 h-4 w-4 text-emerald-600" /> : <CircleDashed aria-hidden className="mt-0.5 h-4 w-4 text-stone-400" />}
                  <span className={s.done ? "text-muted line-through" : "text-ink"}>
                    {i + 1}. {s.label}
                    <span className="sr-only">{s.done ? " (done)" : " (to do)"}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Campaign safety" value={HEALTH_LABEL[health.campaignSafety.state]} tone={tone(health.campaignSafety.state)} hint={health.campaignSafety.inputs.find((i) => i.key === "safety.controls")?.detail} />
        <Stat label="Domains" value={`${health.domains.length}`} hint={`${verified} verified · ${domainStates.critical} critical · ${domainStates.at_risk} at risk · ${domainStates.unknown + domainStates.stale} unknown/stale`} />
        <Stat label="Mailboxes" value={`${health.mailboxes.length}`} hint={`${mailboxStates.healthy} healthy · ${mailboxStates.critical + mailboxStates.at_risk} need attention · ${mailboxStates.unknown + mailboxStates.stale} unknown/stale`} />
        <Stat label="Active alerts" value={activeAlerts.length} tone={activeAlerts.some((a) => a.severity === "critical") ? "bad" : activeAlerts.length ? "warn" : "neutral"} hint="Open or acknowledged" />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card title="Campaign safety" description="Why the state above is what it is" className="lg:col-span-1">
          <ul className="space-y-3">
            {health.campaignSafety.inputs.map((i) => (
              <li key={i.key} className="text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink">{i.label}</span>
                  {i.informational ? <Pill tone="info">Info</Pill> : <HealthPill state={i.state} />}
                </div>
                <p className="mt-0.5 text-xs text-muted">{i.detail}</p>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Active alerts" actions={<LinkButton href="/alerts" variant="ghost">All alerts <ArrowRight aria-hidden className="h-4 w-4" /></LinkButton>} className="lg:col-span-2" padded={false}>
          {activeAlerts.length ? (
            <ul className="divide-y divide-line">
              {activeAlerts.map((a) => (
                <li key={a.id}>
                  <Link href={`/alerts/${a.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-canvas">
                    <SeverityPill severity={a.severity} />
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">{a.title}</span>
                    {a.isDemo ? <Pill tone="demo">Demo</Pill> : null}
                    <span className="text-xs text-muted">{relativeTime(a.lastTriggeredAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No active alerts">Alert rules are evaluated every 5 minutes and after each sync or scan. No alerts is not proof of good deliverability — check data freshness below.</EmptyState>
          )}
        </Card>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Domain configuration" padded={false} actions={<LinkButton href="/domains" variant="ghost">Domains <ArrowRight aria-hidden className="h-4 w-4" /></LinkButton>}>
          {health.domains.length ? (
            <ul className="divide-y divide-line">
              {health.domains.map((d) => (
                <li key={d.id}>
                  <Link href={`/domains/${d.id}`} className="block px-4 py-3 hover:bg-canvas">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-ink">{d.name}</span>
                      <HealthPill state={d.health.state} />
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {d.health.inputs.filter((i) => i.key.startsWith("dns.") && i.key !== "dns.freshness").map((i) => (
                        <span key={i.key} className="text-xs text-muted">
                          {i.label.split(" ")[0]}: <span className="text-ink">{HEALTH_LABEL[i.state]}</span>
                        </span>
                      ))}
                      <span className="text-xs text-muted">· scanned {relativeTime(d.lastScanAt)}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No domains yet" action={<LinkButton href="/domains" variant="primary">Add a domain</LinkButton>}>Add the domain you send from to check MX, SPF, DKIM and DMARC.</EmptyState>
          )}
        </Card>
        <Card title="Mailbox health" padded={false} actions={<LinkButton href="/mailboxes" variant="ghost">Mailboxes <ArrowRight aria-hidden className="h-4 w-4" /></LinkButton>}>
          {health.mailboxes.length ? (
            <ul className="divide-y divide-line">
              {health.mailboxes.map((m) => {
                const br = m.health.inputs.find((i) => i.key === "mailbox.bounce_rate");
                return (
                  <li key={m.id}>
                    <Link href={`/mailboxes/${m.id}`} className="block px-4 py-3 hover:bg-canvas">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-ink">{m.emailAddress}</span>
                        <HealthPill state={m.health.state} />
                      </div>
                      <div className="mt-1 text-xs text-muted">
                        {br?.detail} · synced {m.isDemo ? "(demo)" : relativeTime(m.lastSuccessfulSyncAt)}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState title="No mailboxes connected" action={<LinkButton href="/mailboxes" variant="primary">Connect a mailbox</LinkButton>}>Connect Google Workspace or Microsoft 365 through OAuth. QuikReach never asks for mailbox passwords.</EmptyState>
          )}
        </Card>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Trend: provider-recorded sends" description="All connected mailboxes, last 14 days. Not proof of delivery.">
          <BarChart title="Sent per day (provider-recorded)" points={series.map((d) => ({ label: d.day, value: d.sent }))} />
        </Card>
        <Card title="Trend: observed bounce rate" description="Bounces ÷ sends per day. Days with fewer than 20 sends are shown as gaps (insufficient sample).">
          <LineChart
            title="Observed bounce rate per day"
            points={series.map((d) => ({ label: d.day, value: d.sent >= 20 ? d.bounceRate : null, note: `insufficient sample (${d.sent} sent)` }))}
            format="percent"
          />
        </Card>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Missing or limited data" description="What QuikReach cannot currently see">
          {missing.length ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
              {missing.slice(0, 12).map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No gaps reported.</p>
          )}
        </Card>
        <Card title="Recent changes" actions={recent ? <LinkButton href="/settings/audit" variant="ghost">Audit log <ArrowRight aria-hidden className="h-4 w-4" /></LinkButton> : undefined}>
          {recent ? (
            recent.rows.length ? (
              <ul className="space-y-2 text-sm">
                {recent.rows.map((r) => (
                  <li key={r.id} className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="text-ink">{r.action}</span> <span className="text-muted">by {r.actorLabel}</span>
                    </span>
                    <span className="whitespace-nowrap text-xs text-muted">{relativeTime(r.createdAt)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No changes recorded yet.</p>
            )
          ) : (
            <Callout tone="unknown">The audit log is visible to Owners and Administrators.</Callout>
          )}
        </Card>
      </div>
    </>
  );
}
