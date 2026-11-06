"use client";

/** Member role change and invitation forms. */
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/ui/api";
import { buttonStyles, Callout } from "@/components/ui/primitives";
import { ActionButton, ResultMessage } from "@/components/ui/interactive";
import { CopyField } from "@/components/integrations/copy-field";
import { hintCls, inputCls, labelCls, labelTextCls } from "@/components/settings/fields";

export interface RoleOption {
  value: string;
  label: string;
}

/* ─── Role change ─────────────────────────────────────────────────────── */

export function MemberRoleSelect({ membershipId, memberName, currentRole, options }: { membershipId: string; memberName: string; currentRole: string; options: RoleOption[] }) {
  const id = useId();
  const [role, setRole] = useState(currentRole);
  const label = (v: string) => options.find((o) => o.value === v)?.label ?? v.replace(/_/g, " ");
  return (
    <div className="flex flex-wrap items-start gap-2">
      <label htmlFor={id} className="sr-only">
        Role for {memberName}
      </label>
      <select id={id} className="rounded-md border border-line bg-panel px-2 py-1.5 text-sm text-ink" value={role} onChange={(e) => setRole(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ActionButton
        label="Apply"
        method="PATCH"
        path={`/api/v1/members/${membershipId}`}
        body={{ role }}
        disabled={role === currentRole}
        disabledReason="Choose a different role first."
        confirm={{
          title: `Change ${memberName}'s role?`,
          description: `${memberName} will change from ${label(currentRole)} to ${label(role)}. Their permissions change on their next request. This is recorded in the audit log.`,
          confirmLabel: "Change role",
        }}
        successMessage={`Role changed to ${label(role)}.`}
      />
    </div>
  );
}

/* ─── Invite ──────────────────────────────────────────────────────────── */

interface InviteResult {
  invitation: { id: string; email: string; role: string; expiresAt: string };
  acceptUrl: string;
  emailStatus: "sent" | "not_configured" | "failed";
}

export function InviteForm({ roles }: { roles: RoleOption[] }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState(roles.find((r) => r.value === "analyst")?.value ?? roles[roles.length - 1]?.value ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ ok: boolean; message: string } | null>(null);
  const [created, setCreated] = useState<InviteResult | null>(null);
  const roleLabel = (v: string) => roles.find((r) => r.value === v)?.label ?? v.replace(/_/g, " ");

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCreated(null);
    const r = await api<InviteResult>("/api/v1/invitations", { method: "POST", body: { email: email.trim(), role } });
    setBusy(false);
    if (r.success) {
      setCreated(r.data);
      setEmail("");
      router.refresh();
    } else {
      setError({ ok: false, message: r.error });
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="space-y-3">
        <fieldset disabled={busy} className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_minmax(0,220px)]">
          <legend className="sr-only">Invite a member</legend>
          <label className={labelCls}>
            <span className={labelTextCls}>Email address</span>
            <input className={inputCls} type="email" autoComplete="off" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
          </label>
          <label className={labelCls}>
            <span className={labelTextCls}>Role</span>
            <select className={inputCls} value={role} onChange={(e) => setRole(e.target.value)}>
              {roles.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
        <p className={hintCls}>The invitation link works once and expires after 7 days. Inviting the same address again replaces any pending invitation.</p>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={buttonStyles.primary} disabled={busy || !email.trim() || !role}>
            {busy ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}
            Send invitation
          </button>
          <ResultMessage result={error} />
        </div>
      </form>

      {created ? (
        <div className="space-y-3 rounded-lg border border-line bg-canvas/50 p-4" role="region" aria-label="Invitation created">
          <p role="status" className="text-sm text-emerald-700">
            Invitation created for {created.invitation.email} as {roleLabel(created.invitation.role)}.
          </p>
          {created.emailStatus === "sent" ? (
            <Callout tone="info">The invitation email was sent to {created.invitation.email}. You can also share the link below.</Callout>
          ) : created.emailStatus === "not_configured" ? (
            <Callout tone="warn">Email is not configured — copy the link and send it yourself.</Callout>
          ) : (
            <Callout tone="bad">The invitation email could not be sent — copy the link and send it yourself.</Callout>
          )}
          <CopyField
            label="One-time accept link"
            value={created.acceptUrl}
            description={`Shown only now. Anyone with this link can accept the invitation for ${created.invitation.email} until it is used, revoked or expires.`}
          />
          <button type="button" className={buttonStyles.secondary} onClick={() => setCreated(null)}>
            Done
          </button>
        </div>
      ) : null}
    </div>
  );
}
