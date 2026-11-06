"use client";

/**
 * Creates a campaign-control or notification webhook. The signing secret is
 * returned by the API exactly once; it is shown here until dismissed and is
 * never retrievable again.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/ui/api";
import { buttonStyles, Callout } from "@/components/ui/primitives";
import { ResultMessage } from "@/components/ui/interactive";
import { CopyField } from "@/components/integrations/copy-field";
import { hintCls, inputCls, labelCls, labelTextCls } from "@/components/settings/fields";

type Kind = "campaign_webhook" | "notification_webhook";

interface Created {
  name: string;
  kind: Kind;
  secret: string;
}

export function CreateIntegrationForm({ disabledReason }: { disabledReason?: string }) {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>("campaign_webhook");
  const [name, setName] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ ok: boolean; message: string } | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const disabled = Boolean(disabledReason);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (disabled) return;
    if (!endpointUrl.trim().toLowerCase().startsWith("https://")) {
      setError({ ok: false, message: "The endpoint URL must start with https://." });
      return;
    }
    setBusy(true);
    setError(null);
    const r = await api<{ integration: { id: string; name: string }; signingSecret: string }>("/api/v1/integrations", {
      method: "POST",
      body: { kind, name: name.trim(), endpointUrl: endpointUrl.trim() },
    });
    setBusy(false);
    if (r.success) {
      setCreated({ name: r.data.integration.name, kind, secret: r.data.signingSecret });
      setName("");
      setEndpointUrl("");
      router.refresh();
    } else {
      setError({ ok: false, message: r.error });
    }
  }

  return (
    <div className="space-y-4">
      {created ? (
        <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/40 p-4">
          <Callout tone="warn" title={`Integration “${created.name}” created — copy the signing secret now`}>
            This secret will not be shown again. QuikReach stores it encrypted and cannot display it later; if you lose it, revoke this integration and create a new one.
          </Callout>
          <CopyField label="Signing secret (shown once)" value={created.secret} />
          <div className="text-xs text-muted">
            <p>
              Verify the <code className="rounded bg-canvas px-1">X-QuikReach-Signature</code> header on every request. Format:{" "}
              <code className="rounded bg-canvas px-1">{"t=<unix>,v1=<hex hmac-sha256 of \"t.body\">"}</code> — compute HMAC-SHA256 with this secret over the timestamp, a dot and the raw request body, compare in constant time, and reject timestamps older than 5 minutes.
            </p>
            <p className="mt-1">
              Next: click <strong>Test</strong> on the new integration. {created.kind === "campaign_webhook" ? "A campaign integration becomes Active only after your endpoint replies " : "Your endpoint should reply "}
              <code className="rounded bg-canvas px-1">{'{"ok": true}'}</code> to the ping.
            </p>
          </div>
          <button type="button" className={buttonStyles.secondary} onClick={() => setCreated(null)}>
            I have stored the secret
          </button>
        </div>
      ) : null}

      <form onSubmit={submit} className="space-y-3" aria-describedby={disabled ? "create-integration-disabled" : undefined}>
        <fieldset disabled={disabled || busy} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <legend className="sr-only">New webhook integration</legend>
          <label className={labelCls}>
            <span className={labelTextCls}>Kind</span>
            <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value === "notification_webhook" ? "notification_webhook" : "campaign_webhook")}>
              <option value="campaign_webhook">Campaign control (pause / resume requests)</option>
              <option value="notification_webhook">Notifications (alert messages)</option>
            </select>
          </label>
          <label className={labelCls}>
            <span className={labelTextCls}>Name</span>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} placeholder="e.g. Sending platform (production)" />
          </label>
          <label className={`${labelCls} sm:col-span-2`}>
            <span className={labelTextCls}>Endpoint URL</span>
            <input
              className={inputCls}
              type="url"
              inputMode="url"
              value={endpointUrl}
              onChange={(e) => setEndpointUrl(e.target.value)}
              required
              maxLength={2000}
              pattern="https://.*"
              placeholder="https://example.com/quikreach/webhook"
              aria-describedby="endpoint-hint"
            />
            <span id="endpoint-hint" className={hintCls}>
              Must use https://. Private, loopback and reserved network addresses are rejected. Redirects are not followed.
            </span>
          </label>
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={buttonStyles.primary} disabled={disabled || busy || name.trim().length < 2 || !endpointUrl.trim()}>
            {busy ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}
            Create integration
          </button>
          <ResultMessage result={error} />
        </div>
        {disabledReason ? (
          <p id="create-integration-disabled" className="text-sm text-muted">
            {disabledReason}
          </p>
        ) : null}
      </form>
    </div>
  );
}
