"use client";

/**
 * Renders one stored diagnosis. Observed facts (confirmed findings), unproven
 * explanations (hypotheses), suggested human actions (recommendations) and
 * gaps (what we can't tell) are kept visually and semantically separate.
 * Every evidence chip opens the exact EvidenceItem the statement cites.
 */
import { FileSearch } from "lucide-react";
import { Callout, Card, KeyValue, Pill } from "@/components/ui/primitives";
import { EvidenceDrawer } from "@/components/ui/interactive";
import { dateTime } from "@/lib/ui/format";
import type { EvidenceItem, StoredDiagnosis } from "@/lib/ai/schema";

type Confidence = "low" | "medium" | "high";
type RecommendationKind = StoredDiagnosis["recommendations"][number]["kind"];

export interface DiagnosisViewData {
  id: string;
  createdAt: string;
  engine: "anthropic" | "rules";
  model: string | null;
  promptVersion: string;
  confidence: Confidence | null;
  status: "completed" | "failed" | "insufficient_evidence";
  question: string | null;
  scopeLabel: string;
  output: StoredDiagnosis & { evidence: EvidenceItem[] };
}

const KIND_LABEL: Record<EvidenceItem["kind"], string> = {
  dns_check: "DNS check",
  mailbox: "Mailbox",
  event_summary: "Event summary",
  alert: "Alert",
  capability_gap: "Capability gap (something QuikReach cannot see)",
};

const RECOMMENDATION_KIND: Record<RecommendationKind, string> = {
  dns_change: "DNS change",
  sending_change: "Sending change",
  mailbox_reconnect: "Mailbox reconnect",
  list_hygiene: "List hygiene",
  investigate: "Investigate",
  configuration: "Configuration",
  other: "Other",
};

const CONFIDENCE_LABEL: Record<Confidence, string> = { low: "Low", medium: "Medium", high: "High" };

function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function FactValue({ value }: { value: EvidenceItem["facts"][string] }) {
  if (value === null) return <span className="text-muted">Not recorded</span>;
  if (typeof value === "boolean") return <>{value ? "Yes" : "No"}</>;
  if (Array.isArray(value)) {
    return value.length ? (
      <ul className="list-disc space-y-0.5 pl-4">
        {value.map((v, i) => (
          <li key={i} className="break-words">
            {v}
          </li>
        ))}
      </ul>
    ) : (
      <span className="text-muted">None</span>
    );
  }
  return <span className="break-words">{String(value)}</span>;
}

function EvidenceChip({ refId, evidence }: { refId: string; evidence: Map<string, EvidenceItem> }) {
  const item = evidence.get(refId);
  if (!item) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-dashed border-line px-2 py-0.5 font-mono text-xs text-muted" title="This evidence item is not stored with the diagnosis">
        {refId} (unavailable)
      </span>
    );
  }
  return (
    <EvidenceDrawer
      title={item.title}
      trigger={
        <button type="button" className="inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-canvas px-2 py-0.5 text-left text-xs text-ink hover:border-accent-500 hover:bg-accent-50" aria-label={`Evidence: ${item.title}`}>
          <FileSearch aria-hidden className="h-3.5 w-3.5 flex-shrink-0 text-muted" />
          <span className="truncate">{item.title}</span>
        </button>
      }
    >
      <div className="space-y-4">
        <KeyValue
          items={[
            ["Kind", KIND_LABEL[item.kind]],
            ["Observed at", item.observedAt ? dateTime(item.observedAt) : <span key="o" className="text-muted">Not recorded</span>],
            ["Reference", <code key="r" className="break-all rounded bg-canvas px-1 text-xs">{item.ref}</code>],
          ]}
        />
        <div>
          <h3 className="text-xs font-medium uppercase tracking-[0.08em] text-muted">Facts</h3>
          {Object.keys(item.facts).length ? (
            <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[minmax(120px,max-content)_1fr]">
              {Object.entries(item.facts).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{humanizeKey(k)}</dt>
                  <dd className="min-w-0 text-ink">
                    <FactValue value={v} />
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-2 text-muted">No facts recorded for this item.</p>
          )}
        </div>
        <p className="text-xs text-muted">Facts are copied from QuikReach&rsquo;s stored data when the diagnosis ran. Re-run the diagnosis to use newer data.</p>
      </div>
    </EvidenceDrawer>
  );
}

function Chips({ refs, evidence }: { refs: string[]; evidence: Map<string, EvidenceItem> }) {
  if (!refs.length) return <p className="mt-1.5 text-xs text-muted">No evidence cited.</p>;
  return (
    <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Cited evidence">
      {refs.map((r) => (
        <li key={r} className="max-w-full">
          <EvidenceChip refId={r} evidence={evidence} />
        </li>
      ))}
    </ul>
  );
}

function SectionHeading({ id, children, count, pill }: { id: string; children: React.ReactNode; count: number; pill?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h3 id={id} className="text-sm font-medium text-ink">
        {children} <span className="font-normal text-muted">({count})</span>
      </h3>
      {pill}
    </div>
  );
}

export function DiagnosisView({ diagnosis }: { diagnosis: DiagnosisViewData }) {
  const d = diagnosis.output;
  const evidence = new Map(d.evidence.map((e) => [e.ref, e]));
  const fellBack = diagnosis.engine === "rules" && d.groundingNotes.some((n) => /AI model was unavailable/i.test(n));
  const engineLabel = diagnosis.engine === "anthropic" ? `AI model: ${diagnosis.model ?? "unknown"}` : fellBack ? "Rules engine (AI model was unavailable)" : "Rules engine (no AI model configured)";
  const confidence = diagnosis.confidence ?? d.overallConfidence;
  const sid = `dx-${diagnosis.id.slice(0, 8)}`;

  return (
    <Card
      title="Diagnosis"
      description={
        <>
          {diagnosis.scopeLabel} · {dateTime(diagnosis.createdAt)}
        </>
      }
      actions={
        <>
          <Pill tone={diagnosis.engine === "anthropic" ? "info" : "unknown"} title={`Version: ${diagnosis.promptVersion}`}>
            {engineLabel}
          </Pill>
          <Pill tone={confidence === "low" ? "unknown" : "info"} title="How strongly the cited evidence supports the summary. Not a deliverability score.">
            Overall confidence: {CONFIDENCE_LABEL[confidence]}
          </Pill>
        </>
      }
    >
      <div className="space-y-6">
        {diagnosis.question ? (
          <p className="text-sm text-muted">
            Question: <span className="text-ink">&ldquo;{diagnosis.question}&rdquo;</span>
          </p>
        ) : null}

        {diagnosis.status === "insufficient_evidence" ? (
          <Callout tone="unknown" title="Not enough evidence">
            QuikReach had no stored evidence for this scope, so nothing could be diagnosed. Add and scan a domain, or connect a mailbox, then run it again.
          </Callout>
        ) : diagnosis.status === "failed" ? (
          <Callout tone="bad" title="This diagnosis failed">
            No conclusions should be drawn from it. Run it again.
          </Callout>
        ) : null}

        <section aria-labelledby={`${sid}-summary`}>
          <h3 id={`${sid}-summary`} className="text-sm font-medium text-ink">
            Summary
          </h3>
          <p className="mt-1 text-sm text-ink">{d.summary || <span className="text-muted">No summary.</span>}</p>
        </section>

        <section aria-labelledby={`${sid}-confirmed`}>
          <SectionHeading id={`${sid}-confirmed`} count={d.confirmedFindings.length} pill={<Pill tone="good">Shown by evidence</Pill>}>
            Confirmed findings
          </SectionHeading>
          {d.confirmedFindings.length ? (
            <ul className="mt-2 space-y-3">
              {d.confirmedFindings.map((f, i) => (
                <li key={i} className="rounded-md border border-line p-3 text-sm">
                  <p className="text-ink">{f.statement}</p>
                  <Chips refs={f.evidenceRefs} evidence={evidence} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">No finding is directly confirmed by the stored evidence.</p>
          )}
        </section>

        <section aria-labelledby={`${sid}-hypotheses`}>
          <SectionHeading id={`${sid}-hypotheses`} count={d.hypotheses.length} pill={<Pill tone="unknown">Not confirmed</Pill>}>
            Hypotheses
          </SectionHeading>
          <p className="mt-1 text-xs text-muted">Plausible explanations the evidence does not prove. Verify before acting on them.</p>
          {d.hypotheses.length ? (
            <ul className="mt-2 space-y-3">
              {d.hypotheses.map((h, i) => (
                <li key={i} className="rounded-md border border-dashed border-line p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone="unknown">Not confirmed</Pill>
                    <span className="text-xs text-muted">Confidence: {CONFIDENCE_LABEL[h.confidence]}</span>
                  </div>
                  <p className="mt-1.5 text-ink">{h.statement}</p>
                  <p className="mt-1 text-xs text-muted">
                    <span className="font-medium">Why:</span> {h.rationale}
                  </p>
                  <Chips refs={h.evidenceRefs} evidence={evidence} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">No hypotheses.</p>
          )}
        </section>

        <section aria-labelledby={`${sid}-recs`}>
          <SectionHeading id={`${sid}-recs`} count={d.recommendations.length}>
            Recommendations
          </SectionHeading>
          <div className="mt-2">
            <Callout tone="info">QuikReach does not execute these. Make changes in your DNS host or sending tool, then re-run checks.</Callout>
          </div>
          {d.recommendations.length ? (
            <ol className="mt-3 space-y-3">
              {d.recommendations.map((r, i) => (
                <li key={i} className="rounded-md border border-line p-3 text-sm">
                  <span className="inline-block rounded bg-canvas px-1.5 py-0.5 text-xs font-medium text-muted">{RECOMMENDATION_KIND[r.kind]}</span>
                  <p className="mt-1.5 text-ink">{r.action}</p>
                  <p className="mt-1 text-xs text-muted">
                    <span className="font-medium">Why:</span> {r.rationale}
                  </p>
                  <Chips refs={r.evidenceRefs} evidence={evidence} />
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-2 text-sm text-muted">No recommendations.</p>
          )}
        </section>

        <section aria-labelledby={`${sid}-gaps`}>
          <SectionHeading id={`${sid}-gaps`} count={d.insufficientEvidence.length}>
            What we can&rsquo;t tell
          </SectionHeading>
          {d.insufficientEvidence.length ? (
            <ul className="mt-2 space-y-2">
              {d.insufficientEvidence.map((g, i) => (
                <li key={i} className="rounded-md bg-stone-100 px-3 py-2 text-sm">
                  <p className="text-ink">{g.question}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    <span className="font-medium">Missing data:</span> {g.missingData}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">No gaps were listed. QuikReach still cannot observe inbox placement or recipient-side filtering.</p>
          )}
        </section>

        {d.groundingNotes.length ? (
          <section aria-labelledby={`${sid}-grounding`}>
            <h3 id={`${sid}-grounding`} className="text-sm font-medium text-ink">
              Grounding notes
            </h3>
            <p className="mt-0.5 text-xs text-muted">Adjustments QuikReach made after checking every statement against the evidence.</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
              {d.groundingNotes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <details className="text-sm">
          <summary className="cursor-pointer select-none text-muted hover:text-ink">All evidence considered ({d.evidence.length})</summary>
          {d.evidence.length ? <Chips refs={d.evidence.map((e) => e.ref)} evidence={evidence} /> : <p className="mt-2 text-muted">No evidence was available.</p>}
        </details>

        <p className="text-xs text-muted">
          Engine version {diagnosis.promptVersion}. Diagnoses describe stored evidence only; they make no claim about inbox placement or sender reputation.
        </p>
      </div>
    </Card>
  );
}
