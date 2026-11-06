import Link from "next/link";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { requirePage } from "@/lib/auth/page";
import { can } from "@/lib/rbac";
import { parseEventFilters, searchEvents, type EventFilters } from "@/lib/events/search";
import { listMailboxes } from "@/lib/mailboxes/service";
import { listDomains } from "@/lib/domains/service";
import { EVENT_CATEGORIES, PROVIDERS, type EventCategory } from "@/lib/db/schema";
import { Callout, Card, EmptyState, LinkButton, PageHeader, PermissionDenied, Pill, Table, Td, buttonStyles } from "@/components/ui/primitives";
import { CATEGORY_LABEL, PROVIDER_LABEL, dateTime } from "@/lib/ui/format";

export const metadata = { title: "Events" };

const PAGE_SIZE = 50;
const DAY_MS = 86_400_000;

type SearchParams = Record<string, string | string[] | undefined>;

const fieldCls = "mt-1 block w-full rounded-md border border-line bg-panel px-2.5 py-1.5 text-sm text-ink";
// One row from xl up (fields shrink); wraps on smaller screens.
const labelBase = "flex w-full min-w-0 flex-col text-xs font-medium text-muted sm:w-auto sm:min-w-[8rem] sm:flex-1";
const labelCls = `${labelBase} xl:min-w-0`;
const dateLabelCls = `${labelBase} xl:w-[8.25rem] xl:min-w-0 xl:flex-none`;

type Tone = "good" | "warn" | "bad" | "unknown" | "stale" | "info" | "demo";
const CATEGORY_TONE: Record<EventCategory, Tone> = {
  sent: "info",
  hard_bounce: "bad",
  soft_bounce: "warn",
  bounce_unclassified: "warn",
  complaint: "bad",
  unsubscribe: "info",
  reply: "info",
  auto_reply: "info",
  provider_error: "warn",
  sending_limit: "warn",
  unknown: "unknown",
};

const SOURCE_LABEL: Record<string, string> = { gmail_api: "Gmail API", graph_api: "Microsoft Graph", demo_seed: "Demo seed" };
const CONFIDENCE_LABEL: Record<string, string> = { high: "High", medium: "Medium", low: "Low" };

function toParams(sp: SearchParams): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else if (v !== undefined) p.append(k, v);
  }
  // z.coerce.boolean treats any non-empty string as true; only accept explicit opt-ins.
  const inc = p.get("includeSent");
  if (inc !== null && !["true", "1", "on"].includes(inc)) p.delete("includeSent");
  if (!p.get("limit")) p.set("limit", String(PAGE_SIZE));
  return p;
}

/** Serialise the parsed filters back to a query string, so pagination and the CSV export use exactly what the table used. */
function filterQuery(f: EventFilters, page?: { offset: number }): string {
  const q = new URLSearchParams();
  if (f.provider) q.set("provider", f.provider);
  if (f.domainId) q.set("domainId", f.domainId);
  if (f.connectionId) q.set("connectionId", f.connectionId);
  for (const c of f.category ?? []) q.append("category", c);
  if (f.from) q.set("from", f.from.toISOString());
  if (f.to) q.set("to", f.to.toISOString());
  if (f.includeSent) q.set("includeSent", "true");
  if (page) {
    if (f.limit !== PAGE_SIZE) q.set("limit", String(f.limit));
    if (page.offset > 0) q.set("offset", String(page.offset));
  }
  return q.toString();
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const isMidnight = (d: Date) => d.getTime() % DAY_MS === 0;

export default async function EventsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { principal, allowed } = await requirePage("event:view");
  if (!allowed) {
    return (
      <>
        <PageHeader title="Events" />
        <PermissionDenied permission="event:view" />
      </>
    );
  }

  const params = toParams(await searchParams);
  let filters: EventFilters;
  let invalidFilters = false;
  try {
    filters = parseEventFilters(params);
  } catch {
    invalidFilters = true;
    filters = parseEventFilters(new URLSearchParams({ limit: String(PAGE_SIZE) }));
  }

  const [{ rows, hasMore }, mailboxes, domains] = await Promise.all([searchEvents(principal.orgId, filters), listMailboxes(principal.orgId), listDomains(principal.orgId)]);

  const canExport = can(principal.role, "event:export");
  const selectedCategories = filters.category ?? [];
  const hasFilters = Boolean(filters.provider || filters.domainId || filters.connectionId || selectedCategories.length || filters.from || filters.to);
  const activeMailboxes = mailboxes.filter((m) => m.state !== "disconnected");
  const exportHref = `/api/v1/events/export${filterQuery(filters) ? `?${filterQuery(filters)}` : ""}`;
  const prevOffset = Math.max(0, filters.offset - filters.limit);
  const nextOffset = filters.offset + filters.limit;
  // Date inputs show whole UTC days. A link with an exact time widens to the surrounding days on resubmit, never narrows.
  const fromValue = filters.from ? day(filters.from) : "";
  const toValue = filters.to ? day(isMidnight(filters.to) ? filters.to : new Date(filters.to.getTime() + DAY_MS)) : "";

  return (
    <>
      <PageHeader
        title="Events"
        lede="Header-derived outcomes from connected mailboxes: bounces, complaint reports, replies, provider notices and (optionally) provider-recorded sends. No message bodies or recipient addresses are stored."
        meta={
          <>
            <span>
              {rows.length ? `Showing events ${filters.offset + 1}–${filters.offset + rows.length}` : "No events on this page"}
              {hasMore ? " (more available)" : ""}
            </span>
            {filters.from ? <span>From {dateTime(filters.from)}</span> : null}
            {filters.to ? <span>Before {dateTime(filters.to)}</span> : null}
            <span>{selectedCategories.length ? `${selectedCategories.length} outcome type(s) selected` : filters.includeSent ? "All outcomes, including provider-recorded sends" : "All outcomes except provider-recorded sends"}</span>
          </>
        }
      />

      <div className="mb-4">
        <Callout tone="unknown" title="Unknown outcome is not success">
          QuikReach cannot observe delivery to the inbox. &ldquo;Sent&rdquo; means the provider recorded an outbound message; it is not proof of delivery or inbox placement.
        </Callout>
      </div>

      {invalidFilters ? (
        <div className="mb-4">
          <Callout tone="warn" title="Some filters in the link were invalid">
            They were ignored and all events are shown. Choose filters again below.
          </Callout>
        </div>
      ) : null}

      <Card className="mb-4">
        <form method="get" action="/events" className="flex flex-wrap items-end gap-2 xl:flex-nowrap" aria-label="Filter events">
          <label className={labelCls}>
            Provider
            <select name="provider" defaultValue={filters.provider ?? ""} className={fieldCls}>
              <option value="">All</option>
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABEL[p] ?? p}
                </option>
              ))}
            </select>
          </label>
          <label className={labelCls}>
            Domain
            <select name="domainId" defaultValue={filters.domainId ?? ""} className={fieldCls}>
              <option value="">All</option>
              {domains.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className={labelCls}>
            Mailbox
            <select name="connectionId" defaultValue={filters.connectionId ?? ""} className={fieldCls}>
              <option value="">All</option>
              {mailboxes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.emailAddress}
                  {m.isDemo ? " (demo)" : m.state === "disconnected" ? " (disconnected)" : ""}
                </option>
              ))}
            </select>
          </label>
          <div className={labelCls}>
            <span id="outcome-filter-label">Outcome</span>
            <details className="relative mt-1">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-md border border-line bg-panel px-2.5 py-1.5 text-sm font-normal text-ink [&::-webkit-details-marker]:hidden" aria-describedby="outcome-filter-label">
                <span className="truncate">{selectedCategories.length ? `${selectedCategories.length} selected` : "All"}</span>
                <ChevronRight aria-hidden className="h-4 w-4 rotate-90 text-muted" />
              </summary>
              <div className="absolute left-0 z-20 mt-1 w-72 max-w-[calc(100vw-48px)] rounded-md border border-line bg-panel p-3 shadow-lg">
                <fieldset>
                  <legend className="mb-1 text-xs font-medium text-muted">Show only these outcomes (none ticked = all)</legend>
                  {EVENT_CATEGORIES.map((c) => (
                    <label key={c} className="flex items-center gap-2 py-1 text-sm font-normal text-ink">
                      <input type="checkbox" name="category" value={c} defaultChecked={selectedCategories.includes(c)} className="h-4 w-4" />
                      {CATEGORY_LABEL[c]}
                    </label>
                  ))}
                </fieldset>
              </div>
            </details>
          </div>
          <label className={dateLabelCls}>
            From (UTC)
            <input type="date" name="from" defaultValue={fromValue} className={fieldCls} />
          </label>
          <label className={dateLabelCls}>
            Before (UTC)
            <input type="date" name="to" defaultValue={toValue} className={fieldCls} aria-describedby="to-help" />
            <span id="to-help" className="sr-only">
              Exclusive: events on this day are not included.
            </span>
          </label>
          <label className="flex w-full items-center gap-2 py-1.5 text-xs font-medium text-ink sm:w-auto sm:max-w-[8rem] xl:flex-shrink-0">
            <input type="checkbox" name="includeSent" value="true" defaultChecked={Boolean(filters.includeSent)} className="h-4 w-4 flex-shrink-0" />
            Include provider-recorded sends
          </label>
          <div className="flex w-full gap-2 sm:w-auto xl:flex-shrink-0">
            <button type="submit" className={buttonStyles.primary}>
              Apply
            </button>
            <Link href="/events" className={buttonStyles.ghost}>
              Reset
            </Link>
          </div>
        </form>
        <p className="mt-2 text-xs text-muted">Dates are UTC; &ldquo;Before&rdquo; excludes that day. Picking outcomes overrides the sends checkbox — tick &ldquo;Sent (provider-recorded)&rdquo; to see sends alongside them.</p>
      </Card>

      <Card
        title="Event timeline"
        description="Newest first. Classification is based on message headers and subjects and may be partial — see each row's basis and confidence."
        padded={false}
        actions={
          canExport ? (
            <a href={exportHref} className={buttonStyles.secondary} download>
              <Download aria-hidden className="h-4 w-4" />
              Export CSV
            </a>
          ) : undefined
        }
      >
        {canExport ? (
          <p className="border-b border-line px-4 py-2 text-xs text-muted">
            The export uses exactly the filters above (all pages, up to 50,000 rows). Every export is recorded in the audit log, and cells are escaped so spreadsheet apps never run them as formulas.
          </p>
        ) : null}

        {rows.length ? (
          <>
            <Table
              caption="Provider events matching the current filters"
              head={["Occurred (UTC)", "Outcome", "Mailbox", "Sending domain", "Recipient domain", "Confidence", "Classification basis", "Source", "Data"]}
            >
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap text-ink">
                    <span title={`Ingested ${dateTime(r.ingestedAt)}`}>{dateTime(r.occurredAt)}</span>
                  </Td>
                  <Td>
                    <Pill tone={CATEGORY_TONE[r.category]}>{CATEGORY_LABEL[r.category]}</Pill>
                  </Td>
                  <Td className="max-w-[14rem] break-words">
                    {r.mailbox ? (
                      <Link href={`/mailboxes/${r.connectionId}`} className="text-ink underline-offset-2 hover:underline">
                        {r.mailbox}
                      </Link>
                    ) : (
                      <span className="text-muted">Unknown mailbox</span>
                    )}
                  </Td>
                  <Td>{r.domain ?? <span className="text-muted">Not linked</span>}</Td>
                  <Td>{r.recipientDomain ?? <span className="text-muted">Not recorded</span>}</Td>
                  <Td className="whitespace-nowrap">{CONFIDENCE_LABEL[r.confidence] ?? r.confidence}</Td>
                  <Td className="max-w-[18rem] break-words text-xs text-muted">
                    {r.classificationBasis}
                    {r.diagnosticCode ? <div className="mt-0.5 font-mono text-ink">{r.diagnosticCode}</div> : null}
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-muted">{SOURCE_LABEL[r.source] ?? r.source}</Td>
                  <Td>{r.isDemo ? <Pill tone="demo">Demo</Pill> : <span className="text-xs text-muted">Live</span>}</Td>
                </tr>
              ))}
            </Table>
            <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
              <span className="text-xs text-muted">
                Events {filters.offset + 1}–{filters.offset + rows.length}
              </span>
              <div className="flex gap-2">
                {filters.offset > 0 ? (
                  <Link href={`/events?${filterQuery(filters, { offset: prevOffset })}`} className={buttonStyles.secondary} rel="prev">
                    <ChevronLeft aria-hidden className="h-4 w-4" />
                    Newer
                  </Link>
                ) : null}
                {hasMore ? (
                  <Link href={`/events?${filterQuery(filters, { offset: nextOffset })}`} className={buttonStyles.secondary} rel="next">
                    Older
                    <ChevronRight aria-hidden className="h-4 w-4" />
                  </Link>
                ) : null}
              </div>
            </nav>
          </>
        ) : !activeMailboxes.length ? (
          <EmptyState title="No mailboxes connected" action={<LinkButton href="/mailboxes" variant="primary">Connect a mailbox</LinkButton>}>
            Events come from connected Google Workspace or Microsoft 365 mailboxes.
            {mailboxes.length ? " All mailboxes in this workspace are disconnected, so no new events are being recorded." : " Connect one through OAuth to start recording outcomes."}
          </EmptyState>
        ) : filters.offset > 0 ? (
          <EmptyState title="No more events" action={<LinkButton href={`/events?${filterQuery(filters, { offset: 0 })}`}>Back to the first page</LinkButton>}>
            There are no events past this point for these filters.
          </EmptyState>
        ) : hasFilters ? (
          <EmptyState title="No events match these filters" action={<LinkButton href="/events">Clear filters</LinkButton>}>
            Nothing was recorded for this combination of provider, domain, mailbox, outcome and dates. This is not evidence of good delivery — try a wider date range.
          </EmptyState>
        ) : (
          <EmptyState title="No events recorded yet">
            Connected mailboxes have not reported bounces, replies or provider notices{filters.includeSent ? " or sends" : ""}.
            {filters.includeSent ? "" : " Provider-recorded sends are hidden by default — tick “Include provider-recorded sends” to see them."} Check each mailbox&rsquo;s last sync on the Mailboxes page.
          </EmptyState>
        )}
      </Card>
    </>
  );
}
