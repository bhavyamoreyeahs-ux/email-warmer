import Link from "next/link";
import { ArrowLeft, ArrowRight, Pause, Play } from "lucide-react";
import { requirePage } from "@/lib/auth/page";
import { can } from "@/lib/rbac";
import { getMailboxDetail } from "@/lib/mailboxes/service";
import { listProviderStatus } from "@/lib/mailboxes/providers/registry";
import { evaluateMailboxHealth } from "@/lib/health/evaluate";
import { getOrganization } from "@/lib/tenancy/organizations";
import { assertUuid, orNotFound } from "@/lib/ui/server";
import { dateTime, PROVIDER_LABEL, relativeTime } from "@/lib/ui/format";
import type { ConnectionState } from "@/lib/db/schema";
import { Callout, Card, ConnectionPill, EmptyState, Freshness, HealthPill, KeyValue, LinkButton, PageHeader, PermissionDenied, Pill, Stat, Table, Td } from "@/components/ui/primitives";
import { ActionButton } from "@/components/ui/interactive";
import { OAuthConnectButton } from "@/components/mailboxes/oauth-connect-button";
import { DisconnectButton } from "@/components/mailboxes/disconnect-button";
import { SyncNowButton } from "@/components/mailboxes/sync-now-button";
import {
  CAPABILITY_LABEL,
  CapabilityPill,
  capabilityLabel,
  CategoryPill,
  CONFIDENCE_LABEL,
  EVENT_SOURCE_LABEL,
  PROVIDER_SHORT,
  sanitizeErrorMessage,
  SYNC_TRIGGER_LABEL,
  SyncStatusPill,
} from "@/components/mailboxes/mailbox-display";

export const metadata = { title: "Mailbox details" };

const CAPABILITY_ORDER = Object.keys(CAPABILITY_LABEL);
const SYNCABLE: ConnectionState[] = ["connected", "degraded", "pending"];
const PAUSABLE: ConnectionState[] = ["connected", "degraded", "pending", "reauth_required"];

function syncBlockedReason(state: ConnectionState): string | undefined {
  switch (state) {
    case "reauth_required":
      return "This mailbox must be reconnected before it can sync.";
    case "paused":
      return "Monitoring is paused — resume it to sync.";
    case "disconnected":
      return "Disconnected mailboxes cannot sync. Connect the mailbox again from Mailboxes to resume monitoring.";
    default:
      return undefined;
  }
}

function nextSyncText(state: ConnectionState, nextSyncAt: Date | null, isDemo: boolean): string {
  if (isDemo) return "Never — demo mailboxes do not sync.";
  if (nextSyncAt) return `${dateTime(nextSyncAt)} (${relativeTime(nextSyncAt)})`;
  if (state === "paused") return "Not scheduled — monitoring is paused.";
  if (state === "disconnected") return "Not scheduled — disconnected.";
  if (state === "reauth_required") return "Not scheduled — reconnect required.";
  return "Not scheduled yet.";
}

export default async function MailboxDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { principal, allowed } = await requirePage("mailbox:view");
  if (!allowed) {
    return (
      <>
        <PageHeader title="Mailbox" />
        <PermissionDenied permission="mailbox:view" />
      </>
    );
  }
  const [{ id: rawId }, sp] = await Promise.all([params, searchParams]);
  const id = assertUuid(rawId);
  const now = new Date();
  const [detail, org] = await Promise.all([orNotFound(getMailboxDetail(principal.orgId, id)), getOrganization(principal.orgId)]);
  const { mailbox: m, capabilities, syncs, events, counts7d } = detail;
  const staleAfterHours = org.settings.syncStaleAfterHours ?? 2;

  const capMap: Record<string, string> = {};
  for (const c of capabilities) capMap[c.capability] = c.status;
  const health = evaluateMailboxHealth({
    connectionId: m.id,
    state: m.state,
    stateReason: m.stateReason,
    lastSuccessfulSyncAt: m.lastSuccessfulSyncAt,
    counts: counts7d,
    capabilities: capMap,
    now,
    staleAfterHours,
  });
  const fresh = health.inputs.find((i) => i.key === "mailbox.freshness")?.state === "healthy";
  const sortedCaps = [...capabilities].sort((a, b) => {
    const ia = CAPABILITY_ORDER.indexOf(a.capability);
    const ib = CAPABILITY_ORDER.indexOf(b.capability);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const justConnected = sp.connected === "1";
  const justReconnected = sp.reconnected === "1";

  /* ─── Actions & why they may be unavailable ─── */
  const isDemoMailbox = m.isDemo || m.state === "demo";
  const oauthProvider = m.provider === "google" || m.provider === "microsoft" ? m.provider : null;
  const providerStatus = oauthProvider ? listProviderStatus().find((p) => p.provider === oauthProvider) : undefined;

  const canSync = can(principal.role, "mailbox:sync");
  const canPause = can(principal.role, "mailbox:pause");
  const canConnect = can(principal.role, "mailbox:connect");
  const canDisconnect = can(principal.role, "mailbox:disconnect");

  const showSync = !isDemoMailbox && m.state !== "disconnected";
  const syncReason = !canSync ? "Your role does not include mailbox:sync." : !SYNCABLE.includes(m.state) ? syncBlockedReason(m.state) : undefined;
  const showPause = !isDemoMailbox && PAUSABLE.includes(m.state);
  const showResume = !isDemoMailbox && m.state === "paused";
  const pauseReason = !canPause ? "Your role does not include mailbox:pause." : undefined;
  const showReconnect = !isDemoMailbox && Boolean(oauthProvider && providerStatus) && (m.state === "reauth_required" || m.state === "degraded");
  const reconnectReason = principal.isDemoOrg
    ? "Live mailboxes cannot be connected to a demo workspace."
    : !canConnect
      ? "Your role does not include mailbox:connect."
      : providerStatus && !providerStatus.configured
        ? `${PROVIDER_SHORT[providerStatus.provider] ?? providerStatus.displayName} OAuth is not configured in this deployment — an administrator must add client credentials (docs/oauth-setup.md). No live connection is possible until then.`
        : undefined;
  const showDisconnect = !isDemoMailbox && m.state !== "disconnected";
  const disconnectReason = !canDisconnect ? "Your role does not include mailbox:disconnect. Ask an Owner, Administrator or Deliverability Manager." : undefined;
  const actionNotes = [
    showSync && syncReason ? `Sync: ${syncReason}` : null,
    (showPause || showResume) && pauseReason ? `Pause/resume: ${pauseReason}` : null,
    showReconnect && reconnectReason ? `Reconnect: ${reconnectReason}` : null,
  ].filter((x): x is string => Boolean(x));

  /* ─── 7-day counts — never show "0" where the data is unknown ─── */
  const neverSynced = !isDemoMailbox && !m.lastSuccessfulSyncAt;
  const count = (k: string) => counts7d[k] ?? 0;
  const metric = (capability: string, value: number): { value: string; tone: "neutral" | "unknown"; blocked?: string } => {
    if (neverSynced) return { value: "—", tone: "unknown", blocked: "No successful sync yet." };
    if (capMap[capability] === "unavailable") return { value: "—", tone: "unknown", blocked: "Not measurable with the granted permissions." };
    return { value: value.toLocaleString("en-US"), tone: "neutral" };
  };
  const bounces = count("hard_bounce") + count("soft_bounce") + count("bounce_unclassified");
  const providerErrors = count("provider_error") + count("sending_limit");
  const sentM = metric("sent_volume", count("sent"));
  const bounceM = metric("bounce_detection", bounces);
  const replyM = metric("reply_detection", count("reply"));
  const complaintM = metric("complaint_feedback", count("complaint"));
  const errorM = metric("provider_api_errors", providerErrors);
  const lastError = sanitizeErrorMessage(m.lastErrorMessage);

  return (
    <>
      <div className="mb-3">
        <Link href="/mailboxes" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
          <ArrowLeft aria-hidden className="h-4 w-4" />
          All mailboxes
        </Link>
      </div>
      <PageHeader
        title={m.emailAddress}
        lede={
          isDemoMailbox
            ? "Demo mailbox with seeded sample data — not a live connection."
            : "Signals observed from this mailbox's message metadata (headers, labels). Message bodies are never read. Inbox placement is not measured."
        }
        meta={
          <>
            <span>{PROVIDER_LABEL[m.provider] ?? m.provider}</span>
            <ConnectionPill state={m.state} />
            {m.isDemo ? <Pill tone="demo">Demo</Pill> : null}
            {m.domainId && m.domainName ? (
              <Link href={`/domains/${m.domainId}`} className="underline-offset-2 hover:text-ink hover:underline">
                Domain: {m.domainName}
              </Link>
            ) : (
              <span>Domain: not linked</span>
            )}
            {isDemoMailbox ? null : <Freshness at={m.lastSuccessfulSyncAt} staleAfterMs={staleAfterHours * 3_600_000} label="Synced" />}
          </>
        }
        actions={
          showSync || showPause || showResume || showReconnect ? (
            <>
              {showSync ? <SyncNowButton connectionId={m.id} disabled={Boolean(syncReason)} disabledReason={syncReason} /> : null}
              {showReconnect && oauthProvider && providerStatus ? (
                <OAuthConnectButton
                  provider={oauthProvider}
                  displayName={providerStatus.displayName}
                  label="Reconnect"
                  variant={m.state === "reauth_required" ? "primary" : "secondary"}
                  scopeExplanations={providerStatus.scopeExplanations}
                  reconnectConnectionId={m.id}
                  loginHint={m.emailAddress}
                  disabled={Boolean(reconnectReason)}
                />
              ) : null}
              {showPause ? (
                <ActionButton
                  label="Pause monitoring"
                  path={`/api/v1/mailboxes/${m.id}/pause`}
                  body={{ paused: true }}
                  icon={<Pause aria-hidden className="h-4 w-4" />}
                  disabled={Boolean(pauseReason)}
                  disabledReason={pauseReason}
                  confirm={{
                    title: `Pause monitoring for ${m.emailAddress}?`,
                    description: "Scheduled syncs stop and this mailbox's health data will go stale. The connection and its stored tokens are kept, so you can resume at any time.",
                    confirmLabel: "Pause monitoring",
                    requireReason: true,
                  }}
                  successMessage="Monitoring paused."
                />
              ) : null}
              {showResume ? (
                <ActionButton
                  label="Resume monitoring"
                  path={`/api/v1/mailboxes/${m.id}/pause`}
                  body={{ paused: false }}
                  variant="primary"
                  icon={<Play aria-hidden className="h-4 w-4" />}
                  disabled={Boolean(pauseReason)}
                  disabledReason={pauseReason}
                  confirm={{
                    title: `Resume monitoring for ${m.emailAddress}?`,
                    description: "Scheduled syncs restart and a sync is queued right away.",
                    confirmLabel: "Resume monitoring",
                    requireReason: true,
                  }}
                  successMessage="Monitoring resumed. A sync is queued."
                />
              ) : null}
            </>
          ) : undefined
        }
      />
      {actionNotes.length ? (
        <ul className="-mt-3 mb-6 space-y-0.5 text-xs text-muted">
          {actionNotes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}

      <div className="space-y-6">
        {justConnected || justReconnected ? (
          <Callout tone="info" title={justReconnected ? "Reconnected." : "Connected."}>
            Validating permissions and running the first sync — this can take a few minutes.
          </Callout>
        ) : null}

        {isDemoMailbox ? (
          <Callout tone="demo" title="Demo mailbox">
            Everything on this page is seeded sample data. Demo mailboxes never sync and cannot be paused, reconnected or disconnected — they are part of the sample workspace. Connect a real mailbox in a real workspace to see live signals.
          </Callout>
        ) : null}

        {m.state === "reauth_required" ? (
          <Callout tone="bad" title="Reconnect required">
            {m.stateReason ?? "QuikReach can no longer access this mailbox."} Monitoring is stopped until you reconnect; data shown here is from before the problem started.
          </Callout>
        ) : m.state === "degraded" ? (
          <Callout tone="warn" title="Connection degraded">
            {m.stateReason ?? "Recent provider errors."} Syncs continue to retry; data may be incomplete until they succeed.
          </Callout>
        ) : m.state === "paused" ? (
          <Callout tone="unknown" title="Monitoring paused">
            {m.stateReason ?? "An administrator paused monitoring."} Data on this page is not being updated.
          </Callout>
        ) : m.state === "disconnected" ? (
          <Callout tone="unknown" title="Disconnected">
            {m.stateReason ?? "This mailbox was disconnected."} Tokens were deleted and nothing on this page is updated.
          </Callout>
        ) : null}

        {/* ─── Health ─── */}
        <Card
          title="Mailbox health"
          description={`QuikReach's own heuristic (rules ${health.ruleVersion}) — not a provider reputation score, and not a prediction of inbox placement.`}
          actions={<HealthPill state={health.state} />}
        >
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {health.inputs.map((i) => (
              <li key={i.key} className="text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink">{i.label}</span>
                  {i.informational ? <Pill tone="info">Info</Pill> : <HealthPill state={i.state} />}
                </div>
                <p className="mt-0.5 break-words text-xs text-muted">{i.detail}</p>
              </li>
            ))}
          </ul>
          {health.missing.length ? (
            <div className="mt-4 border-t border-line pt-3">
              <h3 className="text-xs font-medium uppercase tracking-[0.08em] text-muted">Missing or limited data</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
                {health.missing.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>

        {/* ─── 7-day counts ─── */}
        <section aria-labelledby="counts-heading">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 id="counts-heading" className="text-sm font-medium text-ink">
                Last 7 days
              </h2>
              <p className="text-xs text-muted">
                Observed in this mailbox only.{!fresh && !isDemoMailbox ? " Data is stale, so recent events may be missing." : ""}
                {isDemoMailbox ? " Sample data." : ""}
              </p>
            </div>
            <LinkButton href={`/events?connectionId=${m.id}`} variant="ghost">
              All events <ArrowRight aria-hidden className="h-4 w-4" />
            </LinkButton>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Stat label="Sent" value={sentM.value} tone={sentM.tone} hint={sentM.blocked ?? "Provider-recorded — not proof of delivery."} />
            <Stat
              label="Bounces"
              value={bounceM.value}
              tone={bounceM.tone}
              hint={bounceM.blocked ?? `${count("hard_bounce")} hard · ${count("soft_bounce")} soft · ${count("bounce_unclassified")} unclassified`}
            />
            <Stat label="Replies" value={replyM.value} tone={replyM.tone} hint={replyM.blocked ?? `Plus ${count("auto_reply")} auto-replies, counted separately.`} />
            <Stat
              label="Complaints"
              value={complaintM.value}
              tone={complaintM.tone}
              hint={complaintM.blocked ?? "Partial visibility — only feedback reports delivered to this mailbox. Zero is not proof of no complaints."}
            />
            <Stat
              label="Provider errors"
              value={errorM.value}
              tone={errorM.tone}
              hint={errorM.blocked ?? `Includes ${count("sending_limit")} sending-limit notice${count("sending_limit") === 1 ? "" : "s"}.`}
            />
          </div>
        </section>

        {/* ─── Capabilities ─── */}
        <Card title="Capabilities" description="What the granted permissions let QuikReach observe for this mailbox. Signals that are unavailable are never estimated." padded={false}>
          {sortedCaps.length ? (
            <Table caption="Observable signals for this mailbox with status and explanation" head={["Signal", "Status", "Detail", "Checked"]}>
              {sortedCaps.map((c) => (
                <tr key={c.id}>
                  <Td className="font-medium text-ink">{capabilityLabel(c.capability)}</Td>
                  <Td>
                    <CapabilityPill status={c.status} />
                  </Td>
                  <Td className="break-words text-xs text-muted">{c.detail}</Td>
                  <Td className="whitespace-nowrap text-xs text-muted">{dateTime(c.checkedAt)}</Td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title="Capabilities not validated yet">
              {m.state === "pending"
                ? "QuikReach checks what the granted permissions can observe right after connecting. This usually takes a minute — refresh to see the results."
                : "No capability results are recorded for this mailbox, so every signal is treated as unknown."}
            </EmptyState>
          )}
          <div className="border-t border-line p-4">
            <Callout tone="unknown" title="Inbox placement is not measured">
              Mailbox APIs cannot see whether your messages landed in recipients&apos; inboxes or spam folders. QuikReach makes no inbox-placement or reputation claims.
            </Callout>
          </div>
        </Card>

        {/* ─── Event timeline ─── */}
        <Card
          title="Recent events"
          description="The latest non-sent signals classified from message metadata (newest first, up to 50)."
          actions={
            <LinkButton href={`/events?connectionId=${m.id}`} variant="ghost">
              Search events <ArrowRight aria-hidden className="h-4 w-4" />
            </LinkButton>
          }
          padded={false}
        >
          {events.length ? (
            <ol className="divide-y divide-line">
              {events.map((e) => (
                <li key={e.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <CategoryPill category={e.category} />
                    <span className="text-xs text-muted">{CONFIDENCE_LABEL[e.confidence]}</span>
                    {e.isDemo ? <Pill tone="demo">Demo</Pill> : null}
                    <time dateTime={e.occurredAt.toISOString()} className="ml-auto whitespace-nowrap text-xs text-muted" title={dateTime(e.occurredAt)}>
                      {dateTime(e.occurredAt)} · {relativeTime(e.occurredAt)}
                    </time>
                  </div>
                  <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-[max-content_1fr]">
                    <dt className="text-muted">Classified from</dt>
                    <dd className="break-all font-mono text-ink">{e.classificationBasis}</dd>
                    <dt className="text-muted">Recipient domain</dt>
                    <dd className="text-ink">{e.recipientDomain ?? <span className="text-muted">Not observed</span>}</dd>
                    {e.diagnosticCode ? (
                      <>
                        <dt className="text-muted">SMTP status</dt>
                        <dd className="font-mono text-ink">{e.diagnosticCode}</dd>
                      </>
                    ) : null}
                    <dt className="text-muted">Source</dt>
                    <dd className="text-ink">{EVENT_SOURCE_LABEL[e.source] ?? e.source}</dd>
                  </dl>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState title="No events observed yet">
              {neverSynced
                ? "No successful sync has completed yet, so nothing has been observed. This is not the same as no bounces or replies."
                : "No bounces, replies, complaint reports or provider errors were observed in the synced period."}
            </EmptyState>
          )}
        </Card>

        {/* ─── Sync history ─── */}
        <Card title="Sync history" description="The 15 most recent syncs." padded={false}>
          {syncs.length ? (
            <Table caption="Recent syncs with trigger, status, message counts, errors and timing" head={["Trigger", "Status", "Examined", "Created", "Duplicates", "Error", "Started", "Finished"]}>
              {syncs.map((s) => {
                const msg = sanitizeErrorMessage(s.errorMessage);
                return (
                  <tr key={s.id}>
                    <Td>{SYNC_TRIGGER_LABEL[s.trigger]}</Td>
                    <Td>
                      <SyncStatusPill status={s.status} />
                    </Td>
                    <Td className="tabular-nums">{s.messagesExamined.toLocaleString("en-US")}</Td>
                    <Td className="tabular-nums">{s.eventsCreated.toLocaleString("en-US")}</Td>
                    <Td className="tabular-nums">{s.eventsDuplicate.toLocaleString("en-US")}</Td>
                    <Td className="max-w-[260px] text-xs">
                      {s.errorCode || msg ? (
                        <>
                          {s.errorCode ? <code className="font-mono text-red-700">{s.errorCode}</code> : null}
                          {msg ? <p className="mt-0.5 break-words text-muted">{msg}</p> : null}
                        </>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-xs">{dateTime(s.startedAt)}</Td>
                    <Td className="whitespace-nowrap text-xs">{s.finishedAt ? dateTime(s.finishedAt) : s.status === "running" ? "Running…" : "—"}</Td>
                  </tr>
                );
              })}
            </Table>
          ) : (
            <EmptyState title="No syncs yet">{isDemoMailbox ? "Demo mailboxes never sync." : "The first sync runs after permissions are validated."}</EmptyState>
          )}
        </Card>

        {/* ─── Connection ─── */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Card title="Connection" className="lg:col-span-2">
            <KeyValue
              items={[
                ["State", <ConnectionPill key="s" state={m.state} />],
                ["State reason", m.stateReason ?? "—"],
                ["Provider", PROVIDER_LABEL[m.provider] ?? m.provider],
                [
                  "Granted permissions",
                  m.grantedScopes.length ? (
                    <ul key="g" className="space-y-0.5">
                      {m.grantedScopes.map((s) => (
                        <li key={s}>
                          <code className="break-all font-mono text-xs">{s}</code>
                        </li>
                      ))}
                    </ul>
                  ) : isDemoMailbox ? (
                    "Not applicable (demo)"
                  ) : (
                    "None recorded yet"
                  ),
                ],
                [
                  "Last error",
                  m.lastErrorCode || lastError ? (
                    <span key="e">
                      {m.lastErrorCode ? <code className="font-mono text-xs text-red-700">{m.lastErrorCode}</code> : null}
                      {lastError ? <span className="block break-words text-muted">{lastError}</span> : null}
                    </span>
                  ) : (
                    "None"
                  ),
                ],
                ["Consecutive failures", <span key="f" className="tabular-nums">{m.consecutiveFailures}</span>],
                ["Last successful sync", m.lastSuccessfulSyncAt ? `${dateTime(m.lastSuccessfulSyncAt)} (${relativeTime(m.lastSuccessfulSyncAt)})` : "Never"],
                ["Last sync attempt", m.lastSyncAttemptAt ? `${dateTime(m.lastSyncAttemptAt)} (${relativeTime(m.lastSyncAttemptAt)})` : "Never"],
                ["Next sync", nextSyncText(m.state, m.nextSyncAt, isDemoMailbox)],
                ["Connected", dateTime(m.createdAt)],
                ...(m.disconnectedAt ? ([["Disconnected", dateTime(m.disconnectedAt)]] as Array<[React.ReactNode, React.ReactNode]>) : []),
              ]}
            />
          </Card>
          <Card title="Disconnect" description="Revokes access (best effort), deletes stored tokens and stops monitoring.">
            {showDisconnect ? (
              <DisconnectButton connectionId={m.id} emailAddress={m.emailAddress} disabled={Boolean(disconnectReason)} disabledReason={disconnectReason} />
            ) : (
              <p className="text-sm text-muted">
                {isDemoMailbox ? "Demo mailboxes are part of the sample workspace and cannot be disconnected." : "This mailbox is already disconnected. Its stored tokens were deleted."}
              </p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
