/** Prometheus metrics for the web process. Requires `Authorization: Bearer $METRICS_TOKEN`. */
import { renderMetrics } from "@/lib/observability/metrics";
import { env } from "@/lib/env";
import { safeEqual } from "@/lib/crypto/hash";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const token = env().METRICS_TOKEN;
  const given = req.headers.get("authorization") ?? "";
  if (!token || !safeEqual(given, `Bearer ${token}`)) return new Response("Unauthorized", { status: 401 });
  return new Response(renderMetrics(), { headers: { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" } });
}
