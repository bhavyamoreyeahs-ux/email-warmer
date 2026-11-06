/**
 * Diagnostics orchestration: entitlement → evidence → model or rules engine →
 * grounding enforcement → storage (model, prompt version, evidence refs,
 * tokens) → usage → audit. Never executes recommendations.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { aiRecommendations } from "@/lib/db/schema";
import { collectEvidence, type DiagnosisSubject } from "@/lib/ai/evidence";
import { diagnoseWithRules, RULES_ENGINE_VERSION } from "@/lib/ai/rules-engine";
import { aiConfigured, diagnoseWithClaude, PROMPT_VERSION } from "@/lib/ai/anthropic";
import { enforceGrounding } from "@/lib/ai/grounding";
import type { Diagnosis } from "@/lib/ai/schema";
import { assertCanDiagnose } from "@/lib/usage/entitlements";
import { recordUsage } from "@/lib/usage/ledger";
import { recordAudit, type AuditActor } from "@/lib/audit";
import { logger } from "@/lib/observability/logger";
import { notFound } from "@/lib/api/errors";

export async function runDiagnosis(orgId: string, subject: DiagnosisSubject, question: string | null, actor: AuditActor, requestId?: string) {
  await assertCanDiagnose(orgId);
  const evidence = await collectEvidence(orgId, subject);
  const allowed = new Set(evidence.map((e) => e.ref));
  const started = Date.now();

  let engine: "anthropic" | "rules" = "rules";
  let model: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let raw: Diagnosis;
  let fallbackNote: string | null = null;

  if (!evidence.length) {
    raw = {
      summary: "There is no evidence for this scope yet: add a domain and run a scan, or connect a mailbox.",
      overallConfidence: "low",
      confirmedFindings: [],
      hypotheses: [],
      recommendations: [],
      insufficientEvidence: [{ question: "Anything about deliverability for this scope", missingData: "No DNS checks, mailbox data or alerts exist yet." }],
    };
  } else if (aiConfigured()) {
    try {
      const r = await diagnoseWithClaude(evidence, question);
      raw = r.diagnosis;
      engine = "anthropic";
      model = r.model;
      inputTokens = r.inputTokens;
      outputTokens = r.outputTokens;
    } catch (error: unknown) {
      logger.warn("ai_diagnosis_failed", { orgId, error });
      raw = diagnoseWithRules(evidence);
      fallbackNote = "The AI model was unavailable, so this diagnosis was produced by the deterministic rules engine.";
    }
  } else {
    raw = diagnoseWithRules(evidence);
  }

  const grounded = enforceGrounding(raw, allowed);
  if (fallbackNote) grounded.groundingNotes.unshift(fallbackNote);
  const status = !evidence.length ? "insufficient_evidence" : "completed";

  const [row] = await db
    .insert(aiRecommendations)
    .values({
      orgId,
      requestedByUserId: actor.userId ?? null,
      subjectType: subject.type,
      subjectId: subject.type === "organization" ? null : subject.id,
      question: question?.slice(0, 500) ?? null,
      engine,
      model: engine === "rules" ? RULES_ENGINE_VERSION : model,
      promptVersion: engine === "rules" ? RULES_ENGINE_VERSION : PROMPT_VERSION,
      evidenceRefs: [...allowed],
      output: { ...grounded, evidence } as unknown as Record<string, unknown>,
      confidence: grounded.overallConfidence,
      status,
      inputTokens,
      outputTokens,
      latencyMs: Date.now() - started,
    })
    .returning();
  await recordUsage({ orgId, metric: "ai_diagnosis", quantity: 1, idempotencyKey: `diagnosis:${row!.id}`, source: engine });
  await recordAudit({
    orgId,
    actor,
    action: "diagnostic.run",
    targetType: subject.type,
    targetId: subject.type === "organization" ? null : subject.id,
    outcome: "success",
    requestId,
    metadata: { diagnosisId: row!.id, engine, model: row!.model, promptVersion: row!.promptVersion, evidenceRefCount: allowed.size },
  });
  return row!;
}

export async function listDiagnoses(orgId: string, limit = 20) {
  return db.select().from(aiRecommendations).where(eq(aiRecommendations.orgId, orgId)).orderBy(desc(aiRecommendations.createdAt)).limit(limit);
}

export async function getDiagnosis(orgId: string, id: string) {
  const [row] = await db.select().from(aiRecommendations).where(and(eq(aiRecommendations.id, id), eq(aiRecommendations.orgId, orgId))).limit(1);
  if (!row) throw notFound("Diagnosis");
  return row;
}
