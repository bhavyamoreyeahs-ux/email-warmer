import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePage } from "@/lib/auth/page";
import { can } from "@/lib/rbac";
import { METRIC_INFO } from "@/lib/alerts/schemas";
import { listDomains } from "@/lib/domains/service";
import { listMailboxes } from "@/lib/mailboxes/service";
import { listIntegrations } from "@/lib/integrations/service";
import { emailConfigured } from "@/lib/notify/email";
import { PageHeader, PermissionDenied } from "@/components/ui/primitives";
import { RuleBuilder } from "@/components/alerts/rule-builder";

export const metadata = { title: "New alert rule" };

export default async function NewRulePage() {
  const { principal, allowed } = await requirePage("alert_rule:manage");
  if (!allowed) {
    return (
      <>
        <PageHeader title="New alert rule" />
        <PermissionDenied permission="alert_rule:manage" />
      </>
    );
  }

  const [domains, mailboxes, integrations] = await Promise.all([listDomains(principal.orgId), listMailboxes(principal.orgId), listIntegrations(principal.orgId)]);

  return (
    <>
      <Link href="/alerts" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft aria-hidden className="h-4 w-4" />
        Alerts &amp; rules
      </Link>
      <PageHeader
        title="New alert rule"
        lede="Define what to watch, when it counts as a problem, and who to tell. Use “Test (dry run)” to see what the rule would do against current data before saving — the test saves and sends nothing."
      />
      <RuleBuilder
        mode="create"
        metricInfo={METRIC_INFO}
        domains={domains.map((d) => ({ id: d.id, name: d.name }))}
        mailboxes={mailboxes.filter((m) => m.state !== "disconnected").map((m) => ({ id: m.id, label: `${m.emailAddress}${m.isDemo ? " (demo)" : ""}` }))}
        webhooks={integrations.filter((i) => i.kind === "notification_webhook" && i.status === "active").map((i) => ({ id: i.id, name: i.name }))}
        campaignIntegrationActive={integrations.some((i) => i.kind === "campaign_webhook" && i.status === "active")}
        emailDeliveryConfigured={emailConfigured()}
        canManage
        canTest={can(principal.role, "alert_rule:test")}
      />
    </>
  );
}
