/**
 * Server-safe display helpers for the domain pages (no hooks, no client code).
 * Every status renders icon + text through the shared Pill.
 */
import { Pill } from "@/components/ui/primitives";
import type { CheckFinding, CheckType, DnsQueryEvidence } from "@/lib/db/schema";

export const CHECK_ORDER: readonly CheckType[] = ["mx", "spf", "dkim", "dmarc"];

export const CHECK_NAME: Record<CheckType, string> = { mx: "MX", spf: "SPF", dkim: "DKIM", dmarc: "DMARC" };

export const CHECK_PURPOSE: Record<CheckType, string> = {
  mx: "Inbound mail routing for the domain.",
  spf: "Which servers may send mail for the domain.",
  dkim: "Cryptographic signing keys published for your sending services.",
  dmarc: "Policy telling receivers what to do with mail that fails SPF/DKIM alignment.",
};

export const SCAN_TRIGGER_LABEL: Record<"manual" | "scheduled" | "setup" | "recheck", string> = {
  manual: "Manual",
  scheduled: "Scheduled",
  setup: "Initial (on add)",
  recheck: "Re-check after changes",
};

export type VerificationStatus = "unverified" | "pending" | "verified" | "failed";

export function VerificationPill({ status }: { status: VerificationStatus }) {
  switch (status) {
    case "verified":
      return <Pill tone="good">Ownership verified</Pill>;
    case "failed":
      return <Pill tone="warn">Not verified yet</Pill>;
    case "pending":
      return <Pill tone="info">Verification pending</Pill>;
    default:
      return <Pill tone="unknown">Unverified</Pill>;
  }
}

export function ScanStatusPill({ status }: { status: "queued" | "running" | "completed" | "failed" }) {
  switch (status) {
    case "completed":
      return <Pill tone="info">Completed</Pill>;
    case "failed":
      return <Pill tone="bad">Scan failed</Pill>;
    case "running":
      return <Pill tone="stale">Running</Pill>;
    default:
      return <Pill tone="stale">Queued</Pill>;
  }
}

export function FindingSeverityPill({ severity }: { severity: CheckFinding["severity"] }) {
  if (severity === "error") return <Pill tone="bad">Error</Pill>;
  if (severity === "warning") return <Pill tone="warn">Warning</Pill>;
  return <Pill tone="info">Info</Pill>;
}

/** Plain-language meaning of a DNS response code, as recorded in check evidence. */
export const DNS_OUTCOME_HELP: Record<string, string> = {
  NOERROR: "The lookup completed and returned an answer (possibly empty).",
  NXDOMAIN: "The name does not exist in DNS.",
  NODATA: "The name exists but has no records of this type.",
  TIMEOUT: "The resolver did not answer in time — the result could not be determined.",
  SERVFAIL: "The authoritative DNS server failed to answer — the result could not be determined.",
  REFUSED: "The DNS server refused the query — the result could not be determined.",
  ERROR: "The lookup failed — the result could not be determined.",
};

export function DnsOutcomePill({ outcome }: { outcome: string }) {
  const tone = outcome === "NOERROR" ? "info" : outcome === "NXDOMAIN" || outcome === "NODATA" ? "unknown" : "warn";
  return (
    <Pill tone={tone} title={DNS_OUTCOME_HELP[outcome]}>
      {outcome}
    </Pill>
  );
}

/** Every DNS query behind a result: name, type, outcome, duration and the answers exactly as resolved. */
export function DnsQueryList({ queries }: { queries: ReadonlyArray<Pick<DnsQueryEvidence, "name" | "type" | "answers" | "outcome" | "durationMs">> }) {
  if (!queries.length) return <p className="text-sm text-muted">No DNS queries were recorded for this result.</p>;
  return (
    <ol className="space-y-3">
      {queries.map((q, i) => (
        <li key={`${q.type}-${q.name}-${i}`} className="rounded-md border border-line p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-canvas px-1.5 py-0.5 font-mono text-xs text-ink">{q.type}</span>
            <span className="min-w-0 break-all font-mono text-xs text-ink">{q.name}</span>
          </div>
          <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted">Outcome</dt>
            <dd className="flex flex-wrap items-center gap-1.5">
              <DnsOutcomePill outcome={q.outcome} />
              <span className="text-muted">{DNS_OUTCOME_HELP[q.outcome] ?? "Unrecognised resolver outcome."}</span>
            </dd>
            <dt className="text-muted">Duration</dt>
            <dd className="tabular-nums text-ink">{q.durationMs} ms</dd>
            <dt className="text-muted">Answers</dt>
            <dd className="min-w-0">
              {q.answers.length ? (
                <ul className="space-y-1">
                  {q.answers.map((a, j) => (
                    <li key={j}>
                      <pre className="whitespace-pre-wrap break-all rounded bg-canvas px-2 py-1 font-mono text-xs text-ink">{a}</pre>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-muted">No answers returned.</span>
              )}
            </dd>
          </dl>
        </li>
      ))}
    </ol>
  );
}
