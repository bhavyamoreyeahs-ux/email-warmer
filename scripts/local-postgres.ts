/**
 * Local PostgreSQL without Docker — DEVELOPMENT ONLY.
 *
 * Uses the `embedded-postgres` package (real PostgreSQL binaries distributed via
 * npm) to run a server on localhost. Docker Compose (`docker compose up db`) is
 * the preferred path when Docker is available; this exists so a developer
 * machine without Docker can still run the full stack (app + worker share one
 * real Postgres server, exactly as in production).
 *
 * Data lives in ./.data/postgres (git-ignored). Stop with Ctrl+C.
 */
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import path from "node:path";

const port = Number(process.env.LOCAL_PG_PORT ?? 54329);
const databaseDir = path.resolve(process.cwd(), ".data/postgres");
const user = "quikreach";
const password = "quikreach_local_dev_only";
const database = "quikreach";

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir,
    user,
    password,
    port,
    persistent: true,
    onLog: () => undefined,
  });

  const fresh = !existsSync(path.join(databaseDir, "PG_VERSION"));
  if (fresh) {
    console.log(`[local-postgres] initialising cluster in ${databaseDir}`);
    await pg.initialise();
  }
  await pg.start();
  if (fresh) {
    await pg.createDatabase(database);
    await pg.createDatabase(`${database}_test`);
  }
  console.log(`[local-postgres] ready: postgres://${user}:${password}@127.0.0.1:${port}/${database}`);
  console.log("[local-postgres] DEVELOPMENT ONLY — press Ctrl+C to stop");

  const stop = async () => {
    console.log("\n[local-postgres] stopping…");
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // Keep the process alive.
  setInterval(() => undefined, 1 << 30);
}

main().catch((error: unknown) => {
  console.error("[local-postgres] failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
