import { z } from "zod";
import { created, ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { parseBody } from "@/lib/api/validation";
import { listDiagnoses, runDiagnosis } from "@/lib/ai/service";
import type { DiagnosisSubject } from "@/lib/ai/evidence";

export const dynamic = "force-dynamic";
export const GET = withOrgAuth(async ({ principal }) => ok(await listDiagnoses(principal.orgId)), { permission: "diagnostic:view" });

const schema = z.object({
  subjectType: z.enum(["organization", "domain", "mailbox", "alert"]),
  subjectId: z.string().uuid().optional(),
  question: z.string().trim().max(500).optional(),
});

export const POST = withOrgAuth(
  async ({ req, principal, actor, requestId }) => {
    const body = await parseBody(req, schema);
    const subject: DiagnosisSubject =
      body.subjectType === "organization" ? { type: "organization" } : { type: body.subjectType, id: body.subjectId ?? "00000000-0000-0000-0000-000000000000" };
    return created(await runDiagnosis(principal.orgId, subject, body.question ?? null, actor, requestId));
  },
  { permission: "diagnostic:run", rateLimit: { limit: 10, windowSeconds: 60 } },
);
