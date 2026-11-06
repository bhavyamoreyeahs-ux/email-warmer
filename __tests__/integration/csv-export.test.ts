import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/session", () => ({ ORG_COOKIE: "qr_org", getSessionIdentity: vi.fn(), getSelectedOrgId: vi.fn(), getClientIp: vi.fn() }));

import { createTestDb } from "../helpers/db";
import { makeMailbox, makeTenant } from "../helpers/factories";
import { req, signInAs } from "../helpers/session";
import { ingestSignals } from "@/lib/events/ingest";
import { escapeCsvCell, toCsv } from "@/lib/reports/csv";
import * as exportRoute from "@/app/api/v1/events/export/route";

describe("CSV safety", () => {
  it("neutralises spreadsheet formulas and quotes every cell", () => {
    expect(escapeCsvCell("=HYPERLINK(\"http://x\")")).toBe(`"'=HYPERLINK(""http://x"")"`);
    for (const p of ["+1", "-1+1", "@SUM(A1)", "\tcmd", "\rcmd"]) expect(escapeCsvCell(p).startsWith(`"'`)).toBe(true);
    expect(escapeCsvCell(null)).toBe('""');
    expect(toCsv([{ a: "x,y" }], [{ key: "a", header: "A" }])).toBe('"A"\r\n"x,y"\r\n');
  });
});

describe("events CSV export", () => {
  let a: Awaited<ReturnType<typeof makeTenant>>;
  beforeAll(async () => {
    await createTestDb();
    a = await makeTenant();
    const b = await makeTenant();
    const ca = await makeMailbox(a.org.id);
    const cb = await makeMailbox(b.org.id);
    const s = (ref: string, category: "hard_bounce" | "reply", who: string) => ({ providerMessageRef: ref, category, occurredAt: new Date(), counterpartyAddress: who, confidence: "medium" as const, classificationBasis: "=cmd|' /C calc'!A0", diagnosticCode: null, metadata: {} });
    await ingestSignals({ orgId: a.org.id, connectionId: ca.id, domainId: null, provider: "google", source: "gmail_api" }, [s("a1", "hard_bounce", "x@one.example"), s("a2", "reply", "y@two.example")]);
    await ingestSignals({ orgId: b.org.id, connectionId: cb.id, domainId: null, provider: "google", source: "gmail_api" }, [s("b1", "hard_bounce", "z@other-tenant.example")]);
  });

  it("applies the active filters and the caller's tenant scope", async () => {
    signInAs(a.user.id);
    const res = await exportRoute.GET(req("/api/v1/events/export?category=hard_bounce"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    const lines = text.trim().split("\r\n");
    expect(lines).toHaveLength(2); // header + one hard bounce from tenant A
    expect(text).toContain("one.example");
    expect(text).not.toContain("two.example"); // filtered out (reply)
    expect(text).not.toContain("other-tenant.example"); // other tenant
    expect(text).toContain(`"'=cmd`); // formula neutralised
  });
});
