import Link from "next/link";
import { ArrowLeft, FileSearch, Inbox, PowerOff, Power, Trash2 } from "lucide-react";
import { requirePage } from "@/lib/auth/page";
import { can } from "@/lib/rbac";
import { getDomainDetail } from "@/lib/domains/service";
import { evaluateDomainHealth } from "@/lib/health/evaluate";
import { getOrganization } from "@/lib/tenancy/organizations";
import { assertUuid, orNotFound } from "@/lib/ui/server";
import { dateTime, PROVIDER_LABEL, relativeTime } from "@/lib/ui/format";
import type { DnsQueryEvidence } from "@/lib/db/schema";
import {
  buttonStyles,
  Callout,
  Card,
  CheckPill,
  ConnectionPill,
  EmptyState,
  Freshness,
  HealthPill,
  KeyValue,
  LinkButton,
  PageHeader,
  PermissionDenied,
  Pill,
  Table,
  Td,
} from "@/components/ui/primitives";
import { ActionButton, EvidenceDrawer } from "@/components/ui/interactive";
import {
  CHECK_NAME,
  CHECK_ORDER,
  CHECK_PURPOSE,
  DnsOutcomePill,
  DnsQueryList,
  FindingSeverityPill,
  SCAN_TRIGGER_LABEL,
  ScanStatusPill,
  VerificationPill,
} from "@/components/domains/domain-display";
import { CopyButton } from "@/components/domains/copy-button";
import { VerifyButton } from "@/components/domains/verify-button";
import { ScanButton } from "@/components/domains/scan-button";
import { DkimSelectorsForm } from "@/components/domains/dkim-selectors-form";

export const metadata = { title: "Domain details" };

const DEMO_REASON = "Disabled in this demo workspace — it holds sample data only, and actions that write live data are rejected.";

function isQueryEvidence(v: unknown): v is DnsQueryEvidence {
  if (typeof v !== "object" || v === null) return false;
  const q = v as Record<string, unknown>;
  return typeof q.name === "string" && typeof q.type === "string" && Array.isArray(q.answers) && q.answers.every((a) => typeof a === "string") && typeof q.outcome === "string" && typeof q.durationMs === "number";
}

/** Verification evidence is stored as loose JSON: { query, outcome, detail, resolver }. Narrow it field by field. */
function readVerificationEvidence(e: Record<string, unknown> | null | undefined) {
  if (!e) return null;
  return {
    query: isQueryEvidence(e.query) ? e.query : null,
    outcome: typeof e.outcome === "string" ? e.outcome : null,
    detail: typeof e.detail === "string" ? e.detail : null,
    resolver: typeof e.resolver === "string" ? e.resolver : null,
  };
}

export default async function DomainDetailPage({ params }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { principal, allowed } = await requirePage("domain:view");
  if (!allowed) {
    return (
      <>
        <PageHeader title="Domain" />
        <PermissionDenied permission="domain:view" />
      </>
    );
  }
  const { id: rawId } = await params;
  const id = assertUuid(rawId);
  const now = new Date();
  const [detail, org] = await Promise.all([orNotFound(getDomainDetail(principal.orgId, id)), getOrganization(principal.orgId)]);
  const { domain, verification, scans, latestScan, previousScan, latestChecks, comparison, mailboxes } = detail;
  const staleAfterDays = org.settings.scanStaleAfterDays ?? 7;
  const verified = domain.verificationStatus === "verified";

  const health = evaluateDomainHealth({ checks: latestChecks, lastScanAt: domain.lastScanAt, verified, now, staleAfterDays });
  const pendingScan = scans.find((s) => s.status === "queued" || s.status === "running") ?? null;
  const evidence = readVerificationEvidence(verification?.evidence);
  const relativeHost = verification && verification.recordName.endsWith(`.${domain.name}`) ? verification.recordName.slice(0, -(domain.name.length + 1)) : null;

  const demo = principal.isDemoOrg;
  const reasonFor = (permission: "domain:scan" | "domain:update" | "domain:delete") =>
    demo ? DEMO_REASON : !can(principal.role, permission) ? `Your role does not include ${permission}. Ask an Owner, Administrator or Deliverability Manager.` : undefined;
  const scanReason = reasonFor("domain:scan");
  const updateReason = reasonFor("domain:update");
  const deleteReason = reasonFor("domain:delete");

  return (
    <>
      <div className="mb-3">
        <Link href="/domains" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
          <ArrowLeft aria-hidden className="h-4 w-4" />
          All domains
        </Link>
      </div>
      <PageHeader
        title={domain.name}
        lede="Ownership verification and DNS authentication checks. Results come from public DNS lookups; QuikReach never edits your DNS records."
        meta={
          <>
            <VerificationPill status={domain.verificationStatus} />
            <span className="inline-flex items-center gap-1.5">
              Configuration <HealthPill state={health.state} />
            </span>
            <Freshness at={domain.lastScanAt} staleAfterMs={staleAfterDays * 86_400_000} label="Scanned" />
            {pendingScan ? <Pill tone="info">Scan {pendingScan.status === "running" ? "running" : "pending"}</Pill> : null}
            {domain.monitoringEnabled ? <span>Scheduled monitoring on</span> : <Pill tone="stale">Scheduled monitoring off</Pill>}
            <span>Added {dateTime(domain.createdAt)}</span>
          </>
        }
        actions={
          <>
            <ScanButton domainId={domain.id} trigger="manual" label="Re-scan now" disabled={Boolean(scanReason)} disabledReason={scanReason} />
            <ScanButton domainId={domain.id} trigger="recheck" label="Re-check after I made changes" variant="primary" disabled={Boolean(scanReason)} disabledReason={scanReason} />
          </>
        }
      />
      {scanReason ? <p className="-mt-3 mb-6 text-xs text-muted">Scanning: {scanReason}</p> : null}

      <div className="space-y-6">
        {demo ? (
          <Callout tone="demo" title="Demo workspace">
            This domain and its scan results are seeded sample data. Scanning, verification, selector edits, monitoring changes and deletion are disabled because demo workspaces never receive live data.
          </Callout>
        ) : null}

        {pendingScan ? (
          <Callout tone="info" title={pendingScan.status === "running" ? "A scan is running" : "A scan is queued"}>
            Requested {relativeTime(pendingScan.createdAt)} ({SCAN_TRIGGER_LABEL[pendingScan.trigger]}). The results below are from the last completed scan until it finishes — refresh this page in a minute.
          </Callout>
        ) : null}

        {/* ─── Verification ─── */}
        <Card
          title="Ownership verification"
          description="Proves you control this domain. Scheduled monitoring and alerts are limited until it is verified."
          actions={<VerificationPill status={domain.verificationStatus} />}
        >
          {verified ? (
            <div className="space-y-3 text-sm">
              <p className="text-ink">
                Verified {dateTime(domain.verifiedAt)}
                {verification ? (
                  <>
                    {" "}
                    via the TXT record at <code className="break-all rounded bg-canvas px-1 font-mono text-xs">{verification.recordName}</code>
                  </>
                ) : null}
                .
              </p>
              {verification ? (
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted">Show the verification record</summary>
                  <div className="mt-3">
                    <KeyValue
                      items={[
                        ["Type", <code key="t" className="font-mono text-xs">TXT</code>],
                        ["Name", <code key="n" className="break-all font-mono text-xs">{verification.recordName}</code>],
                        ["Value", <code key="v" className="break-all font-mono text-xs">{verification.expectedValue}</code>],
                      ]}
                    />
                  </div>
                </details>
              ) : null}
            </div>
          ) : (
            <div className="space-y-5">
              {verification ? (
                <ol className="list-decimal space-y-4 pl-5 text-sm text-ink">
                  <li>Sign in to the DNS provider that hosts {domain.name} (your registrar or DNS host).</li>
                  <li>
                    <span>Create this TXT record exactly as shown:</span>
                    <div className="mt-3 space-y-3 rounded-md border border-line p-3">
                      <div>
                        <div className="text-xs uppercase tracking-[0.08em] text-muted">Type</div>
                        <code className="font-mono text-sm">TXT</code>
                      </div>
                      <div>
                        <div className="text-xs uppercase tracking-[0.08em] text-muted">Name / host</div>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <code className="min-w-0 break-all rounded bg-canvas px-2 py-1 font-mono text-sm">{verification.recordName}</code>
                          <CopyButton value={verification.recordName} label="record name" />
                        </div>
                        {relativeHost ? (
                          <p className="mt-1 text-xs text-muted">
                            If your DNS provider adds {domain.name} automatically, enter only <code className="rounded bg-canvas px-1 font-mono">{relativeHost}</code> as the host.
                          </p>
                        ) : null}
                      </div>
                      <div>
                        <div className="text-xs uppercase tracking-[0.08em] text-muted">Value</div>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <code className="min-w-0 break-all rounded bg-canvas px-2 py-1 font-mono text-sm">{verification.expectedValue}</code>
                          <CopyButton value={verification.expectedValue} label="record value" />
                        </div>
                      </div>
                      <div>
                        <div className="text-xs uppercase tracking-[0.08em] text-muted">TTL</div>
                        <span className="text-sm">Your provider&apos;s default is fine.</span>
                      </div>
                    </div>
                  </li>
                  <li>Select Check now. New DNS records can take from a few minutes to a few hours to become visible.</li>
                </ol>
              ) : (
                <p className="text-sm text-muted">No verification record has been issued for this domain yet. Select Check now to generate the TXT record you need to publish.</p>
              )}

              <VerifyButton domainId={domain.id} disabled={Boolean(updateReason)} disabledReason={updateReason} />

              <div className="border-t border-line pt-4">
                <h3 className="text-sm font-medium text-ink">Last check</h3>
                {verification?.lastCheckedAt ? (
                  <div className="mt-2 space-y-3">
                    <KeyValue
                      items={[
                        ["Checked", `${dateTime(verification.lastCheckedAt)} (${relativeTime(verification.lastCheckedAt)})`],
                        ["DNS outcome", evidence?.outcome ? <DnsOutcomePill key="o" outcome={evidence.outcome} /> : <Pill key="o" tone="unknown">Not recorded</Pill>],
                        ["Result", evidence?.detail ?? "—"],
                        ["Resolver", evidence?.resolver ?? "—"],
                      ]}
                    />
                    {evidence?.query ? (
                      <details className="text-sm">
                        <summary className="cursor-pointer text-muted">Show the DNS query and answers</summary>
                        <div className="mt-3">
                          <DnsQueryList queries={[evidence.query]} />
                        </div>
                      </details>
                    ) : null}
                  </div>
                ) : (
                  <p className="mt-1 text-sm text-muted">Not checked yet.</p>
                )}
              </div>

              <Callout tone="info" title="QuikReach never edits your DNS">
                You publish this record yourself at your DNS provider. QuikReach only reads it with a single TXT lookup; it has no access to change your DNS.
              </Callout>
            </div>
          )}
        </Card>

        {/* ─── Health summary ─── */}
        <Card
          title="Domain configuration"
          description={`QuikReach's own heuristic (rules ${health.ruleVersion}) built from the latest completed checks — not a mailbox provider's reputation score.`}
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
                {health.missing.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>

        {/* ─── Latest checks ─── */}
        <Card
          title="Latest DNS checks"
          description={
            latestScan
              ? `From the scan completed ${dateTime(latestScan.completedAt)} (${relativeTime(latestScan.completedAt)}). Inconclusive means QuikReach could not determine the result — it is not a failure.`
              : "No scan has completed yet."
          }
        >
          {latestScan ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {CHECK_ORDER.map((t) => {
                const c = latestChecks.find((x) => x.checkType === t);
                return (
                  <article key={t} aria-labelledby={`check-${t}`} className="flex flex-col rounded-md border border-line p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 id={`check-${t}`} className="text-sm font-medium text-ink">
                          {CHECK_NAME[t]}
                        </h3>
                        <p className="text-xs text-muted">{CHECK_PURPOSE[t]}</p>
                      </div>
                      {c ? <CheckPill status={c.status} /> : <Pill tone="unknown">Not checked</Pill>}
                    </div>
                    {c ? (
                      <>
                        <p className="mt-3 break-words text-sm text-ink">{c.summary}</p>
                        {c.status === "inconclusive" ? (
                          <div className="mt-3">
                            <Callout tone="unknown" title="Could not determine">
                              QuikReach could not determine this result — for example a DNS lookup timed out, a server failed to answer, or no DKIM selector is known. This is not a failure and is never counted as a pass. Check the evidence, then re-check later.
                            </Callout>
                          </div>
                        ) : null}
                        {t === "dkim" && domain.dkimSelectors.length === 0 ? (
                          <p className="mt-3 text-xs text-muted">
                            No DKIM selectors are configured, so only common selectors were tried.{" "}
                            <a href="#dkim-selectors-card" className="text-accent-700 underline underline-offset-2">
                              Add your selectors
                            </a>
                            .
                          </p>
                        ) : null}
                        {c.findings.length ? (
                          <div className="mt-3">
                            <h4 className="text-xs font-medium uppercase tracking-[0.08em] text-muted">Findings</h4>
                            <ul className="mt-2 space-y-3">
                              {c.findings.map((f, i) => (
                                <li key={`${f.code}-${i}`} className="text-sm">
                                  <div className="flex flex-wrap items-start gap-2">
                                    <FindingSeverityPill severity={f.severity} />
                                    <span className="min-w-0 flex-1 break-words text-ink">{f.message}</span>
                                  </div>
                                  {f.recommendation ? (
                                    <p className="mt-1 break-words text-xs text-muted">
                                      <span className="font-medium text-ink">Recommendation: </span>
                                      {f.recommendation}
                                    </p>
                                  ) : null}
                                  <p className="mt-0.5 font-mono text-[11px] text-muted">{f.code}</p>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : (
                          <p className="mt-3 text-xs text-muted">No findings.</p>
                        )}
                        <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 border-t border-line pt-3 text-xs">
                          <dt className="text-muted">Checked</dt>
                          <dd className="text-ink">{dateTime(c.checkedAt)}</dd>
                          <dt className="text-muted">Resolver</dt>
                          <dd className="break-all text-ink">{c.resolver}</dd>
                          <dt className="text-muted">Rule version</dt>
                          <dd className="font-mono text-ink">{c.ruleVersion}</dd>
                          <dt className="text-muted">Duration</dt>
                          <dd className="tabular-nums text-ink">{c.durationMs} ms</dd>
                        </dl>
                        <div className="mt-3">
                          <EvidenceDrawer
                            title={`${CHECK_NAME[t]} evidence — ${domain.name}`}
                            trigger={
                              <button type="button" className={buttonStyles.secondary}>
                                <FileSearch aria-hidden className="h-4 w-4" />
                                View DNS evidence ({c.evidence.queries.length} quer{c.evidence.queries.length === 1 ? "y" : "ies"})
                              </button>
                            }
                          >
                            <div className="space-y-5">
                              <div className="flex flex-wrap items-center gap-2">
                                <CheckPill status={c.status} />
                                <span className="text-xs text-muted">
                                  Checked {dateTime(c.checkedAt)} · resolver {c.resolver} · rules {c.ruleVersion} · {c.durationMs} ms
                                </span>
                              </div>
                              <section>
                                <h3 className="text-sm font-medium text-ink">DNS queries</h3>
                                <p className="mb-3 mt-0.5 text-xs text-muted">Every lookup made for this check, with answers exactly as the resolver returned them.</p>
                                <DnsQueryList queries={c.evidence.queries} />
                              </section>
                              <section>
                                <h3 className="text-sm font-medium text-ink">Parsed result</h3>
                                <p className="mb-2 mt-0.5 text-xs text-muted">How QuikReach interpreted the answers above.</p>
                                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md bg-canvas p-3 font-mono text-xs text-ink">
                                  {c.evidence.parsed ? JSON.stringify(c.evidence.parsed, null, 2) : "No parsed data recorded."}
                                </pre>
                              </section>
                            </div>
                          </EvidenceDrawer>
                        </div>
                      </>
                    ) : (
                      <p className="mt-3 text-sm text-muted">This check has no result in the latest completed scan.</p>
                    )}
                  </article>
                );
              })}
            </div>
          ) : (
            <EmptyState title="No completed scan yet">
              {pendingScan ? "The first scan is queued — results usually appear within a minute. Refresh this page to see them." : "Run a scan to check MX, SPF, DKIM and DMARC."}
            </EmptyState>
          )}
        </Card>

        {/* ─── DKIM selectors ─── */}
        <div id="dkim-selectors-card" className="scroll-mt-6">
          <Card title="DKIM selectors" description="DKIM keys live at <selector>._domainkey.<domain>, and selectors cannot be discovered from DNS — tell QuikReach which ones you use.">
            <div className="space-y-4">
              <div className="space-y-1 text-sm text-muted">
                <p>
                  Find a selector in a message you have sent: open the original message (&ldquo;Show original&rdquo; / &ldquo;View message source&rdquo;), find the{" "}
                  <code className="rounded bg-canvas px-1 font-mono text-xs">DKIM-Signature</code> header, and copy the value of its{" "}
                  <code className="rounded bg-canvas px-1 font-mono text-xs">s=</code> tag (for example <code className="rounded bg-canvas px-1 font-mono text-xs">s=google</code> or{" "}
                  <code className="rounded bg-canvas px-1 font-mono text-xs">s=selector1</code>).
                </p>
                <p>Add one selector for each service that sends as {domain.name}. After saving, re-check so the DKIM result uses the new list.</p>
              </div>
              <DkimSelectorsForm
                domainId={domain.id}
                initial={domain.dkimSelectors}
                disabled={Boolean(updateReason)}
                disabledReason={updateReason}
                canRecheck={!scanReason}
                recheckDisabledReason={scanReason}
              />
            </div>
          </Card>
        </div>

        {/* ─── Comparison ─── */}
        <Card
          title="Compared with the previous scan"
          description={previousScan && latestScan ? `Previous scan ${dateTime(previousScan.completedAt)} → latest ${dateTime(latestScan.completedAt)}` : undefined}
          padded={!previousScan}
        >
          {previousScan ? (
            <Table caption="Before and after status of each DNS check, and whether the DNS answers changed" head={["Check", "Before", "After", "Status changed", "DNS records changed"]}>
              {comparison.map((row) => {
                const comparable = row.before !== null && row.after !== null;
                return (
                  <tr key={row.checkType}>
                    <Td className="font-medium text-ink">{CHECK_NAME[row.checkType]}</Td>
                    <Td>{row.before ? <CheckPill status={row.before} /> : <Pill tone="unknown">No result</Pill>}</Td>
                    <Td>{row.after ? <CheckPill status={row.after} /> : <Pill tone="unknown">No result</Pill>}</Td>
                    <Td>{comparable ? row.statusChanged ? <Pill tone="warn">Changed</Pill> : <span className="text-muted">No change</span> : <span className="text-muted">Not comparable</span>}</Td>
                    <Td>{comparable ? row.recordsChanged ? <Pill tone="warn">Records changed</Pill> : <span className="text-muted">Same answers</span> : <span className="text-muted">Not comparable</span>}</Td>
                  </tr>
                );
              })}
            </Table>
          ) : (
            <p className="text-sm text-muted">
              {latestScan ? "Only one scan has completed so far. A before/after comparison appears after the next completed scan." : "No completed scans yet."}
            </p>
          )}
        </Card>

        {/* ─── Scan history ─── */}
        <Card title="Scan history" description="The 20 most recent scans." padded={!scans.length}>
          {scans.length ? (
            <Table caption="Recent DNS scans with trigger, status, timing and per-check results" head={["Trigger", "Status", "Requested", "Started", "Completed", "Results"]}>
              {scans.map((s) => (
                <tr key={s.id}>
                  <Td>{SCAN_TRIGGER_LABEL[s.trigger]}</Td>
                  <Td>
                    <ScanStatusPill status={s.status} />
                  </Td>
                  <Td className="whitespace-nowrap text-xs">{dateTime(s.createdAt)}</Td>
                  <Td className="whitespace-nowrap text-xs">{dateTime(s.startedAt)}</Td>
                  <Td className="whitespace-nowrap text-xs">{dateTime(s.completedAt)}</Td>
                  <Td>
                    {s.status === "failed" ? (
                      <span className="break-words text-xs text-red-700">{s.error ?? "The scan failed without an error message."}</span>
                    ) : s.summary ? (
                      <ul className="flex flex-wrap gap-x-3 gap-y-1">
                        {CHECK_ORDER.map((t) => {
                          const st = s.summary?.[t];
                          return (
                            <li key={t} className="inline-flex items-center gap-1 text-xs text-muted">
                              {CHECK_NAME[t]} {st ? <CheckPill status={st} /> : <Pill tone="unknown">—</Pill>}
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <span className="text-xs text-muted">{s.status === "completed" ? "No summary recorded" : "Waiting for results"}</span>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          ) : (
            <p className="text-sm text-muted">No scans yet.</p>
          )}
        </Card>

        {/* ─── Linked mailboxes ─── */}
        <Card
          title="Linked mailboxes"
          description="A mailbox is linked when its address uses this domain at the time it is connected."
          padded={!mailboxes.length}
          actions={<LinkButton href="/mailboxes" variant="ghost">Mailboxes</LinkButton>}
        >
          {mailboxes.length ? (
            <ul className="divide-y divide-line">
              {mailboxes.map((m) => (
                <li key={m.id}>
                  <Link href={`/mailboxes/${m.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-canvas">
                    <Inbox aria-hidden className="h-4 w-4 text-muted" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{m.emailAddress}</span>
                    <span className="text-xs text-muted">{PROVIDER_LABEL[m.provider] ?? m.provider}</span>
                    <ConnectionPill state={m.state} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No mailboxes are linked to {domain.name}. Connect a mailbox that sends as this domain to monitor bounces and replies.</p>
          )}
        </Card>

        {/* ─── Settings & danger zone ─── */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card title="Scheduled monitoring" description="Periodic scans that keep these results fresh and feed DNS-change alerts.">
            <div className="space-y-3">
              <p className="text-sm text-ink">
                Scheduled monitoring is <strong className="font-medium">{domain.monitoringEnabled ? "on" : "off"}</strong>.
                {domain.monitoringEnabled ? "" : " Results will become stale; manual scans still work."}
              </p>
              {domain.monitoringEnabled ? (
                <ActionButton
                  label="Turn off scheduled monitoring"
                  path={`/api/v1/domains/${domain.id}`}
                  method="PATCH"
                  body={{ monitoringEnabled: false }}
                  icon={<PowerOff aria-hidden className="h-4 w-4" />}
                  disabled={Boolean(updateReason)}
                  disabledReason={updateReason}
                  confirm={{
                    title: `Turn off scheduled monitoring for ${domain.name}?`,
                    description: "Scheduled scans stop, so results will go stale and DNS changes will not raise alerts. Manual scans still work, and you can turn monitoring back on at any time.",
                    confirmLabel: "Turn off monitoring",
                  }}
                  successMessage="Scheduled monitoring turned off."
                />
              ) : (
                <ActionButton
                  label="Turn on scheduled monitoring"
                  path={`/api/v1/domains/${domain.id}`}
                  method="PATCH"
                  body={{ monitoringEnabled: true }}
                  variant="primary"
                  icon={<Power aria-hidden className="h-4 w-4" />}
                  disabled={Boolean(updateReason)}
                  disabledReason={updateReason}
                  successMessage="Scheduled monitoring turned on."
                />
              )}
              {updateReason ? <p className="text-xs text-muted">{updateReason}</p> : null}
            </div>
          </Card>
          <Card title="Delete domain" description="Removes the domain, its verification and all scan history from QuikReach.">
            <div className="space-y-3">
              <p className="text-sm text-muted">Linked mailboxes stay connected but are unlinked from this domain. Your DNS records are not changed.</p>
              <ActionButton
                label="Delete domain"
                path={`/api/v1/domains/${domain.id}`}
                method="DELETE"
                variant="danger"
                icon={<Trash2 aria-hidden className="h-4 w-4" />}
                disabled={Boolean(deleteReason)}
                disabledReason={deleteReason}
                confirm={{
                  title: `Delete ${domain.name}?`,
                  description: "This permanently removes the domain, its ownership verification and every scan and check result from QuikReach. Linked mailboxes are unlinked but stay connected. Your DNS is not changed. This cannot be undone.",
                  confirmLabel: "Delete domain",
                  requireReason: true,
                }}
                successMessage="Domain deleted."
                redirectTo="/domains"
              />
              {deleteReason ? <p className="text-xs text-muted">{deleteReason}</p> : null}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
