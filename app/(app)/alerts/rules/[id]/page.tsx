import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePage } from "@/lib/auth/page";
import { can } from "@/lib/rbac";
import { getRule } from "@/lib/alerts/rules";
import { METRIC_INFO, type AlertRuleInput } from "@/lib/alerts/schemas";
import { listDomains } from "@/lib/domains/service";
import { listMailboxes } from "@/lib/mailboxes/service";
import { listIntegrations } from "@/lib/integrations/service";
import { emailConfigured } from "@/lib/notify/email";
import { assertUuid, orNotFound } from "@/lib/ui/server";
import { PageHeader, PermissionDenied, Pill } from "@/components/ui/primitives";
import { RuleBuilder } from "@/components/alerts/rule-builder";
import { dateTime } from "@/lib/ui/format";

export const metadata = { title: "Alert rule" };

export default async function RulePage({ params }: { params: Promise<{ id: string }> }) {
  const { principal, allowed } = await requirePage("alert_rule:view");
  if (!allowed) {
    return (
      <>
        <PageHeader title="Alert rule" />
        <PermissionDenied permission="alert_rule:view" />
      </>
    );
  }
  const id = assertUuid((await params).id);
  const [rule, domains, mailboxes, integrations] = await Promise.all([
    orNotFound(getRule(principal.orgId, id)),
    listDomains(principal.orgId),
    listMailboxes(principal.orgId),
    listIntegrations(principal.orgId),
  ]);
  const canManage = can(principal.role, "alert_rule:manage");

  const initial: AlertRuleInput = {
    name: rule.name,
    description: rule.description,
    metric: rule.metric,
    scopeType: rule.scopeType,
    scopeId: rule.scopeId,
    comparator: rule.comparator,
    threshold: rule.threshold,
    windowMinutes: rule.windowMinutes,
    minSample: rule.minSample,
    severity: rule.severity,
    notificationTargets: {
      inApp: rule.notificationTargets.inApp,
      emails: rule.notificationTargets.emails ?? [],
      webhookIntegrationId: rule.notificationTargets.webhookIntegrationId ?? null,
    },
    actionPolicy: rule.actionPolicy,
    requireManualResume: rule.requireManualResume,
    cooldownMinutes: rule.cooldownMinutes,
    enabled: rule.enabled,
  };

  // Keep the rule's current scope selectable even if that mailbox is now disconnected.
  const mailboxOptions = mailboxes
    .filter((m) => m.state !== "disconnected" || m.id === rule.scopeId)
    .map((m) => ({ id: m.id, label: `${m.emailAddress}${m.isDemo ? " (demo)" : m.state === "disconnected" ? " (disconnected)" : ""}` }));

  return (
    <>
      <Link href="/alerts" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft aria-hidden className="h-4 w-4" />
        Alerts &amp; rules
      </Link>
      <PageHeader
        title={rule.name}
        lede={canManage ? "Saving creates a new version and is recorded in the audit log. Alerts already raised keep the version they were raised under." : "Viewing this rule read-only."}
        meta={
          <>
            {rule.enabled ? <Pill tone="good">Enabled</Pill> : <Pill tone="unknown">Disabled</Pill>}
            <span>Version {rule.version}</span>
            <span>Updated {dateTime(rule.updatedAt)}</span>
            <span>Created {dateTime(rule.createdAt)}</span>
          </>
        }
      />
      <RuleBuilder
        mode="edit"
        ruleId={rule.id}
        version={rule.version}
        initial={initial}
        metricInfo={METRIC_INFO}
        domains={domains.map((d) => ({ id: d.id, name: d.name }))}
        mailboxes={mailboxOptions}
        webhooks={integrations.filter((i) => i.kind === "notification_webhook" && i.status === "active").map((i) => ({ id: i.id, name: i.name }))}
        campaignIntegrationActive={integrations.some((i) => i.kind === "campaign_webhook" && i.status === "active")}
        emailDeliveryConfigured={emailConfigured()}
        canManage={canManage}
        canTest={can(principal.role, "alert_rule:test")}
      />
    </>
  );
}
