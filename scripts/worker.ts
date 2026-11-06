/**
 * Background worker process: `npm run worker`.
 * Exposes GET /healthz and GET /metrics (Bearer METRICS_TOKEN) on WORKER_HEALTH_PORT.
 */
import http from "node:http";
import { createWorker } from "@/lib/jobs/worker";
import { closeDb } from "@/lib/db";
import { env } from "@/lib/env";
import { renderMetrics } from "@/lib/observability/metrics";
import { logger } from "@/lib/observability/logger";

process.env.QUIKREACH_SERVICE = "quikreach-worker";

async function main() {
  const e = env();
  const worker = createWorker();
  const server =
    e.WORKER_HEALTH_PORT > 0
      ? http
          .createServer((req, res) => {
            if (req.url === "/healthz") {
              const beat = worker.state.lastHeartbeatAt?.getTime() ?? 0;
              const healthy = worker.state.running && Date.now() - beat < 60_000;
              res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
              res.end(JSON.stringify({ status: healthy ? "ok" : "unhealthy", worker: worker.state.id, inFlight: worker.state.inFlight, lastHeartbeatAt: worker.state.lastHeartbeatAt, lastTickAt: worker.state.lastTickAt }));
              return;
            }
            if (req.url === "/metrics") {
              if (!e.METRICS_TOKEN || req.headers.authorization !== `Bearer ${e.METRICS_TOKEN}`) {
                res.writeHead(401).end();
                return;
              }
              res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
              res.end(renderMetrics());
              return;
            }
            res.writeHead(404).end();
          })
          .listen(e.WORKER_HEALTH_PORT, "0.0.0.0", () => logger.info("worker_health_listening", { port: e.WORKER_HEALTH_PORT }))
      : null;

  const shutdown = async (signal: string) => {
    logger.info("worker_shutdown", { signal });
    await worker.stop();
    server?.close();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  await worker.start();
}

main().catch((error: unknown) => {
  console.error("[worker] fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
