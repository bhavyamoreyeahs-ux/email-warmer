import Link from "next/link";
import { clsx } from "clsx";
import { Sparkles } from "lucide-react";
import { requirePage } from "@/lib/auth/page";
import { can } from "@/lib/rbac";
import { getDiagnosis, listDiagnoses } from "@/lib/ai/service";
import { aiConfigured } from "@/lib/ai/anthropic";
import type { Diagnosis, EvidenceItem, StoredDiagnosis } from "@/lib/ai/schema";
import { listDomains } from "@/lib/domains/service";
import { listMailboxes } from "@/lib/mailboxes/service";
import { listAlerts } from "@/lib/alerts/service";
import { ApiError } from "@/lib/api/errors";
import { Callout, Card, EmptyState, PageHeader, PermissionDenied, Pill } from "@/components/ui/primitives";
import { DiagnoseForm } from "@/components/copilot/diagnose-form";
import { DiagnosisView, type DiagnosisViewData } from "@/components/copilot/diagnosis-view";
import { dateTime, relativeTime } from "@/lib/ui/format";

export const metadata = { title: "AI Copilot" };

type SearchParams = Record<string, string | string[] | undefined>;
type DiagnosisRow = Awaited<ReturnType<typeof listDiagnoses>>[number];
type Confidence = "low" | "medium" | "high";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ─── Defensive parsing of the stored JSON output ─────────────────────── */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const objs = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter(isObj) : []);
const confidence = (v: unknown): Confidence => (v === "high" || v === "medium" ? v : "low");
const REC_KINDS = ["dns_change", "sending_change", "mailbox_reconnect", "list_hygiene", "investigate", "configuration", "other"] as const;
const recKind = (v: unknown): Diagnosis["recommendations"][number]["kind"] => REC_KINDS.find((k) => k === v) ?? "other";
const EVIDENCE_KINDS = ["dns_check", "mailbox", "event_summary", "alert", "capability_gap"] as const;
const evidenceKind = (v: unknown): EvidenceItem["kind"] => EVIDENCE_KINDS.find((k) => k === v) ?? "event_summary";

function facts(v: unknown): EvidenceItem["facts"] {
  const out: EvidenceItem["facts"] = {};
  if (!isObj(v)) return out;
  for (const [k, val] of Object.entries(v)) {
    if (val === null || typeof val === "string" || typeof val === "number" || typeof val === "boolean") out[k] = val;
    else if (Array.isArray(val)) out[k] = val.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
    else out[k] = JSON.stringify(val);
  }
  return out;
}

function parseOutput(output: Record<string, unknown>): StoredDiagnosis & { evidence: EvidenceItem[] } {
  return {
    summary: str(output.summary),
    overallConfidence: confidence(output.overallConfidence),
    confirmedFindings: objs(output.confirmedFindings).map((f) => ({ statement: str(f.statement), evidenceRefs: strs(f.evidenceRefs) })),
    hypotheses: objs(output.hypotheses).map((h) => ({ statement: str(h.statement), rationale: str(h.rationale), evidenceRefs: strs(h.evidenceRefs), confidence: confidence(h.confidence) })),
    recommendations: objs(output.recommendations).map((r) => ({ action: str(r.action), rationale: str(r.rationale), evidenceRefs: strs(r.evidenceRefs), kind: recKind(r.kind) })),
    insufficientEvidence: objs(output.insufficientEvidence).map((g) => ({ question: str(g.question), missingData: str(g.missingData) })),
    groundingNotes: strs(output.groundingNotes),
    actionsRequireHumanConfirmation: true,
    evidence: objs(output.evidence).map((e) => ({ ref: str(e.ref), kind: evidenceKind(e.kind), title: str(e.title) || str(e.ref), observedAt: typeof e.observedAt === "string" ? e.observedAt : null, facts: facts(e.facts) })),
  };
}

export default async function CopilotPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { principal, allowed } = await requirePage("diagnostic:view");
  if (!allowed) {
    return (
      <>
        <PageHeader title="AI Copilot" />
        <PermissionDenied permission="diagnostic:view" />
      </>
    );
  }

  const sp = await searchParams;
  const requestedId = typeof sp.d === "string" ? sp.d : null;
  const canRun = can(principal.role, "diagnostic:run");

  const [history, domains, mailboxes, alerts, requested] = await Promise.all([
    listDiagnoses(principal.orgId, 20),
    listDomains(principal.orgId),
    listMailboxes(principal.orgId),
    listAlerts(principal.orgId, { limit: 200 }),
    requestedId && UUID_RE.test(requestedId)
      ? getDiagnosis(principal.orgId, requestedId).catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 404) return null;
          throw error;
        })
      : Promise.resolve(null),
  ]);
  const requestedMissing = Boolean(requestedId) && !requested;
  const selected: DiagnosisRow | null = requested ?? history[0] ?? null;
  const modelConfigured = aiConfigured();

  const domainName = new Map(domains.map((d) => [d.id, d.name]));
  const mailboxName = new Map(mailboxes.map((m) => [m.id, m.emailAddress]));
  const alertTitle = new Map(alerts.map((a) => [a.id, a.title]));
  const scopeLabel = (row: DiagnosisRow) => {
    if (row.subjectType === "organization" || !row.subjectId) return "Whole workspace";
    if (row.subjectType === "domain") return `Domain: ${domainName.get(row.subjectId) ?? "deleted domain"}`;
    if (row.subjectType === "mailbox") return `Mailbox: ${mailboxName.get(row.subjectId) ?? "removed mailbox"}`;
    return `Alert: ${alertTitle.get(row.subjectId) ?? "older or removed alert"}`;
  };

  const view: DiagnosisViewData | null = selected
    ? {
        id: selected.id,
        createdAt: selected.createdAt.toISOString(),
        engine: selected.engine,
        model: selected.model,
        promptVersion: selected.promptVersion,
        confidence: selected.confidence,
        status: selected.status,
        question: selected.question,
        scopeLabel: scopeLabel(selected),
        output: parseOutput(selected.output),
      }
    : null;

  return (
    <>
      <PageHeader
        title="AI Copilot"
        lede="Evidence-grounded diagnoses of your domains, mailboxes and alerts. Every finding cites stored evidence; anything the evidence does not prove is labelled as a hypothesis. QuikReach never acts on its recommendations."
      />

      {!modelConfigured ? (
        <div className="mb-6">
          <Callout tone="unknown" title="No AI model is configured">
            Diagnoses use QuikReach&rsquo;s deterministic rules engine: the same stored evidence and fixed rules, with no language model. Results are labelled &ldquo;Rules engine&rdquo; and free-text questions are recorded but not interpreted.
          </Callout>
        </div>
      ) : null}

      {requestedMissing ? (
        <div className="mb-6">
          <Callout tone="warn">That diagnosis was not found in this workspace. {selected ? "Showing the most recent one instead." : ""}</Callout>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {canRun ? (
            <Card title="Run a diagnosis" description="Choose a scope. QuikReach collects the stored evidence for it, then analyses only that evidence.">
              <DiagnoseForm
                key={selected?.id ?? "none"}
                domains={domains.map((d) => ({ id: d.id, label: d.name }))}
                mailboxes={mailboxes.filter((m) => m.state !== "disconnected").map((m) => ({ id: m.id, label: `${m.emailAddress}${m.isDemo ? " (demo)" : ""}` }))}
                alerts={alerts.filter((a) => a.status !== "resolved").map((a) => ({ id: a.id, label: `${a.severity === "critical" ? "Critical" : a.severity === "warning" ? "Warning" : "Info"}: ${a.title}${a.isDemo ? " (demo)" : ""}` }))}
              />
            </Card>
          ) : (
            <Callout tone="unknown">Your role can view diagnoses but not run new ones.</Callout>
          )}

          {view ? (
            <DiagnosisView key={view.id} diagnosis={view} />
          ) : (
            <Card>
              <EmptyState icon={Sparkles} title="No diagnoses yet">
                {canRun ? "Run a diagnosis above to get findings, hypotheses and recommendations grounded in your stored evidence." : "Diagnoses run by your colleagues will appear here."}
              </EmptyState>
            </Card>
          )}
        </div>

        <Card title="History" description="The 20 most recent diagnoses in this workspace." padded={false} className="self-start">
          {history.length ? (
            <ul className="divide-y divide-line">
              {history.map((h) => {
                const current = selected?.id === h.id;
                return (
                  <li key={h.id}>
                    <Link
                      href={`/copilot?d=${h.id}`}
                      aria-current={current ? "page" : undefined}
                      className={clsx("block px-4 py-3 text-sm hover:bg-canvas", current && "bg-accent-50")}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 break-words font-medium text-ink">{scopeLabel(h)}</span>
                        <span className="whitespace-nowrap text-xs text-muted" title={dateTime(h.createdAt)}>
                          {relativeTime(h.createdAt)}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                        <span>{h.engine === "anthropic" ? "AI model" : "Rules engine"}</span>
                        <span aria-hidden>·</span>
                        <span>Confidence: {h.confidence ? h.confidence.charAt(0).toUpperCase() + h.confidence.slice(1) : "not stated"}</span>
                        {h.status === "insufficient_evidence" ? <Pill tone="unknown">Not enough evidence</Pill> : null}
                        {h.status === "failed" ? <Pill tone="bad">Failed</Pill> : null}
                      </div>
                      {h.question ? <p className="mt-1 truncate text-xs text-muted">&ldquo;{h.question}&rdquo;</p> : null}
                      {current ? <span className="sr-only">(currently shown)</span> : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-4 py-6 text-sm text-muted">No diagnoses yet.</p>
          )}
        </Card>
      </div>
    </>
  );
}
