"use client";

/**
 * Disconnect a mailbox: confirm + audited reason + an explicit opt-in to also
 * delete the mailbox's stored events. Reports what actually happened
 * (provider revocation is best effort; local token deletion always happens).
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { Loader2, Unplug } from "lucide-react";
import { api } from "@/lib/ui/api";
import { buttonStyles } from "@/components/ui/primitives";
import { ResultMessage } from "@/components/ui/interactive";

type DisconnectResponse = { revocation: { revoked: boolean; detail: string }; deletedEvents: number };

export function DisconnectButton({ connectionId, emailAddress, disabled = false, disabledReason }: { connectionId: string; emailAddress: string; disabled?: boolean; disabledReason?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [deleteEvents, setDeleteEvents] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    const r = await api<DisconnectResponse>(`/api/v1/mailboxes/${connectionId}/disconnect`, { method: "POST", body: { reason: reason.trim(), deleteEvents } });
    setBusy(false);
    if (!r.success) {
      setError(r.error);
      return;
    }
    const { revocation, deletedEvents } = r.data;
    const parts = [
      "Disconnected. Stored access tokens were deleted and monitoring has stopped.",
      revocation.revoked ? "The provider confirmed access was revoked." : `Provider-side revocation was not confirmed: ${revocation.detail} You can also remove QuikReach from the account's security settings.`,
      deleteEvents ? `${deletedEvents} stored event${deletedEvents === 1 ? " was" : "s were"} deleted.` : "Stored events are kept until your retention period ends.",
    ];
    setResult({ ok: true, message: parts.join(" ") });
    setOpen(false);
    setReason("");
    setDeleteEvents(false);
    startTransition(() => router.refresh());
  }

  const reasonValid = reason.trim().length >= 3;

  return (
    <div className="flex flex-col items-start gap-1.5">
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          if (busy) return;
          setOpen(next);
          if (!next) setError(null);
        }}
      >
        <Dialog.Trigger asChild>
          <button type="button" className={buttonStyles.danger} disabled={disabled || busy || pending}>
            {pending ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Unplug aria-hidden className="h-4 w-4" />}
            Disconnect mailbox
          </button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-32px)] w-[calc(100vw-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-line bg-panel p-5 shadow-xl">
            <Dialog.Title className="text-base font-medium text-ink">Disconnect {emailAddress}?</Dialog.Title>
            <Dialog.Description asChild>
              <div className="mt-2 space-y-2 text-sm text-muted">
                <p>QuikReach will ask the provider to revoke its access (best effort), delete the stored access tokens, and stop monitoring this mailbox.</p>
                <p>Alerts and health for this mailbox stop updating. To monitor it again you will need to reconnect through the provider.</p>
              </div>
            </Dialog.Description>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (reasonValid && !busy) void run();
              }}
            >
              <label className="mt-4 block text-sm">
                <span className="text-ink">Reason (recorded in the audit log)</span>
                <textarea
                  className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink"
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  minLength={3}
                  maxLength={500}
                  required
                  aria-describedby="disconnect-reason-help"
                />
                <span id="disconnect-reason-help" className="text-xs text-muted">
                  At least 3 characters.
                </span>
              </label>
              <div className="mt-4 flex items-start gap-2 rounded-md border border-line p-3">
                <input
                  id={`delete-events-${connectionId}`}
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 flex-shrink-0"
                  checked={deleteEvents}
                  onChange={(e) => setDeleteEvents(e.target.checked)}
                  aria-describedby={`delete-events-help-${connectionId}`}
                />
                <div>
                  <label htmlFor={`delete-events-${connectionId}`} className="text-sm text-ink">
                    Also delete this mailbox&apos;s stored events
                  </label>
                  <p id={`delete-events-help-${connectionId}`} className="mt-0.5 text-xs text-muted">
                    Permanently removes its bounce, reply and other events from QuikReach, including from reports. This cannot be undone. If unchecked, events are kept until your retention period ends.
                  </p>
                </div>
              </div>
              {error ? (
                <div className="mt-3">
                  <ResultMessage result={{ ok: false, message: error }} />
                </div>
              ) : null}
              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <Dialog.Close type="button" className={buttonStyles.ghost} disabled={busy}>
                  Cancel
                </Dialog.Close>
                <button type="submit" className={buttonStyles.danger} disabled={busy || !reasonValid}>
                  {busy ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}
                  {deleteEvents ? "Disconnect and delete events" : "Disconnect"}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {disabled && disabledReason ? <p className="max-w-md text-xs text-muted">{disabledReason}</p> : null}
      {!open ? <ResultMessage result={result} /> : null}
    </div>
  );
}
