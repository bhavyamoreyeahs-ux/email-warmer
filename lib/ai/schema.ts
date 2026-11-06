/**
 * Structured diagnosis contract shared by the LLM path and the deterministic
 * rules engine. Written with zod/v4 because the Anthropic SDK's
 * `zodOutputFormat` helper consumes v4 schemas (zod 3.25 ships v4 at "zod/v4").
 */
import * as z from "zod/v4";

const ref = z.string().max(120);

export const diagnosisSchema = z.object({
  summary: z.string().describe("Two or three sentences. Plain language. No claims beyond the evidence."),
  overallConfidence: z.enum(["low", "medium", "high"]),
  confirmedFindings: z
    .array(z.object({ statement: z.string(), evidenceRefs: z.array(ref) }))
    .describe("Facts directly shown by the cited evidence items. Every item MUST cite at least one evidence ref."),
  hypotheses: z
    .array(
      z.object({
        statement: z.string(),
        rationale: z.string(),
        evidenceRefs: z.array(ref),
        confidence: z.enum(["low", "medium", "high"]),
      }),
    )
    .describe("Plausible explanations that the evidence does not prove."),
  recommendations: z.array(
    z.object({
      action: z.string(),
      rationale: z.string(),
      evidenceRefs: z.array(ref),
      kind: z.enum(["dns_change", "sending_change", "mailbox_reconnect", "list_hygiene", "investigate", "configuration", "other"]),
    }),
  ),
  insufficientEvidence: z.array(z.object({ question: z.string(), missingData: z.string() })).describe("What could not be determined and which data would be needed."),
});

export type Diagnosis = z.infer<typeof diagnosisSchema>;

export interface StoredDiagnosis extends Diagnosis {
  /** Notes added by server-side grounding validation (e.g. claims downgraded to hypotheses). */
  groundingNotes: string[];
  /** Always true: QuikReach never executes recommended actions on its own. */
  actionsRequireHumanConfirmation: true;
}

export interface EvidenceItem {
  /** Stable reference the model must cite, e.g. "check:<uuid>". */
  ref: string;
  kind: "dns_check" | "mailbox" | "event_summary" | "alert" | "capability_gap";
  title: string;
  observedAt: string | null;
  facts: Record<string, string | number | boolean | null | string[]>;
}
