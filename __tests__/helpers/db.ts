/**
 * In-memory PostgreSQL (PGlite) per test file, with the real migrations applied.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import * as schema from "@/lib/db/schema";
import { setDb, type Db } from "@/lib/db/client";

export async function createTestDb(): Promise<{ db: Db; client: PGlite }> {
  const client = new PGlite();
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder: path.resolve(__dirname, "../../db/migrations") });
  // PGlite's drizzle database is a PgDatabase over a different result HKT; the
  // query surface used by the app is identical.
  const db = database as unknown as Db;
  setDb(db);
  return { db, client };
}
