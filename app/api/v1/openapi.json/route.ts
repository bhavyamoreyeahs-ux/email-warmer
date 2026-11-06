import { openApiDocument } from "@/lib/openapi";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export function GET() {
  return Response.json(openApiDocument(env().APP_URL), { headers: { "cache-control": "no-store" } });
}
