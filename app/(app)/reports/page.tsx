import Link from "next/link";
import { clsx } from "clsx";
import { Download } from "lucide-react";
import { requirePage } from "@/lib/auth/page";
import { dailyEventSeries, mailboxSummary, parseRange, periodCounts, type ReportRange } from "@/lib/reports/summary";
import { getUsageOverview } from "@/lib/usage/overview";
import { can } from "@/lib/rbac";
import { BarChart, LineChart } from "@/components/ui/charts";
import { buttonStyles, Callout, Card, ConnectionPill, EmptyState, KeyValue, PageHeader, PermissionDenied, Pill, Stat, Table, Td } from "@/components/ui/primitives";
import { inputCls } from "@/components/settings/fields";
import { dateTime, pct, PROVIDER_LABEL } from "@/lib/ui/format";

export const metadata = { title: "Reports & Usage" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PRESETS = [7, 30, 90] as const;
const DEFAULT_DAYS = 30;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const num = (n: number) => n.toLocaleString("en-US");

function parseDateInput(raw: string | undefined): Date | null {
  if (!raw || !DATE_RE.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Turns the GET form (from/to as whole UTC days, inclusive) or a quick range
 * (?days=7|30|90) into a half-open [from, to) range, then applies the shared
 * service-side validation (parseRange: from < to, max 366 days).
 */
function resolveRange(sp: Record<string, string | string[] | undefined>) {
  const tomorrow = new Date(startOfUtcDay(new Date()).getTime() + DAY_MS);
  const fromRaw = first(sp.from)?.trim() || undefined;
  const toRaw = first(sp.to)?.trim() || undefined;
  const explicit = Boolean(fromRaw || toRaw);
  let invalid = false;
  let preset: number | null = null;
  let from: Date;
  let to: Date;

  if (explicit) {
    const f = parseDateInput(fromRaw);
    const t = parseDateInput(toRaw);
    if ((fromRaw && !f) || (toRaw && !t)) invalid = true;
    to = t ? new Date(t.getTime() + DAY_MS) : tomorrow;
    from = f ?? new Date(to.getTime() - DEFAULT_DAYS * DAY_MS);
    if (from >= to) invalid = true;
  } else {
    const days = Number(first(sp.days));
    preset = (PRESETS as readonly number[]).includes(days) ? days : DEFAULT_DAYS;
    to = tomorrow;
    from = new Date(to.getTime() - preset * DAY_MS);
  }

  if (invalid) {
    preset = DEFAULT_DAYS;
    to = tomorrow;
    from = new Date(to.getTime() - DEFAULT_DAYS * DAY_MS);
  }

  const range = parseRange(new URLSearchParams({ from: from.toISOString(), to: to.toISOString() }));
  return { range, preset, invalid, truncated: range.from.getTime() > from.getTime() };
}

function exportHref(range: ReportRange, kind: "mailboxes" | "daily") {
  return `/api/v1/reports/export?${new URLSearchParams({ from: range.from.toISOString(), to: range.to.toISOString(), kind }).toString()}`;
}

type Meter = Awaited<ReturnType<typeof getUsageOverview>>["meters"][number];

function MeterRow({ meter }: { meter: Meter }) {
  if (meter.key === "inbox_tests") {
    return (
      <li className="py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-ink">{meter.label}</span>
          <Pill tone="unknown">Not available in this release</Pill>
        </div>
        <p className="mt-1 text-xs text-muted">QuikReach does not run inbox placement tests yet and shows no placement results. See the Roadmap.</p>
      </li>
    );
  }
  const limit = meter.limit;
  const ratio = limit > 0 ? Math.min(1, meter.used / limit) : 1;
  const atLimit = limit <= 0 || meter.used >= limit;
  const near = !atLimit && ratio >= 0.8;
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-ink">{meter.label}</span>
        <span className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-ink">
            {num(meter.used)} <span className="text-muted">of {num(limit)}</span>
          </span>
          {atLimit ? <Pill tone="bad">Limit reached</Pill> : near ? <Pill tone="warn">Near limit</Pill> : null}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${meter.label}: ${num(meter.used)} of ${num(limit)} used`}
        aria-valuemin={0}
        aria-valuemax={Math.max(limit, 1)}
        aria-valuenow={Math.min(meter.used, Math.max(limit, 1))}
        aria-valuetext={`${num(meter.used)} of ${num(limit)} (${Math.round(ratio * 100)}%)`}
        className="mt-2 h-2 w-full overflow-hidden rounded-full bg-stone-200"
      >
        <div className={clsx("h-full rounded-full", atLimit ? "bg-red-600" : near ? "bg-amber-500" : "bg-accent-600")} style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
      <p className="mt-1 text-xs text-muted">
        Period: {meter.period}
        {atLimit ? " · New usage of this kind is blocked until the period resets or the limit changes." : ""}
      </p>
    </li>
  );
}

export default async function ReportsPage({ searchParams }: { searchParams: SearchParams }) {
  const { principal, allowed } = await requirePage("report:view");
  const header = (
    <PageHeader
      title="Reports & Usage"
      lede="Observed activity for a period, built only from provider-recorded events and QuikReach's own checks. Counts are what QuikReach could see — not proof of delivery or inbox placement."
    />
  );
  if (!allowed) {
    return (
      <>
        {header}
        <PermissionDenied permission="report:view" />
      </>
    );
  }

  const sp = await searchParams;
  const { range, preset, invalid, truncated } = resolveRange(sp);
  const orgId = principal.orgId;
  const canExport = can(principal.role, "report:export");
  const canUsage = can(principal.role, "usage:view");

  const [counts, series, mailboxes, usage] = await Promise.all([
    periodCounts(orgId, range),
    dailyEventSeries(orgId, range),
    mailboxSummary(orgId, range),
    canUsage ? getUsageOverview(orgId) : Promise.resolve(null),
  ]);

  const lastDay = new Date(range.to.getTime() - 1);
  const spanDays = Math.round((range.to.getTime() - range.from.getTime()) / DAY_MS);
  const totalSent = series.reduce((s, d) => s + d.sent, 0);
  const notConfirmed = counts.campaignActions - counts.campaignActionsConfirmed;

  return (
    <>
      {header}

      <Card title="Period" description="Whole days in UTC. Both dates are included." className="mb-6">
        <form method="get" action="/reports" className="flex flex-wrap items-end gap-3">
          <label className="block text-sm">
            <span className="text-ink">From</span>
            <input type="date" name="from" defaultValue={isoDate(range.from)} className={inputCls} required />
          </label>
          <label className="block text-sm">
            <span className="text-ink">To</span>
            <input type="date" name="to" defaultValue={isoDate(lastDay)} className={inputCls} required />
          </label>
          <button type="submit" className={buttonStyles.primary}>
            Apply
          </button>
          <nav aria-label="Quick ranges" className="flex flex-wrap gap-1.5 sm:ml-2">
            {PRESETS.map((d) => (
              <Link key={d} href={`/reports?days=${d}`} aria-current={preset === d ? "page" : undefined} className={clsx(buttonStyles.ghost, preset === d && "bg-canvas text-ink ring-1 ring-inset ring-line")}>
                Last {d} days
              </Link>
            ))}
          </nav>
        </form>
        <p className="mt-3 text-xs text-muted">
          Showing {isoDate(range.from)} to {isoDate(lastDay)} ({spanDays} {spanDays === 1 ? "day" : "days"}, UTC).
        </p>
        {invalid ? (
          <div className="mt-3">
            <Callout tone="warn">That date range was not valid (the start must be on or before the end, as YYYY-MM-DD). Showing the last {DEFAULT_DAYS} days instead.</Callout>
          </div>
        ) : null}
        {truncated ? (
          <div className="mt-3">
            <Callout tone="info">Reports cover at most 366 days, so the start date was moved to {isoDate(range.from)}.</Callout>
          </div>
        ) : null}
        {canExport ? (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <span className="text-sm text-ink">Export this period as CSV:</span>
            <a href={exportHref(range, "mailboxes")} className={buttonStyles.secondary} download>
              <Download aria-hidden className="h-4 w-4" /> Per-mailbox summary
            </a>
            <a href={exportHref(range, "daily")} className={buttonStyles.secondary} download>
              <Download aria-hidden className="h-4 w-4" /> Daily series
            </a>
            <span className="text-xs text-muted">Exports are recorded in the audit log.</span>
          </div>
        ) : null}
      </Card>

      <h2 className="sr-only">Period counts</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Alerts raised" value={num(counts.alerts)} hint="First triggered in this period" tone={counts.alerts ? "warn" : "neutral"} />
        <Stat label="Critical alerts" value={num(counts.criticalAlerts)} hint="Subset of alerts raised" tone={counts.criticalAlerts ? "bad" : "neutral"} />
        <Stat label="DNS scans completed" value={num(counts.scans)} hint="MX, SPF, DKIM and DMARC checks" />
        <Stat label="Campaign actions requested" value={num(counts.campaignActions)} hint="Pause/resume requests sent to a linked sending system" />
        <Stat
          label="Campaign actions confirmed"
          value={num(counts.campaignActionsConfirmed)}
          hint={counts.campaignActions ? `${num(notConfirmed)} not confirmed by the sending system (pending, unconfirmed or failed)` : "Only confirmed actions count as done"}
          tone={notConfirmed > 0 ? "warn" : "neutral"}
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Provider-recorded sends per day" description="All connected mailboxes. A send recorded by the provider is not proof of delivery.">
          {totalSent > 0 ? (
            <BarChart title="Sent per day (provider-recorded)" points={series.map((d) => ({ label: d.day, value: d.sent }))} format="count" />
          ) : (
            <EmptyState title="No sends recorded in this period">Either nothing was sent, or no mailbox synced during this period. Check coverage in the table below.</EmptyState>
          )}
        </Card>
        <Card title="Observed bounce rate per day" description="Bounces ÷ sends. Days with fewer than 20 sends are gaps (insufficient sample), never zero.">
          {series.some((d) => d.sent >= 20) ? (
            <LineChart
              title="Observed bounce rate per day"
              points={series.map((d) => ({ label: d.day, value: d.sent >= 20 ? d.bounceRate : null, note: `Insufficient sample (${d.sent} sent)` }))}
              format="percent"
            />
          ) : (
            <EmptyState title="Not enough data for a bounce rate">No day in this period had 20 or more provider-recorded sends.</EmptyState>
          )}
        </Card>
      </div>

      <Card title="Per-mailbox summary" description={`${isoDate(range.from)} to ${isoDate(lastDay)} (UTC)`} className="mt-6" padded={false}>
        {mailboxes.length ? (
          <>
            <Table
              caption="Per-mailbox activity in the selected period"
              head={["Mailbox", "Sent", "Bounces", "Hard bounces", "Bounce rate", "Replies", "Complaints (partial visibility)", "Unsubscribes", "Provider errors", "Coverage"]}
            >
              {mailboxes.map((m) => (
                <tr key={m.id}>
                  <Td>
                    <div className="font-medium text-ink">{m.email}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-muted">{PROVIDER_LABEL[m.provider] ?? m.provider}</span>
                      <ConnectionPill state={m.state} />
                      {m.isDemo ? <Pill tone="demo">Demo</Pill> : null}
                    </div>
                  </Td>
                  <Td className="tabular-nums">{num(m.sent)}</Td>
                  <Td className="tabular-nums">{num(m.bounces)}</Td>
                  <Td className="tabular-nums">{num(m.hardBounces)}</Td>
                  <Td>{m.bounceRate !== null ? <span className="tabular-nums">{pct(m.bounceRate, 1)}</span> : <Pill tone="unknown">{m.bounceRateNote ?? `Insufficient sample (${m.sent} sent)`}</Pill>}</Td>
                  <Td className="tabular-nums">{num(m.replies)}</Td>
                  <Td className="tabular-nums">{num(m.complaints)}</Td>
                  <Td className="tabular-nums">{num(m.unsubscribes)}</Td>
                  <Td className="tabular-nums">{num(m.providerErrors)}</Td>
                  <Td>
                    {m.successfulSyncsInPeriod === null ? (
                      <Pill tone="demo">Demo data</Pill>
                    ) : m.successfulSyncsInPeriod === 0 ? (
                      <Pill tone="warn" title="Zero counts for this mailbox mean 'not observed', not 'did not happen'.">
                        No successful sync in period
                      </Pill>
                    ) : (
                      <span className="text-sm text-ink">
                        {num(m.successfulSyncsInPeriod)} successful {m.successfulSyncsInPeriod === 1 ? "sync" : "syncs"}
                      </span>
                    )}
                    <div className="mt-1 text-xs text-muted">Last sync {m.isDemo ? "(demo)" : dateTime(m.lastSync)}</div>
                  </Td>
                </tr>
              ))}
            </Table>
            <div className="space-y-1 border-t border-line px-4 py-3 text-xs text-muted">
              <p>Coverage counts successful (or partial) syncs that started in the period. A mailbox with no successful sync shows zeros because nothing was observed — unknown is not zero.</p>
              <p>Complaints: mailbox providers surface only some complaint (spam) reports, so this is a lower bound, not a complaint rate.</p>
            </div>
          </>
        ) : (
          <EmptyState title="No mailboxes connected">Connect a Google or Microsoft mailbox to see per-mailbox activity.</EmptyState>
        )}
      </Card>

      <section aria-labelledby="usage-heading" className="mt-8">
        <h2 id="usage-heading" className="text-lg font-medium tracking-tighter text-ink">
          Usage &amp; quota
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">Current usage against this workspace&apos;s plan limits.</p>
        <div className="mt-4">
          {usage ? (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <Card title="Plan" className="lg:col-span-1">
                <KeyValue
                  items={[
                    ["Plan", <span key="p" className="capitalize">{usage.plan}</span>],
                    ["Status", <Pill key="s" tone={usage.status === "active" ? "good" : "bad"}>{usage.status === "active" ? "Active" : usage.status === "expired" ? "Expired" : "Suspended"}</Pill>],
                    ["Valid until", usage.validUntil ? dateTime(usage.validUntil) : "No end date"],
                  ]}
                />
                <div className="mt-4">
                  <Callout tone="info" title="Limits are placeholders">
                    {usage.note} QuikReach does not bill: when a limit is reached it stops (for example, it will not run another scan) instead of charging.
                  </Callout>
                </div>
              </Card>
              <Card title="Meters" className="lg:col-span-2">
                <ul className="divide-y divide-line">
                  {usage.meters.map((m) => (
                    <MeterRow key={m.key} meter={m} />
                  ))}
                </ul>
              </Card>
            </div>
          ) : (
            <PermissionDenied permission="usage:view" />
          )}
        </div>
      </section>
    </>
  );
}
