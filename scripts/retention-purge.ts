/** Run retention once: `npm run retention:purge` (the worker also schedules it daily). */
import { purgeAll } from "@/lib/retention/purge";
import { closeDb } from "@/lib/db";

purgeAll()
  .then(async (r) => {
    console.log(JSON.stringify(r, null, 2));
    await closeDb();
  })
  .catch(async (error: unknown) => {
    console.error("[retention] failed:", error instanceof Error ? error.message : error);
    await closeDb();
    process.exit(1);
  });
