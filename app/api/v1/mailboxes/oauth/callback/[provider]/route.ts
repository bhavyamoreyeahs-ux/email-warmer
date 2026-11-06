/**
 * OAuth redirect target. Not wrapped in withOrgAuth (the provider redirects the
 * browser here), but it requires the same signed-in session that started the
 * flow and re-checks membership + permission inside completeMailboxOAuth.
 * Only an error CODE is placed in the redirect URL, never provider text.
 */
import { NextResponse, type NextRequest } from "next/server";
import { kickWorker } from "@/lib/jobs/kick";
import { completeMailboxOAuth } from "@/lib/mailboxes/oauth";
import { getSessionIdentity } from "@/lib/api/session";
import { env } from "@/lib/env";
import { reportError } from "@/lib/observability/logger";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const base = env().APP_URL;
  if (provider !== "google" && provider !== "microsoft") return NextResponse.redirect(`${base}/mailboxes?oauth_error=unsupported_provider`);
  const p = req.nextUrl.searchParams;
  try {
    const identity = await getSessionIdentity();
    const result = await completeMailboxOAuth({ provider, sessionUserId: identity?.userId ?? null, code: p.get("code"), state: p.get("state"), providerError: p.get("error") });
    if (result.ok) kickWorker();
    if (result.ok) return NextResponse.redirect(`${base}/mailboxes/${result.connectionId}?${result.reconnected ? "reconnected" : "connected"}=1`);
    return NextResponse.redirect(`${base}/mailboxes?oauth_error=${encodeURIComponent(result.code.replace(/[^a-z_]/g, "").slice(0, 40))}`);
  } catch (error: unknown) {
    reportError(error, { route: "oauth.callback", provider });
    return NextResponse.redirect(`${base}/mailboxes?oauth_error=internal_error`);
  }
}
