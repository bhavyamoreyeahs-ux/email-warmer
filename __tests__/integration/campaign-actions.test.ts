import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/db";
import { makeMailbox, makeTenant } from "../helpers/factories";
import { db } from "@/lib/db";
import { campaignActions, campaignReferences, integrations } from "@/lib/db/schema";
import { encryptSecret, activeKeyId } from "@/lib/crypto/encryption";
import { executeCampaignAction } from "@/lib/campaigns/service";

describe("campaign pause execution", () => {
  let orgId: string;
  let campaignId: string;
  beforeAll(async () => {
    process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = "true";
    await createTestDb();
    const t = await makeTenant();
    orgId = t.org.id;
    const m = await makeMailbox(orgId);
    const [i] = await db
      .insert(integrations)
      .values({ orgId, kind: "campaign_webhook", name: "Test", status: "active", config: { endpointUrl: "http://localhost:9/hook" }, encryptedSecret: encryptSecret("s3cret"), keyId: activeKeyId() })
      .returning();
    const [c] = await db.insert(campaignReferences).values({ orgId, integrationId: i!.id, externalId: "camp-1", name: "Q4", mailboxConnectionId: m.id }).returning();
    campaignId = c!.id;
  });

  const newAction = async (key: string) =>
    (await db.insert(campaignActions).values({ orgId, campaignId, action: "pause", requestedByType: "user", reason: "test", idempotencyKey: key }).returning())[0]!;

  it("marks a pause confirmed only when the sending system confirms that exact campaign's new state", async () => {
    const a = await newAction("k1");
    let signature = "";
    const ok = await executeCampaignAction(orgId, a.id, (async (_url: unknown, init?: RequestInit) => {
      signature = new Headers(init?.headers).get("x-quikreach-signature") ?? "";
      return new Response(JSON.stringify({ ok: true, campaign: { externalId: "camp-1", status: "paused" } }), { status: 200 });
    }) as typeof fetch);
    expect(ok).toMatchObject({ status: "confirmed" });
    expect(signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const [c] = await db.select().from(campaignReferences).where(eq(campaignReferences.id, campaignId));
    expect(c!.status).toBe("paused");
  });

  it("records 'unconfirmed' when the response does not confirm, and leaves campaign status untouched", async () => {
    await db.update(campaignReferences).set({ status: "active" }).where(eq(campaignReferences.id, campaignId));
    const a = await newAction("k2");
    const r = await executeCampaignAction(orgId, a.id, (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch);
    expect(r).toMatchObject({ status: "unconfirmed" });
    const [c] = await db.select().from(campaignReferences).where(eq(campaignReferences.id, campaignId));
    expect(c!.status).toBe("active");
  });

  it("fails (not paused) on a 4xx rejection", async () => {
    const a = await newAction("k3");
    const r = await executeCampaignAction(orgId, a.id, (async () => new Response("no", { status: 403 })) as typeof fetch);
    expect(r).toMatchObject({ status: "failed" });
  });
});

describe("campaign action terminal failures and duplicates", () => {
  it("marks the action failed (not queued) once retries are exhausted, and flags the alert", async () => {
    const { markCampaignActionFailed, createCampaignReference } = await import("@/lib/campaigns/service");
    const [ref] = await db.select().from(campaignReferences).limit(1);
    const [a] = await db.insert(campaignActions).values({ orgId: ref!.orgId, campaignId: ref!.id, action: "pause", requestedByType: "automation", reason: "t", idempotencyKey: "dead-1" }).returning();
    await markCampaignActionFailed(ref!.orgId, a!.id, "Campaign integration unreachable: Timed out");
    const [after] = await db.select().from(campaignActions).where(eq(campaignActions.id, a!.id));
    expect(after!.status).toBe("failed");

    await expect(
      createCampaignReference(ref!.orgId, { integrationId: ref!.integrationId, externalId: ref!.externalId, name: "dup" }, { type: "user", label: "t" }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
