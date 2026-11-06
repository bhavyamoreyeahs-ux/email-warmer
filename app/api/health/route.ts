/** Liveness: the process is up. No dependencies checked, no data returned. */
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json({ status: "ok", service: "quikreach-web", time: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
}
