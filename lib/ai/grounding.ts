/**
 * Server-side grounding enforcement. The model is instructed to cite evidence,
 * but instructions are not controls: this pass guarantees that
 *  - every confirmed finding cites at least one evidence ref that was actually
 *    supplied for THIS tenant and request; otherwise it is downgraded to a
 *    low-confidence hypothesis and the change is recorded;
 *  - unknown refs are stripped everywhere (they could otherwise point the UI at
 *    records the model invented);
 *  - overall confidence cannot be "high" when nothing is confirmed.
 */
import type { Diagnosis, StoredDiagnosis } from "@/lib/ai/schema";

export function enforceGrounding(d: Diagnosis, allowedRefs: Set<string>): StoredDiagnosis {
  const notes: string[] = [];
  const keep = (refs: string[]) => {
    const valid = refs.filter((r) => allowedRefs.has(r));
    if (valid.length !== refs.length) notes.push(`Removed ${refs.length - valid.length} evidence reference(s) that did not match supplied evidence.`);
    return valid;
  };

  const confirmed: Diagnosis["confirmedFindings"] = [];
  const hypotheses: Diagnosis["hypotheses"] = d.hypotheses.map((h) => ({ ...h, evidenceRefs: keep(h.evidenceRefs) }));
  for (const f of d.confirmedFindings) {
    const refs = keep(f.evidenceRefs);
    if (refs.length) confirmed.push({ ...f, evidenceRefs: refs });
    else {
      hypotheses.push({ statement: f.statement, rationale: "Stated as a finding without valid evidence references; downgraded by QuikReach.", evidenceRefs: [], confidence: "low" });
      notes.push("A finding without valid evidence was downgraded to a hypothesis.");
    }
  }
  const recommendations = d.recommendations.map((r) => ({ ...r, evidenceRefs: keep(r.evidenceRefs) }));
  let overall = d.overallConfidence;
  if (!confirmed.length && overall === "high") {
    overall = "low";
    notes.push("Overall confidence lowered: no confirmed findings.");
  }
  return {
    ...d,
    overallConfidence: overall,
    confirmedFindings: confirmed,
    hypotheses,
    recommendations,
    groundingNotes: [...new Set(notes)],
    actionsRequireHumanConfirmation: true,
  };
}
