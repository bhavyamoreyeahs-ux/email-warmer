import { ArrowRight, Pause, Play, Plug } from "lucide-react";
import { requirePage } from "@/lib/auth/page";
import { listIntegrations, ROADMAP_INTEGRATIONS } from "@/lib/integrations/service";
import { listCampaignActions, listCampaigns } from "@/lib/campaigns/service";
import { listProviderStatus } from "@/lib/mailboxes/providers/registry";
import { listMailboxes } from "@/lib/mailboxes/service";
import { listDomains } from "@/lib/domains/service";
import { can } from "@/lib/rbac";
import type { Principal } from "@/lib/api/principal";
import { Callout, Card, EmptyState, LinkButton, PageHeader, PermissionDenied, Pill, Table, Td } from "@/components/ui/primitives";
import { ActionButton } from "@/components/ui/interactive";
import { CreateIntegrationForm } from "@/components/integrations/create-integration-form";
import { TestIntegrationButton } from "@/components/integrations/test-integration-button";
import { LinkCampaignForm } from "@/components/integrations/link-campaign-form";
import { Notice, readNotice } from "@/components/settings/notice";
import { dateTime, relativeTime } from "@/lib/ui/format";

export const metadata = { title: "Integrations" };

type Tone = React.ComponentProps<typeof Pill>["tone"];
type IntegrationRow = Awaited<ReturnType<typeof listIntegrations>>[number];
type CampaignRow = Awaited<ReturnType<typeof listCampaigns>>[number];
type ActionRow = Awaited<ReturnType<typeof listCampaignActions>>[number];

const INTEGRATION_STATUS: Record<IntegrationRow["status"], { tone: Tone; label: string }> = {
  active: { tone: "good", label: "Active" },
  pending_setup: { tone: "info", label: "Pending test" },
  error: { tone: "bad", label: "Error (last test failed)" },
  disabled: { tone: "unknown", label: "Disabled" },
  revoked: { tone: "unknown", label: "Revoked" },
};

const KIND_LABEL: Record<string, string> = { campaign_webhook: "Campaign control", notification_webhook: "Notifications", quikcrm: "QuikCRM", quikpilot: "QuikPilot" };

const CAMPAIGN_STATUS: Record<CampaignRow["status"], { tone: Tone; label: string }> = {
  active: { tone: "info", label: "Active (confirmed)" },
  paused: { tone: "warn", label: "Paused (confirmed)" },
  unknown: { tone: "unknown", label: "Unknown (not confirmed)" },
};

const ACTION_STATUS: Record<ActionRow["status"], { tone: Tone; label: string }> = {
  queued: { tone: "info", label: "Queued" },
  sent: { tone: "stale", label: "Sent, awaiting confirmation" },
  confirmed: { tone: "good", label: "Confirmed" },
  unconfirmed: { tone: "warn", label: "Response did not confirm" },
  failed: { tone: "bad", label: "Failed" },
};

const NOTICES: Record<string, string> = {
  revoked: "Integration revoked. Its signing secret was deleted and QuikReach no longer sends to it.",
};

const DEMO_REASON = "This is a demo workspace with sample data only. Creating integrations, linking campaigns and requesting pause/resume are disabled — switch to a real workspace.";

function endpointHost(config: Record<string, unknown>): string {
  const raw = config.endpointUrl;
  if (typeof raw !== "string") return "—";
  try {
    return new URL(raw).host;
  } catch {
    return "—";
  }
}

function CodeBlock({ children }: { children: string }) {
  return <pre className="mt-1 overflow-x-auto whitespace-pre rounded-md bg-canvas p-3 font-mono text-xs text-ink">{children}</pre>;
}

function CampaignControls({ c, principal }: { c: CampaignRow; principal: Principal }) {
  const role = principal.role;
  const canPause = can(role, "campaign:pause");
  const canResume = can(role, "campaign:resume") || can(role, "campaign:review");
  if (!canPause && !canResume) return <span className="text-xs text-muted">View only</span>;

  const blocked = principal.isDemoOrg
    ? "Disabled in demo workspaces."
    : c.integrationStatus !== "active"
      ? `Unavailable: the integration “${c.integrationName}” is not active (it must pass a test first), so QuikReach cannot send a request.`
      : null;
  const reviewBlocked = c.requiresReview && !can(role, "campaign:review");
  const showPause = canPause && c.status !== "paused";
  const showResume = canResume && c.status !== "active";

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex flex-wrap gap-2">
        {showPause ? (
          <ActionButton
            label="Pause"
            icon={<Pause aria-hidden className="h-4 w-4" />}
            path={`/api/v1/campaigns/${c.id}/actions`}
            body={{ action: "pause" }}
            disabled={Boolean(blocked)}
            disabledReason={blocked ?? undefined}
            confirm={{
              title: `Request a pause of “${c.name}”?`,
              description: (
                <>
                  QuikReach will send a signed pause request to <strong>{c.integrationName}</strong>. QuikReach does not pause campaigns itself: the campaign is shown as paused only after the sending system confirms it.
                </>
              ),
              confirmLabel: "Request pause",
              requireReason: true,
            }}
            successMessage="Pause requested — awaiting confirmation from the sending system."
          />
        ) : null}
        {showResume ? (
          <ActionButton
            label="Resume"
            icon={<Play aria-hidden className="h-4 w-4" />}
            path={`/api/v1/campaigns/${c.id}/actions`}
            body={{ action: "resume" }}
            disabled={Boolean(blocked) || reviewBlocked}
            disabledReason={blocked ?? (reviewBlocked ? "Needs campaign:review." : undefined)}
            confirm={{
              title: `Request a resume of “${c.name}”?`,
              description: (
                <>
                  QuikReach will send a signed resume request to <strong>{c.integrationName}</strong>. The campaign is shown as active only after the sending system confirms it.
                  {c.requiresReview ? " This campaign was paused after a critical alert — confirm you have reviewed the cause." : ""}
                </>
              ),
              confirmLabel: "Request resume",
              requireReason: true,
            }}
            successMessage="Resume requested — awaiting confirmation from the sending system."
          />
        ) : null}
      </div>
      {blocked ? <p className="max-w-xs text-xs text-muted">{blocked}</p> : null}
      {!blocked && reviewBlocked && showResume ? (
        <p className="max-w-xs text-xs text-muted">Paused after a critical alert: resuming needs a Deliverability Manager, Administrator or Owner (campaign:review). Separation of duties is deliberate.</p>
      ) : null}
    </div>
  );
}

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { principal, allowed } = await requirePage("integration:view");
  const header = (
    <PageHeader
      title="Integrations"
      lede="Mailbox providers QuikReach reads from, signed webhooks for campaign control and notifications, and the campaigns linked to them."
    />
  );
  if (!allowed) {
    return (
      <>
        {header}
        <PermissionDenied permission="integration:view" />
      </>
    );
  }

  const notice = readNotice((await searchParams).notice, NOTICES);
  const orgId = principal.orgId;
  const role = principal.role;
  const canViewCampaigns = can(role, "campaign:view");
  const canManageIntegrations = can(role, "integration:manage");
  const canManageCampaigns = can(role, "campaign:manage");

  const [integrationRows, campaigns, actions, mailboxes, domains] = await Promise.all([
    listIntegrations(orgId),
    canViewCampaigns ? listCampaigns(orgId) : Promise.resolve<CampaignRow[]>([]),
    canViewCampaigns ? listCampaignActions(orgId, 25) : Promise.resolve<ActionRow[]>([]),
    canViewCampaigns ? listMailboxes(orgId) : Promise.resolve<Awaited<ReturnType<typeof listMailboxes>>>([]),
    canViewCampaigns ? listDomains(orgId) : Promise.resolve<Awaited<ReturnType<typeof listDomains>>>([]),
  ]);
  const providers = listProviderStatus();

  const webhooks = integrationRows.filter((i) => i.kind === "campaign_webhook" || i.kind === "notification_webhook");
  const activeCampaignIntegrations = webhooks.filter((i) => i.kind === "campaign_webhook" && i.status === "active");
  const linkableIntegrations = webhooks.filter((i) => i.kind === "campaign_webhook" && i.status !== "revoked" && i.status !== "disabled");
  const mailboxLabel = new Map(mailboxes.map((m) => [m.id, m.emailAddress]));
  const domainLabel = new Map(domains.map((d) => [d.id, d.name]));

  return (
    <>
      {header}
      <Notice message={notice} />

      {principal.isDemoOrg ? (
        <div className="mb-6">
          <Callout tone="demo" title="Demo workspace">
            {DEMO_REASON}
          </Callout>
        </div>
      ) : null}

      {activeCampaignIntegrations.length === 0 ? (
        <div className="mb-6">
          <Callout tone="warn" title="QuikReach can alert but cannot pause campaigns.">
            There is no active campaign-control integration. Alerts will still be raised and notified, but no pause or resume can be requested until a campaign webhook is created and passes a test.
          </Callout>
        </div>
      ) : null}

      <Card
        title="Mailbox providers"
        description="OAuth connections QuikReach uses to read sending activity. QuikReach never asks for mailbox passwords."
        actions={
          <LinkButton href="/mailboxes" variant="ghost">
            Mailboxes <ArrowRight aria-hidden className="h-4 w-4" />
          </LinkButton>
        }
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {providers.map((p) => (
            <section key={p.provider} aria-labelledby={`provider-${p.provider}`} className="min-w-0 rounded-md border border-line p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 id={`provider-${p.provider}`} className="text-sm font-medium text-ink">
                  {p.displayName}
                </h3>
                {p.configured ? <Pill tone="good">Configured</Pill> : <Pill tone="unknown">Not configured</Pill>}
              </div>
              {!p.configured ? (
                <p className="mt-1 text-xs text-muted">
                  Not configured — needs client credentials (<code className="rounded bg-canvas px-1">docs/oauth-setup.md</code>). Mailboxes from this provider cannot be connected until an administrator of this deployment adds them.
                </p>
              ) : null}
              <h4 className="mt-3 text-xs font-medium uppercase tracking-[0.08em] text-muted">Scopes requested and why</h4>
              <ul className="mt-1 space-y-2">
                {p.scopeExplanations.map((s) => (
                  <li key={s.scope} className="text-xs">
                    <code className="break-all rounded bg-canvas px-1 text-ink">{s.scope}</code>
                    <p className="mt-0.5 text-muted">{s.why}</p>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </Card>

      <Card title="Campaign control" description="How pause and resume work" className="mt-6">
        <div className="space-y-2 text-sm text-muted">
          <p>
            <strong className="text-ink">QuikReach does not send or pause campaigns itself.</strong> It can request a pause or resume through a signed webhook that you authorise and run in your sending system.
          </p>
          <p>
            A request moves through <em>queued</em> → <em>sent, awaiting confirmation</em> → <em>confirmed</em>. A campaign is shown as paused only when the sending system replies confirming the new state for that campaign; any other reply is recorded as “response did not confirm” or “failed”, never as paused.
          </p>
          <p>
            Status: {activeCampaignIntegrations.length > 0 ? <Pill tone="good">{`${activeCampaignIntegrations.length} active campaign ${activeCampaignIntegrations.length === 1 ? "integration" : "integrations"}`}</Pill> : <Pill tone="warn">No active campaign integration — alert only</Pill>}
          </p>
        </div>
      </Card>

      <Card title="Webhook integrations" description="Signed outbound webhooks for campaign control and alert notifications" className="mt-6" padded={false}>
        {webhooks.length ? (
          <Table caption="Webhook integrations" head={["Name", "Kind", "Status", "Endpoint host", "Last test", "Actions"]}>
            {webhooks.map((i) => {
              const status = INTEGRATION_STATUS[i.status];
              return (
                <tr key={i.id}>
                  <Td>
                    <span className="font-medium text-ink">{i.name}</span>
                    <div className="text-xs text-muted">Created {dateTime(i.createdAt)}</div>
                  </Td>
                  <Td>{KIND_LABEL[i.kind] ?? i.kind}</Td>
                  <Td>
                    <Pill tone={status.tone}>{status.label}</Pill>
                    {i.revokedAt ? <div className="mt-1 text-xs text-muted">Revoked {dateTime(i.revokedAt)}</div> : null}
                  </Td>
                  <Td className="font-mono text-xs">{endpointHost(i.config)}</Td>
                  <Td>
                    {i.lastTestedAt ? (
                      <>
                        <div className="text-sm text-ink">{i.lastTestOutcome ?? "—"}</div>
                        <div className="text-xs text-muted" title={dateTime(i.lastTestedAt)}>
                          {relativeTime(i.lastTestedAt)}
                        </div>
                      </>
                    ) : (
                      <Pill tone="unknown">Never tested</Pill>
                    )}
                  </Td>
                  <Td>
                    {canManageIntegrations && i.status !== "revoked" ? (
                      <div className="flex flex-wrap items-start gap-2">
                        <TestIntegrationButton integrationId={i.id} name={i.name} />
                        <ActionButton
                          label="Revoke"
                          variant="danger"
                          path={`/api/v1/integrations/${i.id}/revoke`}
                          body={{ status: "revoked" }}
                          confirm={{
                            title: `Revoke “${i.name}”?`,
                            description: (
                              <>
                                The signing secret is deleted and QuikReach stops sending to this endpoint. {i.kind === "campaign_webhook" ? "Linked campaigns can no longer be paused or resumed from QuikReach. " : ""}This cannot be undone — create a new integration to reconnect.
                              </>
                            ),
                            confirmLabel: "Revoke integration",
                            requireReason: true,
                          }}
                          successMessage="Integration revoked."
                          redirectTo="/integrations?notice=revoked"
                        />
                      </div>
                    ) : (
                      <span className="text-xs text-muted">{i.status === "revoked" ? "Revoked" : "View only"}</span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <EmptyState icon={Plug} title="No webhook integrations">
            Create a campaign-control webhook to let QuikReach request pauses, or a notification webhook to receive alerts.
          </EmptyState>
        )}

        <div className="grid grid-cols-1 gap-6 border-t border-line p-4 lg:grid-cols-2">
          <section aria-labelledby="create-integration-heading" className="min-w-0">
            <h3 id="create-integration-heading" className="text-sm font-medium text-ink">
              Create a webhook integration
            </h3>
            <div className="mt-3">
              {canManageIntegrations ? (
                <CreateIntegrationForm disabledReason={principal.isDemoOrg ? DEMO_REASON : undefined} />
              ) : (
                <p className="text-sm text-muted">Your role cannot manage integrations (needs integration:manage).</p>
              )}
            </div>
          </section>
          <section aria-labelledby="receiver-contract-heading" className="min-w-0 text-sm text-muted">
            <h3 id="receiver-contract-heading" className="text-sm font-medium text-ink">
              What your endpoint must do
            </h3>
            <ol className="mt-2 list-decimal space-y-2 pl-5">
              <li>
                Verify the <code className="rounded bg-canvas px-1">X-QuikReach-Signature</code> header:
                <CodeBlock>{'t=<unix>,v1=<hex hmac-sha256 of "t.body">'}</CodeBlock>
                <span className="text-xs">HMAC-SHA256 with the signing secret over the timestamp, a dot and the raw body. Reject timestamps older than 5 minutes; de-duplicate on <code className="rounded bg-canvas px-1">Idempotency-Key</code>.</span>
              </li>
              <li>
                Reply to a test ping (<code className="rounded bg-canvas px-1">{'"type": "ping"'}</code>) with:
                <CodeBlock>{'{"ok": true}'}</CodeBlock>
              </li>
              <li>
                For <code className="rounded bg-canvas px-1">campaign.pause</code> / <code className="rounded bg-canvas px-1">campaign.resume</code>, apply the change and confirm the resulting state for the same campaign:
                <CodeBlock>{'{"ok": true, "campaign": {"externalId": "...", "status": "paused"|"active"}}'}</CodeBlock>
                <span className="text-xs">Any other reply is recorded as “response did not confirm”. Server errors and timeouts are retried a bounded number of times.</span>
              </li>
            </ol>
          </section>
        </div>
      </Card>

      {canViewCampaigns ? (
        <>
          <Card title="Linked campaigns" description="Campaigns in your sending system that QuikReach may request to pause or resume" className="mt-6" padded={false}>
            {campaigns.length ? (
              <Table caption="Linked campaigns" head={["Campaign", "External ID", "Integration", "Linked to", "Confirmed status", "Actions"]}>
                {campaigns.map((c) => {
                  const st = CAMPAIGN_STATUS[c.status];
                  const integ = INTEGRATION_STATUS[c.integrationStatus];
                  const mailbox = c.mailboxConnectionId ? (mailboxLabel.get(c.mailboxConnectionId) ?? "Unknown mailbox") : null;
                  const domain = c.domainId ? (domainLabel.get(c.domainId) ?? "Unknown domain") : null;
                  return (
                    <tr key={c.id}>
                      <Td>
                        <span className="font-medium text-ink">{c.name}</span>
                        {c.requiresReview ? (
                          <div className="mt-1">
                            <Pill tone="bad">Requires review</Pill>
                          </div>
                        ) : null}
                      </Td>
                      <Td className="break-all font-mono text-xs">{c.externalId}</Td>
                      <Td>
                        <div className="text-ink">{c.integrationName}</div>
                        {c.integrationStatus !== "active" ? (
                          <div className="mt-1">
                            <Pill tone={integ.tone}>{integ.label}</Pill>
                          </div>
                        ) : null}
                      </Td>
                      <Td>
                        {mailbox || domain ? (
                          <ul className="space-y-0.5 text-xs">
                            {mailbox ? <li>Mailbox: <span className="text-ink">{mailbox}</span></li> : null}
                            {domain ? <li>Domain: <span className="text-ink">{domain}</span></li> : null}
                          </ul>
                        ) : (
                          <span className="text-xs text-muted">Not linked</span>
                        )}
                      </Td>
                      <Td>
                        <Pill tone={st.tone}>{st.label}</Pill>
                        <div className="mt-1 text-xs text-muted">{c.statusConfirmedAt ? `Confirmed ${dateTime(c.statusConfirmedAt)}` : "Never confirmed by the sending system"}</div>
                        {c.pausedByQuikreach && c.status === "paused" ? <div className="text-xs text-muted">Paused at QuikReach&apos;s request</div> : null}
                      </Td>
                      <Td>
                        <CampaignControls c={c} principal={principal} />
                      </Td>
                    </tr>
                  );
                })}
              </Table>
            ) : (
              <EmptyState title="No linked campaigns">Link a campaign by its ID in your sending system so QuikReach can request a pause when an alert fires.</EmptyState>
            )}
            <section aria-labelledby="link-campaign-heading" className="border-t border-line p-4">
              <h3 id="link-campaign-heading" className="text-sm font-medium text-ink">
                Link campaign
              </h3>
              <div className="mt-3">
                {canManageCampaigns ? (
                  <LinkCampaignForm
                    integrations={linkableIntegrations.map((i) => ({ value: i.id, label: `${i.name} (${INTEGRATION_STATUS[i.status].label})` }))}
                    mailboxes={mailboxes.filter((m) => m.state !== "disconnected").map((m) => ({ value: m.id, label: m.isDemo ? `${m.emailAddress} (demo)` : m.emailAddress }))}
                    domains={domains.map((d) => ({ value: d.id, label: d.name }))}
                    disabledReason={principal.isDemoOrg ? DEMO_REASON : undefined}
                  />
                ) : (
                  <p className="text-sm text-muted">Your role cannot link campaigns (needs campaign:manage).</p>
                )}
              </div>
            </section>
          </Card>

          <Card title="Recent campaign actions" description="Pause and resume requests and what the sending system confirmed" className="mt-6" padded={false}>
            {actions.length ? (
              <Table caption="Recent campaign actions" head={["Requested", "Campaign", "Action", "Requested by", "Status", "Reason", "Detail"]}>
                {actions.map((a) => {
                  const st = ACTION_STATUS[a.status];
                  return (
                    <tr key={a.id}>
                      <Td className="whitespace-nowrap">
                        <span title={dateTime(a.createdAt)}>{relativeTime(a.createdAt)}</span>
                      </Td>
                      <Td>{a.campaignName}</Td>
                      <Td className="capitalize">{a.action}</Td>
                      <Td>{a.requestedByType === "automation" ? <Pill tone="info">Automation (alert rule)</Pill> : <Pill tone="unknown">User</Pill>}</Td>
                      <Td>
                        <Pill tone={st.tone}>{st.label}</Pill>
                        {a.completedAt ? <div className="mt-1 text-xs text-muted">{dateTime(a.completedAt)}</div> : null}
                      </Td>
                      <Td className="max-w-xs break-words text-xs">{a.reason}</Td>
                      <Td className="max-w-xs break-words text-xs text-muted">{a.error ?? "—"}</Td>
                    </tr>
                  );
                })}
              </Table>
            ) : (
              <EmptyState title="No campaign actions yet">Pause and resume requests will appear here with their confirmed outcome.</EmptyState>
            )}
          </Card>
        </>
      ) : (
        <div className="mt-6">
          <Callout tone="unknown">Linked campaigns are visible to roles with campaign:view.</Callout>
        </div>
      )}

      <section aria-labelledby="planned-heading" className="mt-8">
        <h2 id="planned-heading" className="text-lg font-medium tracking-tighter text-ink">
          Planned integrations
        </h2>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          {ROADMAP_INTEGRATIONS.map((r) => (
            <section key={r.kind} aria-labelledby={`planned-${r.kind}`} aria-disabled="true" className="rounded-lg border border-dashed border-line bg-panel/60 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 id={`planned-${r.kind}`} className="text-sm font-medium text-muted">
                  {r.name}
                </h3>
                <Pill tone="unknown">Not available in this release</Pill>
              </div>
              <p className="mt-2 text-sm text-muted">{r.description}</p>
            </section>
          ))}
        </div>
      </section>
    </>
  );
}
