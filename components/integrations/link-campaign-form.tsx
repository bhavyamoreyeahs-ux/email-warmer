"use client";

/** Links an external campaign (by its id in the sending system) to a campaign-control integration. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/ui/api";
import { buttonStyles } from "@/components/ui/primitives";
import { ResultMessage } from "@/components/ui/interactive";
import { hintCls, inputCls, labelCls, labelTextCls } from "@/components/settings/fields";

export interface Option {
  value: string;
  label: string;
}

export function LinkCampaignForm({ integrations, mailboxes, domains, disabledReason }: { integrations: Option[]; mailboxes: Option[]; domains: Option[]; disabledReason?: string }) {
  const router = useRouter();
  const [integrationId, setIntegrationId] = useState(integrations[0]?.value ?? "");
  const [externalId, setExternalId] = useState("");
  const [name, setName] = useState("");
  const [mailboxId, setMailboxId] = useState("");
  const [domainId, setDomainId] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const noIntegrations = integrations.length === 0;
  const reason = disabledReason ?? (noIntegrations ? "Create a campaign-control integration first." : undefined);
  const disabled = Boolean(reason);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (disabled) return;
    setBusy(true);
    setResult(null);
    const r = await api("/api/v1/campaigns", {
      method: "POST",
      body: { integrationId, externalId: externalId.trim(), name: name.trim(), mailboxConnectionId: mailboxId || null, domainId: domainId || null },
    });
    setBusy(false);
    if (r.success) {
      setResult({ ok: true, message: `Linked “${name.trim()}”. Its status stays Unknown until the sending system confirms a state.` });
      setExternalId("");
      setName("");
      setMailboxId("");
      setDomainId("");
      router.refresh();
    } else {
      setResult({ ok: false, message: r.error });
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-describedby={reason ? "link-campaign-disabled" : undefined}>
      <fieldset disabled={disabled || busy} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <legend className="sr-only">Link a campaign</legend>
        <label className={labelCls}>
          <span className={labelTextCls}>Campaign-control integration</span>
          <select className={inputCls} value={integrationId} onChange={(e) => setIntegrationId(e.target.value)} required>
            {noIntegrations ? <option value="">No campaign integrations</option> : null}
            {integrations.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          <span className={labelTextCls}>Campaign name</span>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} placeholder="e.g. Q4 onboarding sequence" />
        </label>
        <label className={labelCls}>
          <span className={labelTextCls}>External campaign ID</span>
          <input className={inputCls} value={externalId} onChange={(e) => setExternalId(e.target.value)} required maxLength={200} spellCheck={false} aria-describedby="external-id-hint" />
          <span id="external-id-hint" className={hintCls}>
            The ID the sending system uses. It must echo this ID back to confirm a pause or resume.
          </span>
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:col-span-1">
          <label className={labelCls}>
            <span className={labelTextCls}>Mailbox (optional)</span>
            <select className={inputCls} value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>
              <option value="">None</option>
              {mailboxes.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className={labelCls}>
            <span className={labelTextCls}>Domain (optional)</span>
            <select className={inputCls} value={domainId} onChange={(e) => setDomainId(e.target.value)}>
              <option value="">None</option>
              {domains.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </fieldset>
      <p className="text-xs text-muted">Linking a mailbox or domain lets alert rules with a “pause campaigns” policy target this campaign when that mailbox or domain triggers.</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={buttonStyles.primary} disabled={disabled || busy || !integrationId || !externalId.trim() || !name.trim()}>
          {busy ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}
          Link campaign
        </button>
        <ResultMessage result={result} />
      </div>
      {reason ? (
        <p id="link-campaign-disabled" className="text-sm text-muted">
          {reason}
        </p>
      ) : null}
    </form>
  );
}
