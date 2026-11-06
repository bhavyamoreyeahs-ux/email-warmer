/** Apply database migrations: `npm run db:migrate`. */
import { db, closeDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";

runMigrations(db)
  .then(async () => {
    console.log("[migrate] database is up to date");
    await closeDb();
  })
  .catch(async (error: unknown) => {
    console.error("[migrate] failed:", error instanceof Error ? error.message : error);
    await closeDb();
    process.exit(1);
  });
