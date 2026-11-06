import Link from "next/link";
import { ChevronLeft, ChevronRight, FileJson } from "lucide-react";
import { requirePage } from "@/lib/auth/page";
import { searchAudit } from "@/lib/audit";
import { buttonStyles, Card, EmptyState, KeyValue, PageHeader, PermissionDenied, Pill, Table, Td } from "@/components/ui/primitives";
import { EvidenceDrawer } from "@/components/ui/interactive";
import { SettingsNav } from "@/components/settings/settings-nav";
import { inputCls } from "@/components/settings/fields";
import { dateTime, relativeTime } from "@/lib/ui/format";

export const metadata = { title: "Audit log" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type Tone = React.ComponentProps<typeof Pill>["tone"];
type AuditRow = Awaited<ReturnType<typeof searchAudit>>["rows"][number];

const PAGE_SIZE = 50;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const OUTCOMES = ["success", "failure", "denied", "pending"] as const;
type Outcome = (typeof OUTCOMES)[number];

const OUTCOME_PILL: Record<Outcome, { tone: Tone; label: string }> = {
  success: { tone: "good", label: "Success" },
  failure: { tone: "bad", label: "Failure" },
  denied: { tone: "warn", label: "Denied" },
  pending: { tone: "info", label: "Pending" },
};

const ACTOR_PILL: Record<AuditRow["actorType"], { tone: Tone; label: string }> = {
  user: { tone: "unknown", label: "User" },
  automation: { tone: "info", label: "Automation" },
  system: { tone: "stale", label: "System" },
};

function first(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() || undefined;
}

function isOutcome(v: string | undefined): v is Outcome {
  return (OUTCOMES as readonly string[]).includes(v ?? "");
}

function dateParam(raw: string | undefined, endOfDay: boolean): Date | undefined {
  if (!raw || !DATE_RE.test(raw)) return undefined;
  const d = new Date(`${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export default async function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  const { principal, allowed } = await requirePage("audit:view");
  const header = (
    <PageHeader
      title="Audit log"
      lede="Who changed what, when, why and with what outcome — for people, automation and the system. Metadata is redacted so secrets are never stored here."
    />
  );
  if (!allowed) {
    return (
      <>
        {header}
        <SettingsNav role={principal.role} />
        <PermissionDenied permission="audit:view" />
      </>
    );
  }

  const sp = await searchParams;
  const q = first(sp.q)?.slice(0, 200);
  const action = first(sp.action)?.slice(0, 100);
  const outcomeRaw = first(sp.outcome);
  const outcome = isOutcome(outcomeRaw) ? outcomeRaw : undefined;
  const fromRaw = first(sp.from);
  const toRaw = first(sp.to);
  const from = dateParam(fromRaw, false);
  const to = dateParam(toRaw, true);
  const page = Math.min(1000, Math.max(1, Number.parseInt(first(sp.page) ?? "1", 10) || 1));

  const { rows, hasMore } = await searchAudit(principal.orgId, { q, action, outcome, from, to, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const filtered = Boolean(q || action || outcome || from || to);

  const pageHref = (p: number) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (action) params.set("action", action);
    if (outcome) params.set("outcome", outcome);
    if (from && fromRaw) params.set("from", fromRaw);
    if (to && toRaw) params.set("to", toRaw);
    if (p > 1) params.set("page", String(p));
    const s = params.toString();
    return s ? `/settings/audit?${s}` : "/settings/audit";
  };

  return (
    <>
      {header}
      <SettingsNav role={principal.role} />

      <Card title="Search" className="mb-6">
        <form method="get" action="/settings/audit" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1.5fr_1fr_1fr_1fr_auto] lg:items-end">
          <label className="block text-sm">
            <span className="text-ink">Text</span>
            <input type="search" name="q" defaultValue={q ?? ""} maxLength={200} placeholder="Actor, action, target type or reason" className={inputCls} />
          </label>
          <label className="block text-sm">
            <span className="text-ink">Exact action</span>
            <input name="action" defaultValue={action ?? ""} maxLength={100} placeholder="e.g. member.role.update" spellCheck={false} className={inputCls} />
          </label>
          <label className="block text-sm">
            <span className="text-ink">Outcome</span>
            <select name="outcome" defaultValue={outcome ?? ""} className={inputCls}>
              <option value="">Any</option>
              {OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {OUTCOME_PILL[o].label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-ink">From (UTC)</span>
            <input type="date" name="from" defaultValue={from ? fromRaw : ""} className={inputCls} />
          </label>
          <label className="block text-sm">
            <span className="text-ink">To (UTC)</span>
            <input type="date" name="to" defaultValue={to ? toRaw : ""} className={inputCls} />
          </label>
          <div className="flex gap-2">
            <button type="submit" className={buttonStyles.primary}>
              Search
            </button>
            {filtered ? (
              <Link href="/settings/audit" className={buttonStyles.ghost}>
                Clear
              </Link>
            ) : null}
          </div>
        </form>
      </Card>

      <Card title="Entries" description={`Page ${page} · newest first · ${PAGE_SIZE} per page`} padded={false}>
        {rows.length ? (
          <Table caption="Audit log entries" head={["Time", "Actor", "Action", "Target", "Outcome", "Reason", "Request ID", "Details"]}>
            {rows.map((r) => {
              const actor = ACTOR_PILL[r.actorType];
              const out = OUTCOME_PILL[r.outcome];
              const hasMetadata = Object.keys(r.metadata ?? {}).length > 0;
              return (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap">
                    <div className="text-ink">{dateTime(r.createdAt)}</div>
                    <div className="text-xs text-muted">{relativeTime(r.createdAt)}</div>
                  </Td>
                  <Td>
                    <div className="break-all text-ink">{r.actorLabel}</div>
                    <div className="mt-1">
                      <Pill tone={actor.tone}>{actor.label}</Pill>
                    </div>
                  </Td>
                  <Td className="font-mono text-xs text-ink">{r.action}</Td>
                  <Td>
                    <div className="text-ink">{r.targetType}</div>
                    {r.targetId ? (
                      <div className="max-w-[12rem] truncate font-mono text-xs text-muted" title={r.targetId}>
                        {r.targetId}
                      </div>
                    ) : null}
                  </Td>
                  <Td>
                    <Pill tone={out.tone}>{out.label}</Pill>
                  </Td>
                  <Td className="max-w-xs break-words text-xs">{r.reason ?? <span className="text-muted">—</span>}</Td>
                  <Td>
                    {r.requestId ? (
                      <span className="block max-w-[10rem] truncate font-mono text-xs text-muted" title={r.requestId}>
                        {r.requestId}
                      </span>
                    ) : (
                      <span className="text-xs text-muted">—</span>
                    )}
                  </Td>
                  <Td>
                    <EvidenceDrawer
                      title={`Audit entry: ${r.action}`}
                      trigger={
                        <button type="button" className={buttonStyles.ghost} aria-label={`Details for ${r.action} at ${dateTime(r.createdAt)}`}>
                          <FileJson aria-hidden className="h-4 w-4" />
                          {hasMetadata ? "Metadata" : "Details"}
                        </button>
                      }
                    >
                      <KeyValue
                        items={[
                          ["Entry ID", <code key="id" className="break-all text-xs">{r.id}</code>],
                          ["Time", dateTime(r.createdAt)],
                          ["Actor", `${r.actorLabel} (${actor.label.toLowerCase()})`],
                          ["Action", <code key="a" className="text-xs">{r.action}</code>],
                          ["Target", `${r.targetType}${r.targetId ? ` · ${r.targetId}` : ""}`],
                          ["Outcome", out.label],
                          ["Reason", r.reason ?? "—"],
                          ["Request ID", r.requestId ? <code key="rq" className="break-all text-xs">{r.requestId}</code> : "—"],
                        ]}
                      />
                      <h3 className="mt-5 text-xs font-medium uppercase tracking-[0.08em] text-muted">Metadata</h3>
                      {hasMetadata ? (
                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-canvas p-3 font-mono text-xs text-ink">{JSON.stringify(r.metadata, null, 2)}</pre>
                      ) : (
                        <p className="mt-2 text-sm text-muted">No metadata recorded for this entry.</p>
                      )}
                    </EvidenceDrawer>
                  </Td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <EmptyState title={filtered ? "No entries match these filters" : page > 1 ? "No more entries" : "No audit entries yet"}>
            {filtered ? "Try a broader search or a wider date range." : "Security-relevant changes and high-impact actions are recorded here as they happen."}
          </EmptyState>
        )}
        {page > 1 || hasMore ? (
          <nav aria-label="Audit log pages" className="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
            {page > 1 ? (
              <Link href={pageHref(page - 1)} className={buttonStyles.secondary} rel="prev">
                <ChevronLeft aria-hidden className="h-4 w-4" /> Newer
              </Link>
            ) : (
              <span />
            )}
            <span className="text-xs text-muted">Page {page}</span>
            {hasMore ? (
              <Link href={pageHref(page + 1)} className={buttonStyles.secondary} rel="next">
                Older <ChevronRight aria-hidden className="h-4 w-4" />
              </Link>
            ) : (
              <span />
            )}
          </nav>
        ) : null}
      </Card>
    </>
  );
}
