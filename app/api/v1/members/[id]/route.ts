import { z } from "zod";
import { ok } from "@/lib/api/responses";
import { withOrgAuth, noContent } from "@/lib/api/with-org-auth";
import { parseBody } from "@/lib/api/validation";
import { forbidden } from "@/lib/api/errors";
import { can } from "@/lib/rbac";
import { ROLES } from "@/lib/db/schema";
import { removeMember, setMemberStatus, updateMemberRole } from "@/lib/tenancy/members";

const patchSchema = z
  .object({ role: z.enum(ROLES).optional(), status: z.enum(["active", "disabled"]).optional(), reason: z.string().trim().max(500).optional() })
  .refine((v) => v.role || v.status, "Provide role or status.");

export const PATCH = withOrgAuth<{ id: string }>(
  async ({ req, params, principal, requestId }) => {
    const body = await parseBody(req, patchSchema);
    if (body.role) {
      if (!can(principal.role, "member:update")) throw forbidden();
      await updateMemberRole(principal, params.id, body.role, requestId);
    }
    if (body.status) {
      if (!can(principal.role, "member:disable")) throw forbidden();
      await setMemberStatus(principal, params.id, body.status, body.reason || "No reason given", requestId);
    }
    return ok({ id: params.id });
  },
  { permission: "member:view" },
);

export const DELETE = withOrgAuth<{ id: string }>(
  async ({ req, params, principal, requestId }) => {
    const reason = req.nextUrl.searchParams.get("reason") || "Removed by administrator";
    await removeMember(principal, params.id, reason.slice(0, 500), requestId);
    return noContent();
  },
  { permission: "member:disable" },
);
