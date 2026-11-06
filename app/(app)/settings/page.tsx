import { Check, Minus, PauseCircle, PlayCircle } from "lucide-react";
import { requirePage } from "@/lib/auth/page";
import { getOrganization } from "@/lib/tenancy/organizations";
import { env } from "@/lib/env";
import { emailConfigured } from "@/lib/notify/email";
import { can, PERMISSIONS, ROLE_LABELS, ROLE_PERMISSIONS } from "@/lib/rbac";
import { ROLES } from "@/lib/db/schema";
import { Callout, Card, KeyValue, PageHeader, PermissionDenied, Pill, Table, Td } from "@/components/ui/primitives";
import { ActionButton } from "@/components/ui/interactive";
import { SettingsNav } from "@/components/settings/settings-nav";
import { AlertEmailsForm, FreshnessForm, OrganizationNameForm, RetentionForm } from "@/components/settings/organization-forms";
import { dateTime } from "@/lib/ui/format";

export const metadata = { title: "Settings" };

/** Effective defaults used by lib/health/service.ts when the organisation has not set its own. */
const FRESHNESS_DEFAULTS = { syncStaleAfterHours: 2, scanStaleAfterDays: 7 };

export default async function SettingsPage() {
  const { principal, allowed } = await requirePage("organization:view");
  const header = <PageHeader title="Settings" lede="Workspace configuration, data retention, notification defaults, the automation kill switch and who can do what." />;
  if (!allowed) {
    return (
      <>
        {header}
        <SettingsNav role={principal.role} />
        <PermissionDenied permission="organization:view" />
      </>
    );
  }

  const org = await getOrganization(principal.orgId);
  const e = env();
  const canEdit = can(principal.role, "organization:update");
  const mailReady = emailConfigured();
  const retentionDefaults = {
    eventRetentionDays: e.DEFAULT_EVENT_RETENTION_DAYS,
    diagnosticRetentionDays: e.DEFAULT_DIAGNOSTIC_RETENTION_DAYS,
    auditRetentionDays: e.DEFAULT_AUDIT_RETENTION_DAYS,
  };

  return (
    <>
      {header}
      <SettingsNav role={principal.role} />

      {!canEdit ? (
        <div className="mb-6">
          <Callout tone="unknown">You can view these settings. Changing them needs organization:update (Owners and Administrators).</Callout>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="General">
          <OrganizationNameForm name={org.name} canEdit={canEdit} />
          <div className="mt-5 border-t border-line pt-4">
            <KeyValue
              items={[
                ["Workspace ID", <code key="id" className="break-all text-xs">{org.id}</code>],
                ["Slug", <code key="slug" className="text-xs">{org.slug}</code>],
                ["Type", org.isDemo ? <Pill key="t" tone="demo">Demo workspace (sample data)</Pill> : "Live workspace"],
                ["Sign-in", e.authMode === "quikit_sso" ? "QuikIT single sign-on" : "Email and password"],
                ["Created", dateTime(org.createdAt)],
              ]}
            />
          </div>
        </Card>

        <Card title="Automation kill switch" description="Stops QuikReach's scheduled work for this workspace in one step">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-ink">Current state:</span>
            {org.automationPaused ? <Pill tone="warn">Automation paused</Pill> : <Pill tone="good">Automation running</Pill>}
          </div>
          <p className="mt-3 text-sm text-muted">While automation is paused:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted">
            <li>Scheduled mailbox syncs and scheduled DNS scans stop, so data becomes stale (shown as Stale, never Healthy).</li>
            <li>Periodic alert evaluation and health snapshots stop.</li>
            <li>Alerts never trigger automated campaign pause requests — they notify only.</li>
            <li>Manual actions (sync now, scan now, manual pause/resume requests) remain available.</li>
          </ul>
          <div className="mt-4">
            {canEdit ? (
              org.automationPaused ? (
                <ActionButton
                  label="Resume all automation"
                  variant="primary"
                  icon={<PlayCircle aria-hidden className="h-4 w-4" />}
                  path="/api/v1/organization/automation"
                  body={{ paused: false }}
                  confirm={{
                    title: "Resume all automation?",
                    description: "Scheduled syncs, scans, alert evaluation and automated campaign actions resume on the next scheduler tick (within about a minute).",
                    confirmLabel: "Resume automation",
                    requireReason: true,
                  }}
                  successMessage="Automation resumed."
                />
              ) : (
                <ActionButton
                  label="Pause all automation"
                  variant="danger"
                  icon={<PauseCircle aria-hidden className="h-4 w-4" />}
                  path="/api/v1/organization/automation"
                  body={{ paused: true }}
                  confirm={{
                    title: "Pause all automation?",
                    description: "QuikReach stops scheduled syncs, scans and alert evaluation for this workspace, and alerts will not request campaign pauses. Monitoring data will go stale until you resume.",
                    confirmLabel: "Pause automation",
                    requireReason: true,
                  }}
                  successMessage="Automation paused."
                />
              )
            ) : (
              <p className="text-xs text-muted">Only roles with organization:update can change this.</p>
            )}
          </div>
        </Card>
      </div>

      <Card title="Data retention" description="How long QuikReach keeps each kind of record before the daily purge deletes it" className="mt-6">
        <div className="mb-4">
          <Callout tone="warn">Default retention periods are placeholders pending product/security review.</Callout>
        </div>
        <RetentionForm
          values={{ eventRetentionDays: org.eventRetentionDays, diagnosticRetentionDays: org.diagnosticRetentionDays, auditRetentionDays: org.auditRetentionDays }}
          defaults={retentionDefaults}
          canEdit={canEdit}
        />
      </Card>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Notification defaults">
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-ink">Email delivery:</span>
            {mailReady ? <Pill tone="good">Configured</Pill> : <Pill tone="unknown">Not configured</Pill>}
          </div>
          {!mailReady ? (
            <p className="mb-4 text-xs text-muted">
              This deployment has no outgoing email (SMTP_URL and EMAIL_FROM). Email notifications are recorded as “not configured” — never as sent — and invitation links must be shared by hand. In-app notifications and notification webhooks still work.
            </p>
          ) : null}
          <AlertEmailsForm emails={org.settings.defaultAlertEmails ?? []} canEdit={canEdit} />
        </Card>
        <Card title="Freshness thresholds" description="When monitoring data stops counting as current">
          <FreshnessForm
            syncStaleAfterHours={org.settings.syncStaleAfterHours ?? null}
            scanStaleAfterDays={org.settings.scanStaleAfterDays ?? null}
            defaults={FRESHNESS_DEFAULTS}
            canEdit={canEdit}
          />
        </Card>
      </div>

      <Card title="Roles and permissions" description="Read-only. The same matrix is enforced by every API route." className="mt-6" padded={false}>
        <ul className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
          {ROLES.map((r) => (
            <li key={r} className="rounded-md border border-line p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">{ROLE_LABELS[r].name}</span>
                {r === principal.role ? <Pill tone="info">Your role</Pill> : null}
              </div>
              <p className="mt-1 text-xs text-muted">{ROLE_LABELS[r].description}</p>
            </li>
          ))}
        </ul>
        <div className="border-t border-line">
          <Table caption="Permissions granted to each role" head={["Permission", ...ROLES.map((r) => ROLE_LABELS[r].name)]}>
            {PERMISSIONS.map((p) => (
              <tr key={p}>
                <th scope="row" className="px-4 py-2 text-left align-top font-mono text-xs font-normal text-ink">
                  {p}
                </th>
                {ROLES.map((r) => (
                  <Td key={r}>
                    {/* Labelled icons rather than sr-only spans: absolutely positioned sr-only text inside the
                        horizontal scroller would escape it and widen the page on small screens. */}
                    {ROLE_PERMISSIONS[r].has(p) ? (
                      <Check role="img" aria-label="Allowed" className="h-4 w-4 text-emerald-700" />
                    ) : (
                      <Minus role="img" aria-label="Not allowed" className="h-4 w-4 text-stone-400" />
                    )}
                  </Td>
                ))}
              </tr>
            ))}
          </Table>
        </div>
      </Card>
    </>
  );
}
