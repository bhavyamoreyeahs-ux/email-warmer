import { AuthFrame } from "@/components/auth/auth-frame";
import { AcceptInvitation } from "@/components/auth/accept-invitation";
import { describeInvitation } from "@/lib/tenancy/invitations";
import { resolvePrincipal } from "@/lib/api/principal";
import { checkRateLimit } from "@/lib/ratelimit";
import { getClientIp } from "@/lib/api/session";
import { ipHash } from "@/lib/crypto/hash";
import { ROLE_LABELS } from "@/lib/rbac";

export const dynamic = "force-dynamic";
export const metadata = { title: "Accept invitation", referrer: "no-referrer" as const };

export default async function AcceptInvitationPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const rl = await checkRateLimit(`invite-view:${ipHash(await getClientIp()) ?? "local"}`, 30, 900);
  const info = token && token.length >= 20 && rl.allowed ? await describeInvitation(token) : { valid: false as const };
  if (!info.valid) {
    return (
      <AuthFrame title="Invitation unavailable">
        <p className="text-sm text-muted">This invitation link is invalid, expired, revoked or already used. Ask the person who invited you to send a new one.</p>
      </AuthFrame>
    );
  }
  const who = await resolvePrincipal();
  const signedInAs = who.status === "ok" ? who.principal.email : who.status === "no_membership" ? who.email : null;
  return (
    <AuthFrame title={`Join ${info.orgName}`} lede={`You've been invited as ${ROLE_LABELS[info.role].name} (${info.email}).`}>
      <AcceptInvitation token={token!} email={info.email} signedInAs={signedInAs} accountExists={info.accountExists} />
    </AuthFrame>
  );
}
