import Link from "next/link";
import { clsx } from "clsx";
import { and, count, desc, eq } from "drizzle-orm";
import { RotateCcw } from "lucide-react";
import { requirePage } from "@/lib/auth/page";
import { db } from "@/lib/db";
import { backgroundJobs, JOB_STATUSES, type JobStatus } from "@/lib/db/schema";
import { can } from "@/lib/rbac";
import { buttonStyles, Callout, Card, EmptyState, PageHeader, PermissionDenied, Pill, Table, Td } from "@/components/ui/primitives";
import { ActionButton } from "@/components/ui/interactive";
import { SettingsNav } from "@/components/settings/settings-nav";
import { Notice, readNotice } from "@/components/settings/notice";
import { dateTime, relativeTime } from "@/lib/ui/format";

export const metadata = { title: "Background jobs" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type Tone = React.ComponentProps<typeof Pill>["tone"];

const LIMIT = 100;

const NOTICES: Record<string, string> = {
  retried: "Job re-queued with its attempt count reset. It runs when a worker picks it up — check back here for the outcome.",
};

const JOB_PILL: Record<JobStatus, { tone: Tone; label: string }> = {
  queued: { tone: "info", label: "Queued" },
  running: { tone: "info", label: "Running" },
  succeeded: { tone: "good", label: "Succeeded" },
  failed: { tone: "warn", label: "Failed" },
  dead: { tone: "bad", label: "Dead-lettered" },
  cancelled: { tone: "unknown", label: "Cancelled" },
};

function isJobStatus(v: string | undefined): v is JobStatus {
  return (JOB_STATUSES as readonly string[]).includes(v ?? "");
}

export default async function JobsPage({ searchParams }: { searchParams: SearchParams }) {
  const { principal, allowed } = await requirePage("job:view");
  const header = (
    <PageHeader
      title="Background jobs"
      lede="Syncs, scans, alert evaluations, notifications and campaign requests that QuikReach runs in the background for this workspace."
    />
  );
  if (!allowed) {
    return (
      <>
        {header}
        <SettingsNav role={principal.role} />
        <PermissionDenied permission="job:view" />
      </>
    );
  }

  const sp = await searchParams;
  const rawStatus = Array.isArray(sp.status) ? sp.status[0] : sp.status;
  const status = isJobStatus(rawStatus) ? rawStatus : undefined;
  const canRetry = can(principal.role, "job:retry");
  const notice = readNotice(sp.notice, NOTICES);
  const afterRetry = `/settings/jobs?${status ? `status=${status}&` : ""}notice=retried`;

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: backgroundJobs.id,
        type: backgroundJobs.type,
        status: backgroundJobs.status,
        attempts: backgroundJobs.attempts,
        maxAttempts: backgroundJobs.maxAttempts,
        runAt: backgroundJobs.runAt,
        lastError: backgroundJobs.lastError,
        createdAt: backgroundJobs.createdAt,
        completedAt: backgroundJobs.completedAt,
      })
      .from(backgroundJobs)
      .where(and(eq(backgroundJobs.orgId, principal.orgId), status ? eq(backgroundJobs.status, status) : undefined))
      .orderBy(desc(backgroundJobs.createdAt))
      .limit(LIMIT),
    db.select({ status: backgroundJobs.status, n: count() }).from(backgroundJobs).where(eq(backgroundJobs.orgId, principal.orgId)).groupBy(backgroundJobs.status),
  ]);

  const countBy = new Map(totals.map((t) => [t.status, t.n]));
  const all = totals.reduce((s, t) => s + t.n, 0);
  const dead = countBy.get("dead") ?? 0;
  const filters: Array<{ value: JobStatus | undefined; label: string; n: number }> = [
    { value: undefined, label: "All", n: all },
    ...JOB_STATUSES.map((s) => ({ value: s, label: JOB_PILL[s].label, n: countBy.get(s) ?? 0 })),
  ];

  return (
    <>
      {header}
      <SettingsNav role={principal.role} />
      <Notice message={notice} />

      <div className="mb-6 space-y-3">
        <Callout tone="info" title="How retries work">
          A failed job is retried automatically a bounded number of times (attempts / max) with exponential backoff and jitter, or after the delay a provider asks for. When it runs out of attempts, or fails with an error that retrying cannot fix, it is <strong>dead-lettered</strong>: it will not run again until a person reviews the error and retries it.
        </Callout>
        {dead > 0 ? (
          <Callout tone="bad" title={`${dead} dead-lettered ${dead === 1 ? "job needs" : "jobs need"} attention`}>
            Read the last error before retrying. {canRetry ? "Retrying re-queues the job with its attempt count reset." : "Retrying needs job:retry (Owners and Administrators)."}
          </Callout>
        ) : null}
      </div>

      <nav aria-label="Filter jobs by status" className="mb-4 flex flex-wrap gap-1.5">
        {filters.map((f) => {
          const active = f.value === status;
          return (
            <Link
              key={f.label}
              href={f.value ? `/settings/jobs?status=${f.value}` : "/settings/jobs"}
              aria-current={active ? "page" : undefined}
              className={clsx(buttonStyles.ghost, active && "bg-panel text-ink ring-1 ring-inset ring-line")}
            >
              {f.label} <span className="tabular-nums text-xs text-muted">({f.n})</span>
            </Link>
          );
        })}
      </nav>

      <Card title={status ? `${JOB_PILL[status].label} jobs` : "All jobs"} description={`Newest first · up to ${LIMIT}`} padded={false}>
        {rows.length ? (
          <Table caption="Background jobs" head={["Type", "Status", "Attempts", "Run at", "Last error", "Created", "Completed", "Actions"]}>
            {rows.map((j) => {
              const pill = JOB_PILL[j.status];
              return (
                <tr key={j.id}>
                  <Td>
                    <span className="font-mono text-xs text-ink">{j.type}</span>
                    <div className="max-w-[10rem] truncate font-mono text-[11px] text-muted" title={j.id}>
                      {j.id}
                    </div>
                  </Td>
                  <Td>
                    <Pill tone={pill.tone}>{pill.label}</Pill>
                  </Td>
                  <Td className="whitespace-nowrap tabular-nums">
                    {j.attempts} / {j.maxAttempts}
                  </Td>
                  <Td className="whitespace-nowrap">
                    <span title={dateTime(j.runAt)}>{j.status === "queued" ? relativeTime(j.runAt) : dateTime(j.runAt)}</span>
                  </Td>
                  <Td className="max-w-xs">
                    {j.lastError ? (
                      j.lastError.length > 120 ? (
                        <details className="text-xs">
                          <summary className="cursor-pointer break-words text-red-800">{j.lastError.slice(0, 120)}…</summary>
                          <p className="mt-1 whitespace-pre-wrap break-words text-muted">{j.lastError}</p>
                        </details>
                      ) : (
                        <span className="break-words text-xs text-red-800">{j.lastError}</span>
                      )
                    ) : (
                      <span className="text-xs text-muted">—</span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-xs">{dateTime(j.createdAt)}</Td>
                  <Td className="whitespace-nowrap text-xs">{j.completedAt ? dateTime(j.completedAt) : <span className="text-muted">—</span>}</Td>
                  <Td>
                    {j.status === "dead" && canRetry ? (
                      <ActionButton
                        label="Retry"
                        icon={<RotateCcw aria-hidden className="h-4 w-4" />}
                        path={`/api/v1/jobs/${j.id}/retry`}
                        confirm={{
                          title: `Retry this ${j.type} job?`,
                          description: "It is re-queued with its attempt count reset to 0 and runs again with the same input. Make sure the cause of the last error has been dealt with.",
                          confirmLabel: "Retry job",
                        }}
                        successMessage="Job re-queued."
                        redirectTo={afterRetry}
                      />
                    ) : j.status === "dead" ? (
                      <span className="text-xs text-muted">Needs job:retry</span>
                    ) : (
                      <span className="text-xs text-muted">—</span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <EmptyState title={status ? `No ${JOB_PILL[status].label.toLowerCase()} jobs` : "No background jobs yet"}>
            {status ? "Nothing in this state right now." : "Jobs appear here once QuikReach starts syncing, scanning or evaluating alerts for this workspace."}
          </EmptyState>
        )}
      </Card>
    </>
  );
}
