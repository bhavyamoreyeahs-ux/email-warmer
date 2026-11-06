import { UserMinus, UserCheck, UserX } from "lucide-react";
import { requirePage } from "@/lib/auth/page";
import { listMembers } from "@/lib/tenancy/members";
import { listInvitations } from "@/lib/tenancy/invitations";
import { can, canAssignRole, ROLE_LABELS } from "@/lib/rbac";
import { ROLES, type Role } from "@/lib/db/schema";
import { Callout, Card, EmptyState, PageHeader, PermissionDenied, Pill, Table, Td } from "@/components/ui/primitives";
import { ActionButton } from "@/components/ui/interactive";
import { SettingsNav } from "@/components/settings/settings-nav";
import { Notice, readNotice } from "@/components/settings/notice";
import { InviteForm, MemberRoleSelect } from "@/components/settings/member-forms";
import { dateTime, relativeTime } from "@/lib/ui/format";

export const metadata = { title: "Members" };

type Tone = React.ComponentProps<typeof Pill>["tone"];
type InvitationRow = Awaited<ReturnType<typeof listInvitations>>[number];
type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

const INVITATION_STATUS: Record<InvitationStatus, { tone: Tone; label: string }> = {
  pending: { tone: "info", label: "Pending" },
  accepted: { tone: "good", label: "Accepted" },
  revoked: { tone: "unknown", label: "Revoked" },
  expired: { tone: "stale", label: "Expired" },
};

function invitationStatus(inv: InvitationRow, now: Date): InvitationStatus {
  if (inv.acceptedAt) return "accepted";
  if (inv.revokedAt) return "revoked";
  if (inv.expiresAt.getTime() <= now.getTime()) return "expired";
  return "pending";
}

const roleName = (r: Role) => ROLE_LABELS[r].name;

const NOTICES: Record<string, string> = {
  removed: "Member removed. They no longer have access to this workspace.",
  "invitation-revoked": "Invitation revoked. Its accept link no longer works.",
};

export default async function MembersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { principal, allowed } = await requirePage("member:view");
  const header = <PageHeader title="Members" lede="People with access to this workspace, their roles, and pending invitations." />;
  if (!allowed) {
    return (
      <>
        {header}
        <SettingsNav role={principal.role} />
        <PermissionDenied permission="member:view" />
      </>
    );
  }

  const notice = readNotice((await searchParams).notice, NOTICES);
  const [members, invitations] = await Promise.all([listMembers(principal.orgId), listInvitations(principal.orgId)]);
  const now = new Date();
  const canUpdate = can(principal.role, "member:update");
  const canDisable = can(principal.role, "member:disable");
  const canInvite = can(principal.role, "member:invite");
  const assignable = ROLES.filter((r) => canAssignRole(principal.role, r)).map((r) => ({ value: r, label: roleName(r) }));

  return (
    <>
      {header}
      <SettingsNav role={principal.role} />
      <Notice message={notice} />

      <Card title="Members" description={`${members.filter((m) => m.status === "active").length} active of ${members.length}`} padded={false}>
        <Table caption="Workspace members" head={["Name", "Email", "Role", "Status", "Last sign-in", "Actions"]}>
          {members.map((m) => {
            const isSelf = m.userId === principal.userId;
            const manageable = !isSelf && canAssignRole(principal.role, m.role);
            const ownerProtected = !isSelf && !canAssignRole(principal.role, m.role) && (canUpdate || canDisable);
            return (
              <tr key={m.id}>
                <Td>
                  <span className="font-medium text-ink">{m.name || "—"}</span>
                  {isSelf ? (
                    <span className="ml-2">
                      <Pill tone="info">You</Pill>
                    </span>
                  ) : null}
                </Td>
                <Td className="break-all">{m.email}</Td>
                <Td>
                  {canUpdate && manageable ? (
                    <MemberRoleSelect membershipId={m.id} memberName={m.name || m.email} currentRole={m.role} options={assignable} />
                  ) : (
                    <span className="text-ink">{roleName(m.role)}</span>
                  )}
                </Td>
                <Td>{m.status === "active" ? <Pill tone="good">Active</Pill> : <Pill tone="unknown">Disabled</Pill>}</Td>
                <Td className="whitespace-nowrap">
                  {m.lastLoginAt ? <span title={dateTime(m.lastLoginAt)}>{relativeTime(m.lastLoginAt)}</span> : <span className="text-muted">Never</span>}
                </Td>
                <Td>
                  {isSelf ? (
                    <span className="text-xs text-muted">You cannot change your own role or access here.</span>
                  ) : canDisable && manageable ? (
                    <div className="flex flex-wrap items-start gap-2">
                      {m.status === "active" ? (
                        <ActionButton
                          label="Disable"
                          icon={<UserX aria-hidden className="h-4 w-4" />}
                          method="PATCH"
                          path={`/api/v1/members/${m.id}`}
                          body={{ status: "disabled" }}
                          confirm={{
                            title: `Disable ${m.name || m.email}?`,
                            description: "They lose access to this workspace on their next request. Their membership and history are kept, and you can enable them again.",
                            confirmLabel: "Disable member",
                            requireReason: true,
                          }}
                          successMessage="Member disabled."
                        />
                      ) : (
                        <ActionButton
                          label="Enable"
                          icon={<UserCheck aria-hidden className="h-4 w-4" />}
                          method="PATCH"
                          path={`/api/v1/members/${m.id}`}
                          body={{ status: "active" }}
                          confirm={{
                            title: `Enable ${m.name || m.email}?`,
                            description: `They regain access with the ${roleName(m.role)} role.`,
                            confirmLabel: "Enable member",
                            requireReason: true,
                          }}
                          successMessage="Member enabled."
                        />
                      )}
                      <ActionButton
                        label="Remove"
                        variant="danger"
                        icon={<UserMinus aria-hidden className="h-4 w-4" />}
                        method="DELETE"
                        path={`/api/v1/members/${m.id}`}
                        confirm={{
                          title: `Remove ${m.name || m.email} from this workspace?`,
                          description: "Their membership is deleted and they lose access immediately. Audit history is kept. To give access again you must send a new invitation.",
                          confirmLabel: "Remove member",
                          requireReason: true,
                        }}
                        successMessage="Member removed."
                        redirectTo="/settings/members?notice=removed"
                      />
                    </div>
                  ) : ownerProtected ? (
                    <span className="text-xs text-muted">Only an Owner can manage another Owner.</span>
                  ) : (
                    <span className="text-xs text-muted">—</span>
                  )}
                </Td>
              </tr>
            );
          })}
        </Table>
        <p className="border-t border-line px-4 py-3 text-xs text-muted">A workspace always keeps at least one active Owner; changes that would remove the last one are refused.</p>
      </Card>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-5">
        <Card title="Invitations" className="lg:col-span-3" padded={false}>
          {invitations.length ? (
            <Table caption="Invitations" head={["Email", "Role", "Status", "Expires", "Actions"]}>
              {invitations.map((inv) => {
                const status = invitationStatus(inv, now);
                const st = INVITATION_STATUS[status];
                return (
                  <tr key={inv.id}>
                    <Td className="break-all">
                      {inv.email}
                      <div className="text-xs text-muted">Sent {dateTime(inv.createdAt)}</div>
                    </Td>
                    <Td>{roleName(inv.role)}</Td>
                    <Td>
                      <Pill tone={st.tone}>{st.label}</Pill>
                      {inv.acceptedAt ? <div className="mt-1 text-xs text-muted">{dateTime(inv.acceptedAt)}</div> : null}
                    </Td>
                    <Td className="whitespace-nowrap">{status === "pending" ? <span title={dateTime(inv.expiresAt)}>{relativeTime(inv.expiresAt, now.getTime())}</span> : dateTime(inv.expiresAt)}</Td>
                    <Td>
                      {status === "pending" && canInvite ? (
                        <ActionButton
                          label="Revoke"
                          variant="danger"
                          method="DELETE"
                          path={`/api/v1/invitations/${inv.id}`}
                          confirm={{
                            title: `Revoke the invitation for ${inv.email}?`,
                            description: "The accept link stops working immediately. You can send a new invitation later.",
                            confirmLabel: "Revoke invitation",
                          }}
                          successMessage="Invitation revoked."
                          redirectTo="/settings/members?notice=invitation-revoked"
                        />
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </Table>
          ) : (
            <EmptyState title="No invitations yet">Invitations you send appear here with their status.</EmptyState>
          )}
        </Card>

        <Card title="Invite a member" className="lg:col-span-2">
          {canInvite && assignable.length ? (
            <InviteForm roles={assignable} />
          ) : (
            <Callout tone="unknown">Inviting members needs member:invite (Owners and Administrators).</Callout>
          )}
        </Card>
      </div>
    </>
  );
}
