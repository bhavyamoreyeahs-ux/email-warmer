import Link from "next/link";
import { Globe } from "lucide-react";
import { requirePage } from "@/lib/auth/page";
import { can } from "@/lib/rbac";
import { listDomains } from "@/lib/domains/service";
import { evaluateDomainHealth, type DomainCheckLite } from "@/lib/health/evaluate";
import { getOrganization } from "@/lib/tenancy/organizations";
import { CHECK_LABEL } from "@/lib/ui/format";
import { Callout, Card, CheckPill, EmptyState, Freshness, HealthPill, PageHeader, PermissionDenied, Pill, Table, Td } from "@/components/ui/primitives";
import { AddDomainForm } from "@/components/domains/add-domain-form";
import { CHECK_NAME, CHECK_ORDER, VerificationPill } from "@/components/domains/domain-display";

export const metadata = { title: "Domains" };

export default async function DomainsPage() {
  const { principal, allowed } = await requirePage("domain:view");
  if (!allowed) {
    return (
      <>
        <PageHeader title="Domains" />
        <PermissionDenied permission="domain:view" />
      </>
    );
  }

  const now = new Date();
  const [rows, org] = await Promise.all([listDomains(principal.orgId), getOrganization(principal.orgId)]);
  const staleAfterDays = org.settings.scanStaleAfterDays ?? 7;
  const canCreate = can(principal.role, "domain:create");

  const domains = rows.map((d) => {
    const scan = d.latestScan;
    const completedAt = scan?.completedAt ?? null;
    // Health from the latest completed scan's per-check summary (status only).
    const checks: DomainCheckLite[] =
      scan?.summary && completedAt
        ? CHECK_ORDER.flatMap((t) => {
            const status = scan.summary?.[t];
            return status ? [{ id: `${scan.scanId}:${t}`, checkType: t, status, summary: `${CHECK_LABEL[status]} in the latest scan`, checkedAt: completedAt }] : [];
          })
        : [];
    const health = evaluateDomainHealth({ checks, lastScanAt: d.lastScanAt, verified: d.verificationStatus === "verified", now, staleAfterDays });
    return { ...d, health };
  });

  const verifiedCount = domains.filter((d) => d.verificationStatus === "verified").length;

  return (
    <>
      <PageHeader
        title="Domains"
        lede="The domains you send from. QuikReach checks MX, SPF, DKIM and DMARC by reading public DNS — it never changes your DNS. Inconclusive means a result could not be determined; it is never shown as a pass."
        meta={
          domains.length ? (
            <>
              <span>
                {domains.length} domain{domains.length === 1 ? "" : "s"} · {verifiedCount} verified
              </span>
              <span>Scans older than {staleAfterDays} days are marked stale</span>
            </>
          ) : undefined
        }
      />

      {principal.isDemoOrg ? (
        <div className="mb-6">
          <Callout tone="demo" title="Demo workspace">
            These domains and scan results are seeded sample data. Adding, scanning, verifying and deleting domains are disabled here — create or switch to a real workspace to monitor your own domains.
          </Callout>
        </div>
      ) : null}

      {canCreate ? (
        <Card title="Add a domain" description="Add the domain in your From: addresses. A first DNS scan runs automatically." className="mb-6">
          <AddDomainForm
            disabled={principal.isDemoOrg}
            disabledReason={principal.isDemoOrg ? "Domains cannot be added to a demo workspace. Create or switch to a real workspace to add your own." : undefined}
          />
        </Card>
      ) : null}

      <Card title="Your domains" padded={false}>
        {domains.length ? (
          <Table caption="Domains with ownership verification, latest DNS check results, health, linked mailboxes and scan freshness" head={["Domain", "Ownership", "Latest checks", "Health", "Mailboxes", "Last scanned"]}>
            {domains.map((d) => (
              <tr key={d.id} className="hover:bg-canvas">
                <Td>
                  <Link href={`/domains/${d.id}`} className="font-medium text-ink underline-offset-2 hover:underline">
                    {d.name}
                  </Link>
                  {!d.monitoringEnabled ? (
                    <div className="mt-1">
                      <Pill tone="stale">Monitoring off</Pill>
                    </div>
                  ) : null}
                </Td>
                <Td>
                  <VerificationPill status={d.verificationStatus} />
                </Td>
                <Td>
                  {d.latestScan?.summary ? (
                    <ul className="flex max-w-[280px] flex-wrap gap-x-3 gap-y-1.5">
                      {CHECK_ORDER.map((t) => {
                        const status = d.latestScan?.summary?.[t];
                        return (
                          <li key={t} className="inline-flex items-center gap-1 text-xs text-muted">
                            {CHECK_NAME[t]} {status ? <CheckPill status={status} /> : <Pill tone="unknown">Not checked</Pill>}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <Pill tone="unknown">No completed scan yet</Pill>
                  )}
                </Td>
                <Td>
                  <HealthPill state={d.health.state} />
                </Td>
                <Td className="tabular-nums">{d.mailboxCount}</Td>
                <Td>
                  <div className="flex flex-col items-start gap-1">
                    <Freshness at={d.lastScanAt} staleAfterMs={staleAfterDays * 86_400_000} label="Scanned" />
                    {d.scanPending ? <Pill tone="info">Scan pending</Pill> : null}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState icon={Globe} title="No domains yet">
            {canCreate
              ? "Add the domain you send from above. QuikReach will give you one TXT record to publish for ownership verification and run a first MX, SPF, DKIM and DMARC scan."
              : "No domains have been added to this workspace. Ask a Deliverability Manager, Administrator or Owner to add one."}
          </EmptyState>
        )}
      </Card>
    </>
  );
}
