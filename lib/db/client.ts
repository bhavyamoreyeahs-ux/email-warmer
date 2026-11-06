/**
 * Database client.
 *
 * Production and local development use node-postgres against a real
 * PostgreSQL server. Tests swap in an in-memory PGlite instance (real Postgres
 * compiled to WASM) through `setDb`, so the same queries, constraints and
 * migrations are exercised without a server.
 *
 * Always import `db` from "@/lib/db" — the indirection is what lets tests swap
 * the client.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { Pool } from "pg";
import * as schema from "@/lib/db/schema";
import { env } from "@/lib/env";

export type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
/** Anything that can run a query: the root client or an open transaction. */
export type Executor = Db | Tx;

interface DbGlobal {
  __quikreachDb?: Db;
  __quikreachPool?: Pool;
}
const g = globalThis as unknown as DbGlobal;

function createPgDb(): Db {
  const { DATABASE_URL, DATABASE_POOL_MAX, DATABASE_SSL } = env();
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. See .env.example and README → Local development.");
  }
  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: DATABASE_POOL_MAX,
    ssl: DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
    statement_timeout: 30_000,
    idleTimeoutMillis: 30_000,
  });
  g.__quikreachPool = pool;
  // drizzle's node-postgres database is a PgDatabase over the node-postgres HKT;
  // widening to the driver-agnostic HKT is what lets PGlite stand in for tests.
  return drizzle(pool, { schema }) as unknown as Db;
}

function current(): Db {
  if (!g.__quikreachDb) g.__quikreachDb = createPgDb();
  return g.__quikreachDb;
}

/** Replace the client (tests). */
export function setDb(next: Db): void {
  g.__quikreachDb = next;
}

export async function closeDb(): Promise<void> {
  await g.__quikreachPool?.end();
  g.__quikreachPool = undefined;
  g.__quikreachDb = undefined;
}

export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const target = current();
    const value = Reflect.get(target, prop, target) as unknown;
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  },
});
