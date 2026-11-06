import Link from "next/link";
import { Inbox } from "lucide-react";
import { requirePage } from "@/lib/auth/page";
import { can } from "@/lib/rbac";
import { listMailboxes } from "@/lib/mailboxes/service";
import { listProviderStatus } from "@/lib/mailboxes/providers/registry";
import { getOrganization } from "@/lib/tenancy/organizations";
import { PROVIDER_LABEL } from "@/lib/ui/format";
import { Callout, Card, ConnectionPill, EmptyState, Freshness, PageHeader, PermissionDenied, Pill, Table, Td } from "@/components/ui/primitives";
import { OAuthConnectButton } from "@/components/mailboxes/oauth-connect-button";
import { oauthErrorMessage, PROVIDER_SHORT, sanitizeErrorMessage } from "@/components/mailboxes/mailbox-display";

export const metadata = { title: "Mailboxes" };

export default async function MailboxesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { principal, allowed } = await requirePage("mailbox:view");
  if (!allowed) {
    return (
      <>
        <PageHeader title="Mailboxes" />
        <PermissionDenied permission="mailbox:view" />
      </>
    );
  }

  const sp = await searchParams;
  const rawError = typeof sp.oauth_error === "string" ? sp.oauth_error : null;
  const oauthError = rawError ? rawError.replace(/[^a-z_]/g, "").slice(0, 40) || "unknown" : null;

  const [mailboxes, org] = await Promise.all([listMailboxes(principal.orgId), getOrganization(principal.orgId)]);
  const providers = listProviderStatus();
  const staleAfterHours = org.settings.syncStaleAfterHours ?? 2;
  const canConnect = can(principal.role, "mailbox:connect");
  const demo = principal.isDemoOrg;
  const active = mailboxes.filter((m) => m.state !== "disconnected");

  return (
    <>
      <PageHeader
        title="Mailboxes"
        lede="Connect Google Workspace or Microsoft 365 mailboxes through OAuth to observe bounces, replies, complaint reports and provider errors from message metadata. Provider-recorded sends are not proof of delivery, and inbox placement is not measured."
        meta={
          mailboxes.length ? (
            <>
              <span>
                {active.length} active · {mailboxes.length - active.length} disconnected
              </span>
              <span>Syncs older than {staleAfterHours} hours are marked stale</span>
            </>
          ) : undefined
        }
      />

      <div className="space-y-6">
        {oauthError ? (
          <Callout tone="bad" title="The mailbox was not connected">
            <p>{oauthErrorMessage(oauthError)}</p>
            <p className="mt-1 text-xs opacity-80">
              Error code: <code className="font-mono">{oauthError}</code>
            </p>
          </Callout>
        ) : null}

        {demo ? (
          <Callout tone="demo" title="Demo workspace">
            The mailboxes below are seeded sample data, not live connections. Connecting real mailboxes is disabled here — create or switch to a real workspace to connect your own.
          </Callout>
        ) : null}

        <Card
          title="Connect a mailbox"
          description="You sign in on the provider's own page and approve read-only access to message metadata. QuikReach never asks for your mailbox password."
        >
          <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {providers.map((p) => {
              const short = PROVIDER_SHORT[p.provider] ?? p.displayName;
              const reason = !p.configured
                ? `${short} OAuth is not configured in this deployment — an administrator must add client credentials (docs/oauth-setup.md). No live connection is possible until then.`
                : demo
                  ? "Live mailboxes cannot be connected to a demo workspace. Create or switch to a real workspace first."
                  : !canConnect
                    ? "Your role does not include mailbox:connect. Ask an Owner, Administrator, Deliverability Manager or Campaign Manager."
                    : undefined;
              return (
                <li key={p.provider} className="flex flex-col gap-3 rounded-md border border-line p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="text-sm font-medium text-ink">{p.displayName}</h3>
                      <p className="mt-0.5 text-xs text-muted">
                        {p.scopes.length} permission{p.scopes.length === 1 ? "" : "s"} requested — each is explained before you continue.
                      </p>
                    </div>
                    {p.configured ? <Pill tone="info">Available</Pill> : <Pill tone="unknown">Not configured</Pill>}
                  </div>
                  <OAuthConnectButton
                    provider={p.provider}
                    displayName={p.displayName}
                    label={`Connect ${short}`}
                    scopeExplanations={p.scopeExplanations}
                    disabled={Boolean(reason)}
                    disabledReason={reason}
                  />
                </li>
              );
            })}
          </ul>
        </Card>

        <Card title="Connections" padded={false}>
          {mailboxes.length ? (
            <Table caption="Mailbox connections with provider, domain, connection state, last successful sync, last error and granted permissions" head={["Mailbox", "Provider", "Domain", "State", "Last successful sync", "Last error", "Permissions", ""]}>
              {mailboxes.map((m) => {
                const err = sanitizeErrorMessage(m.lastErrorMessage);
                return (
                  <tr key={m.id} className="hover:bg-canvas">
                    <Td>
                      <Link href={`/mailboxes/${m.id}`} className="break-all font-medium text-ink underline-offset-2 hover:underline">
                        {m.emailAddress}
                      </Link>
                      {m.displayName ? <div className="text-xs text-muted">{m.displayName}</div> : null}
                    </Td>
                    <Td className="text-xs text-muted">{PROVIDER_LABEL[m.provider] ?? m.provider}</Td>
                    <Td>
                      {m.domainId && m.domainName ? (
                        <Link href={`/domains/${m.domainId}`} className="text-sm text-ink underline-offset-2 hover:underline">
                          {m.domainName}
                        </Link>
                      ) : (
                        <span className="text-xs text-muted">Not linked</span>
                      )}
                    </Td>
                    <Td>
                      <div className="flex flex-col items-start gap-1">
                        <ConnectionPill state={m.state} />
                        {m.isDemo && m.state !== "demo" ? <Pill tone="demo">Demo</Pill> : null}
                      </div>
                    </Td>
                    <Td>
                      {m.isDemo ? (
                        <Pill tone="demo">Sample data</Pill>
                      ) : m.state === "disconnected" ? (
                        <span className="text-xs text-muted">Not monitored</span>
                      ) : (
                        <Freshness at={m.lastSuccessfulSyncAt} staleAfterMs={staleAfterHours * 3_600_000} label="Synced" />
                      )}
                    </Td>
                    <Td className="max-w-[260px]">
                      {err || m.lastErrorCode ? (
                        <div className="text-xs">
                          {m.lastErrorCode ? <code className="font-mono text-red-700">{m.lastErrorCode}</code> : null}
                          {err ? <p className="mt-0.5 break-words text-muted">{err}</p> : null}
                        </div>
                      ) : (
                        <span className="text-xs text-muted">None</span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-xs">
                      {m.grantedScopes.length ? (
                        <span className="text-ink">{m.grantedScopes.length} granted</span>
                      ) : (
                        <span className="text-muted">{m.isDemo ? "n/a (demo)" : "Not yet known"}</span>
                      )}
                    </Td>
                    <Td>
                      <Link href={`/mailboxes/${m.id}`} className="whitespace-nowrap text-sm text-accent-700 underline-offset-2 hover:underline">
                        Details<span className="sr-only"> for {m.emailAddress}</span>
                      </Link>
                    </Td>
                  </tr>
                );
              })}
            </Table>
          ) : (
            <EmptyState icon={Inbox} title="No mailboxes connected">
              {demo
                ? "This demo workspace has no sample mailboxes."
                : "Connect a Google Workspace or Microsoft 365 mailbox above. QuikReach validates which signals the granted permissions can observe, then runs a first sync."}
            </EmptyState>
          )}
        </Card>
      </div>
    </>
  );
}
