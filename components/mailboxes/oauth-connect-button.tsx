"use client";

/**
 * Connect (or reconnect) a mailbox through the provider's OAuth consent
 * screen. Before redirecting, a dialog lists every permission requested and
 * why, so nothing is granted blind. Nothing is simulated: the button only ever
 * hands the browser to the provider's real authorization URL.
 */
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ExternalLink, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { api } from "@/lib/ui/api";
import { buttonStyles } from "@/components/ui/primitives";
import { ResultMessage } from "@/components/ui/interactive";

type StartResponse = { authorizationUrl: string; scopes: string[]; scopeExplanations: Array<{ scope: string; why: string }> };

function isSafeRedirect(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"));
  } catch {
    return false;
  }
}

export function OAuthConnectButton({
  provider,
  displayName,
  label,
  scopeExplanations,
  reconnectConnectionId,
  loginHint,
  variant = "primary",
  disabled = false,
  disabledReason,
}: {
  provider: "google" | "microsoft";
  displayName: string;
  label: string;
  scopeExplanations: ReadonlyArray<{ scope: string; why: string }>;
  reconnectConnectionId?: string;
  /** Shown in the dialog when reconnecting, so the user picks the same account. */
  loginHint?: string;
  variant?: "primary" | "secondary";
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reconnect = Boolean(reconnectConnectionId);

  async function start() {
    setBusy(true);
    setError(null);
    const r = await api<StartResponse>("/api/v1/mailboxes/oauth/start", { method: "POST", body: { provider, reconnectConnectionId } });
    if (!r.success) {
      setBusy(false);
      setError(r.error);
      return;
    }
    if (!isSafeRedirect(r.data.authorizationUrl)) {
      setBusy(false);
      setError("The provider sign-in address returned by the server was not valid, so you were not redirected.");
      return;
    }
    setRedirecting(true);
    window.location.assign(r.data.authorizationUrl);
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          if (busy || redirecting) return;
          setOpen(next);
          if (!next) setError(null);
        }}
      >
        <Dialog.Trigger asChild>
          <button type="button" className={buttonStyles[variant]} disabled={disabled}>
            <KeyRound aria-hidden className="h-4 w-4" />
            {label}
          </button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-32px)] w-[calc(100vw-32px)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-line bg-panel shadow-xl">
            <div className="overflow-y-auto p-5">
              <Dialog.Title className="text-base font-medium text-ink">
                {reconnect ? "Reconnect" : "Connect"} {displayName}
              </Dialog.Title>
              <Dialog.Description className="mt-2 text-sm text-muted">
                You will be sent to {displayName} to sign in and approve access{loginHint ? ` for ${loginHint}` : ""}. You come back here when you are done.
              </Dialog.Description>

              <ul className="mt-4 space-y-2 text-sm text-ink">
                <li className="flex items-start gap-2">
                  <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-700" />
                  <span>QuikReach never asks for your mailbox password. You sign in on the provider&apos;s own page.</span>
                </li>
                <li className="flex items-start gap-2">
                  <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-700" />
                  <span>QuikReach reads message metadata (headers, labels), not bodies.</span>
                </li>
                <li className="flex items-start gap-2">
                  <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-700" />
                  <span>You can disconnect at any time; stored access tokens are deleted when you do.</span>
                </li>
              </ul>

              <h3 className="mt-5 text-sm font-medium text-ink">Permissions requested</h3>
              {scopeExplanations.length ? (
                <ul className="mt-2 divide-y divide-line rounded-md border border-line">
                  {scopeExplanations.map((s) => (
                    <li key={s.scope} className="px-3 py-2">
                      <code className="break-all font-mono text-xs text-ink">{s.scope}</code>
                      <p className="mt-0.5 text-xs text-muted">{s.why}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-muted">The provider will list the requested permissions on its consent screen.</p>
              )}
              <p className="mt-3 text-xs text-muted">Approve every permission listed. If some are declined, QuikReach marks the affected signals as unavailable rather than guessing.</p>

              {error ? (
                <div className="mt-4">
                  <ResultMessage result={{ ok: false, message: error }} />
                </div>
              ) : null}
              {redirecting ? (
                <p role="status" className="mt-4 text-sm text-muted">
                  Redirecting to {displayName}…
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">
              <Dialog.Close className={buttonStyles.ghost} disabled={busy || redirecting}>
                Cancel
              </Dialog.Close>
              <button type="button" className={buttonStyles.primary} onClick={() => void start()} disabled={busy || redirecting}>
                {busy || redirecting ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <ExternalLink aria-hidden className="h-4 w-4" />}
                Continue to {displayName}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {disabled && disabledReason ? <p className="max-w-md text-xs text-muted">{disabledReason}</p> : null}
    </div>
  );
}
