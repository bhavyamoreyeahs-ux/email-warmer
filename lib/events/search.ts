/**
 * Event search — the same filter object drives the UI table and the CSV
 * export, so an export always reflects exactly what the user filtered.
 */
import { and, desc, eq, gte, inArray, lt, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { EVENT_CATEGORIES, PROVIDERS, domains, mailboxConnections, providerEvents } from "@/lib/db/schema";

export const eventFilterSchema = z.object({
  provider: z.enum(PROVIDERS).optional(),
  domainId: z.string().uuid().optional(),
  connectionId: z.string().uuid().optional(),
  category: z
    .union([z.enum(EVENT_CATEGORIES), z.array(z.enum(EVENT_CATEGORIES))])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  // z.coerce.boolean would turn the string "false" into true.
  includeSent: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0", "on", "off"])])
    .optional()
    .transform((v) => (typeof v === "boolean" ? v : v === undefined ? undefined : ["true", "1", "on"].includes(v))),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type EventFilters = z.infer<typeof eventFilterSchema>;

export function parseEventFilters(params: URLSearchParams): EventFilters {
  const raw: Record<string, unknown> = {};
  for (const key of ["provider", "domainId", "connectionId", "from", "to", "includeSent", "limit", "offset"]) {
    const v = params.get(key);
    if (v !== null && v !== "") raw[key] = v;
  }
  const cats = params.getAll("category").filter(Boolean);
  if (cats.length) raw.category = cats;
  return eventFilterSchema.parse(raw);
}

function conditions(orgId: string, f: EventFilters): SQL[] {
  const conds: SQL[] = [eq(providerEvents.orgId, orgId)];
  if (f.provider) conds.push(eq(providerEvents.provider, f.provider));
  if (f.domainId) conds.push(eq(providerEvents.domainId, f.domainId));
  if (f.connectionId) conds.push(eq(providerEvents.connectionId, f.connectionId));
  if (f.category?.length) conds.push(inArray(providerEvents.category, f.category));
  else if (!f.includeSent) conds.push(inArray(providerEvents.category, EVENT_CATEGORIES.filter((c) => c !== "sent")));
  if (f.from) conds.push(gte(providerEvents.occurredAt, f.from));
  if (f.to) conds.push(lt(providerEvents.occurredAt, f.to));
  return conds;
}

const columns = {
  id: providerEvents.id,
  occurredAt: providerEvents.occurredAt,
  ingestedAt: providerEvents.ingestedAt,
  category: providerEvents.category,
  provider: providerEvents.provider,
  source: providerEvents.source,
  confidence: providerEvents.confidence,
  classificationBasis: providerEvents.classificationBasis,
  diagnosticCode: providerEvents.diagnosticCode,
  recipientDomain: providerEvents.recipientDomain,
  connectionId: providerEvents.connectionId,
  mailbox: mailboxConnections.emailAddress,
  domain: domains.name,
  isDemo: providerEvents.isDemo,
};

export async function searchEvents(orgId: string, f: EventFilters) {
  const rows = await db
    .select(columns)
    .from(providerEvents)
    .leftJoin(mailboxConnections, eq(mailboxConnections.id, providerEvents.connectionId))
    .leftJoin(domains, eq(domains.id, providerEvents.domainId))
    .where(and(...conditions(orgId, f)))
    .orderBy(desc(providerEvents.occurredAt))
    .limit(f.limit + 1)
    .offset(f.offset);
  return { rows: rows.slice(0, f.limit), hasMore: rows.length > f.limit };
}

/** Bounded export (max 50k rows) honouring the same filters. */
export async function exportEvents(orgId: string, f: EventFilters, maxRows = 50_000) {
  const rows = await db
    .select(columns)
    .from(providerEvents)
    .leftJoin(mailboxConnections, eq(mailboxConnections.id, providerEvents.connectionId))
    .leftJoin(domains, eq(domains.id, providerEvents.domainId))
    .where(and(...conditions(orgId, f)))
    .orderBy(desc(providerEvents.occurredAt))
    .limit(maxRows + 1);
  return { rows: rows.slice(0, maxRows), truncated: rows.length > maxRows };
}

export const EVENT_CSV_COLUMNS = [
  { key: "occurredAt", header: "occurred_at" },
  { key: "category", header: "category" },
  { key: "provider", header: "provider" },
  { key: "mailbox", header: "mailbox" },
  { key: "domain", header: "sending_domain" },
  { key: "recipientDomain", header: "recipient_domain" },
  { key: "confidence", header: "classification_confidence" },
  { key: "classificationBasis", header: "classification_basis" },
  { key: "diagnosticCode", header: "diagnostic_code" },
  { key: "source", header: "source" },
  { key: "isDemo", header: "is_demo_data" },
  { key: "ingestedAt", header: "ingested_at" },
  { key: "id", header: "event_id" },
] as const;
