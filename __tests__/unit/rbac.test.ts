import { describe, expect, it } from "vitest";
import { can, canAssignRole, PERMISSIONS, ROLE_PERMISSIONS } from "@/lib/rbac";
import { ROLES } from "@/lib/db/schema";

describe("role permission matrix", () => {
  it("owners have every permission; only owners can delete the organization", () => {
    for (const p of PERMISSIONS) expect(can("owner", p)).toBe(true);
    for (const r of ROLES.filter((r) => r !== "owner")) expect(can(r, "organization:delete")).toBe(false);
  });

  it("analysts are read-only (plus exports)", () => {
    const writes = [...ROLE_PERMISSIONS.analyst].filter((p) => !p.endsWith(":view") && !p.endsWith(":export"));
    expect(writes).toEqual([]);
    expect(can("analyst", "audit:view")).toBe(false);
  });

  it("separation of duties: campaign managers cannot manage rules or approve post-critical resumes", () => {
    expect(can("campaign_manager", "alert_rule:manage")).toBe(false);
    expect(can("campaign_manager", "campaign:review")).toBe(false);
    expect(can("campaign_manager", "campaign:pause")).toBe(true);
    expect(can("deliverability_manager", "campaign:review")).toBe(true);
  });

  it("member and audit administration is limited to owners and admins", () => {
    for (const p of ["member:invite", "member:update", "member:disable", "audit:view", "integration:manage", "organization:update"] as const) {
      expect(ROLES.filter((r) => can(r, p)).sort()).toEqual(["admin", "owner"]);
    }
  });

  it("role assignment rules", () => {
    expect(canAssignRole("owner", "owner")).toBe(true);
    expect(canAssignRole("admin", "owner")).toBe(false);
    expect(canAssignRole("admin", "deliverability_manager")).toBe(true);
    expect(canAssignRole("deliverability_manager", "analyst")).toBe(false);
    expect(can(null, "domain:view")).toBe(false);
  });
});
