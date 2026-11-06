/**
 * Server-side authorization and tenant isolation through real route handlers.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/api/session", () => ({
  ORG_COOKIE: "qr_org",
  getSessionIdentity: vi.fn(),
  getSelectedOrgId: vi.fn(),
  getClientIp: vi.fn().mockResolvedValue(null),
}));

import { createTestDb } from "../helpers/db";
import { makeDomain, makeMailbox, makeMember, makeOrg, makeTenant, makeUser } from "../helpers/factories";
import { json, params, req, signInAs } from "../helpers/session";
import { db } from "@/lib/db";
import { auditLogs, memberships, users } from "@/lib/db/schema";
import * as domainsRoute from "@/app/api/v1/domains/route";
import * as domainRoute from "@/app/api/v1/domains/[id]/route";
import * as mailboxRoute from "@/app/api/v1/mailboxes/[id]/route";
import * as auditRoute from "@/app/api/v1/audit/route";
import * as membersRoute from "@/app/api/v1/members/[id]/route";
import * as eventsExport from "@/app/api/v1/events/export/route";
import * as rulesRoute from "@/app/api/v1/alert-rules/route";

describe("authorization & tenant isolation", () => {
  let a: Awaited<ReturnType<typeof makeTenant>>;
  let b: Awaited<ReturnType<typeof makeTenant>>;
  let domainB: Awaited<ReturnType<typeof makeDomain>>;

  beforeAll(async () => {
    await createTestDb();
    a = await makeTenant("owner");
    b = await makeTenant("owner");
    domainB = await makeDomain(b.org.id, "tenant-b.example.com");
    await makeDomain(a.org.id, "tenant-a.example.com");
  });

  it("401 without a session", async () => {
    signInAs(null);
    const res = await domainsRoute.GET(req("/api/v1/domains"));
    expect(res.status).toBe(401);
    expect((await json(res)).code).toBe("UNAUTHORIZED");
  });

  it("lists only the caller's tenant data", async () => {
    signInAs(a.user.id);
    const body = await json(await domainsRoute.GET(req("/api/v1/domains")));
    const names = (body.data as Array<{ name: string }>).map((d) => d.name);
    expect(names).toEqual(["tenant-a.example.com"]);
  });

  it("another tenant's record id is indistinguishable from a missing one (404)", async () => {
    signInAs(a.user.id);
    const res = await domainRoute.GET(req(`/api/v1/domains/${domainB.id}`), params({ id: domainB.id }));
    expect(res.status).toBe(404);
    const mbx = await makeMailbox(b.org.id);
    const res2 = await mailboxRoute.GET(req(`/api/v1/mailboxes/${mbx.id}`), params({ id: mbx.id }));
    expect(res2.status).toBe(404);
  });

  it("a selected-org cookie for an org the user doesn't belong to is NOT authorization", async () => {
    signInAs(a.user.id, { selectedOrgId: b.org.id });
    const body = await json(await domainsRoute.GET(req("/api/v1/domains")));
    expect((body.data as Array<{ name: string }>).map((d) => d.name)).toEqual(["tenant-a.example.com"]);
  });

  it("cross-tenant delete has no effect", async () => {
    signInAs(a.user.id);
    const res = await domainRoute.DELETE(req(`/api/v1/domains/${domainB.id}?reason=test`, { method: "DELETE" }), params({ id: domainB.id }));
    expect(res.status).toBe(404);
    signInAs(b.user.id);
    expect((await domainRoute.GET(req(`/api/v1/domains/${domainB.id}`), params({ id: domainB.id }))).status).toBe(200);
  });

  it("read-only analysts cannot mutate; denial is audited", async () => {
    const analyst = await makeUser();
    await makeMember(a.org.id, analyst.id, "analyst");
    signInAs(analyst.id);
    const list = await domainsRoute.GET(req("/api/v1/domains"));
    expect(list.status).toBe(200);
    const res = await domainsRoute.POST(req("/api/v1/domains", { method: "POST", body: { name: "new.example.com" } }));
    expect(res.status).toBe(403);
    const denied = await db.select().from(auditLogs).where(eq(auditLogs.actorUserId, analyst.id));
    expect(denied.some((r) => r.action === "authz.denied" && r.outcome === "denied")).toBe(true);
    // analysts may export (read-only role), but not see the audit log
    expect((await eventsExport.GET(req("/api/v1/events/export"))).status).toBe(200);
    expect((await auditRoute.GET(req("/api/v1/audit"))).status).toBe(403);
  });

  it("campaign managers cannot change alert rules", async () => {
    const cm = await makeUser();
    await makeMember(a.org.id, cm.id, "campaign_manager");
    signInAs(cm.id);
    const res = await rulesRoute.POST(
      req("/api/v1/alert-rules", { method: "POST", body: { name: "x rule", metric: "complaint_count", threshold: 1, windowMinutes: 60, severity: "info", notificationTargets: { inApp: true, emails: [] } } }),
    );
    expect(res.status).toBe(403);
  });

  it("disabled memberships lose access immediately", async () => {
    const u = await makeUser();
    const m = await makeMember(a.org.id, u.id, "deliverability_manager");
    signInAs(u.id);
    expect((await domainsRoute.GET(req("/api/v1/domains"))).status).toBe(200);
    await db.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, m.id));
    const res = await domainsRoute.GET(req("/api/v1/domains"));
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("NO_MEMBERSHIP");
  });

  it("disabled users and revoked sessions are treated as signed out", async () => {
    const u = await makeUser();
    await makeMember(a.org.id, u.id, "analyst");
    signInAs(u.id, { sessionVersion: 0 });
    expect((await domainsRoute.GET(req("/api/v1/domains"))).status).toBe(200);
    await db.update(users).set({ sessionVersion: 1 }).where(eq(users.id, u.id));
    expect((await domainsRoute.GET(req("/api/v1/domains"))).status).toBe(401);
    await db.update(users).set({ sessionVersion: 0, status: "disabled" }).where(eq(users.id, u.id));
    expect((await domainsRoute.GET(req("/api/v1/domains"))).status).toBe(401);
  });

  it("rejects cross-site mutations (Origin check)", async () => {
    signInAs(a.user.id);
    const res = await domainsRoute.POST(req("/api/v1/domains", { method: "POST", body: { name: "x.example.com" }, origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("CSRF_REJECTED");
    const noOrigin = await domainsRoute.POST(req("/api/v1/domains", { method: "POST", body: { name: "x.example.com" }, origin: null }));
    expect(noOrigin.status).toBe(403);
  });

  it("admins cannot grant the owner role; the last owner cannot be demoted", async () => {
    const admin = await makeUser();
    await makeMember(a.org.id, admin.id, "admin");
    const target = await makeUser();
    const tm = await makeMember(a.org.id, target.id, "analyst");
    signInAs(admin.id);
    const res = await membersRoute.PATCH(req(`/api/v1/members/${tm.id}`, { method: "PATCH", body: { role: "owner" } }), params({ id: tm.id }));
    expect(res.status).toBe(403);
    signInAs(a.user.id);
    const ownerRes = await membersRoute.PATCH(req(`/api/v1/members/${a.membership.id}`, { method: "PATCH", body: { role: "admin" } }), params({ id: a.membership.id }));
    expect(ownerRes.status).toBe(409);
  });

  it("demo workspaces reject live-data operations", async () => {
    const demo = await makeOrg({ isDemo: true });
    const u = await makeUser();
    await makeMember(demo.id, u.id, "owner");
    signInAs(u.id);
    const res = await domainsRoute.POST(req("/api/v1/domains", { method: "POST", body: { name: "live.example.com" } }));
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("DEMO_WORKSPACE");
  });

  it("validates input and never leaks internals", async () => {
    signInAs(a.user.id);
    const res = await domainsRoute.POST(req("/api/v1/domains", { method: "POST", body: { name: "not a domain" } }));
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.success).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/at .*\.ts:\d+/);
  });
});
