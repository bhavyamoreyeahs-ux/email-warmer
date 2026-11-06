import { z } from "zod";
import { ok } from "@/lib/api/responses";
import { withOrgAuth } from "@/lib/api/with-org-auth";
import { parseBody } from "@/lib/api/validation";
import { getOrganization, updateOrganization } from "@/lib/tenancy/organizations";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export const GET = withOrgAuth(
  async ({ principal }) => {
    const org = await getOrganization(principal.orgId);
    const e = env();
    return ok({
      ...org,
      retentionDefaults: {
        eventRetentionDays: e.DEFAULT_EVENT_RETENTION_DAYS,
        diagnosticRetentionDays: e.DEFAULT_DIAGNOSTIC_RETENTION_DAYS,
        auditRetentionDays: e.DEFAULT_AUDIT_RETENTION_DAYS,
        note: "Deployment defaults are placeholders pending product/security review.",
      },
    });
  },
  { permission: "organization:view" },
);

const patchSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  eventRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  diagnosticRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  auditRetentionDays: z.number().int().min(30).max(3650).nullable().optional(),
  settings: z
    .object({
      timezone: z.string().max(64).optional(),
      defaultAlertEmails: z.array(z.string().email()).max(10).optional(),
      syncStaleAfterHours: z.number().int().min(1).max(72).nullable().optional(),
      scanStaleAfterDays: z.number().int().min(1).max(60).nullable().optional(),
    })
    .optional(),
});

export const PATCH = withOrgAuth(
  async ({ req, principal, actor, requestId }) => {
    const body = await parseBody(req, patchSchema);
    return ok(await updateOrganization(principal.orgId, body, actor, requestId));
  },
  { permission: "organization:update" },
);
