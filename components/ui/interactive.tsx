"use client";

/**
 * Interactive building blocks: API action buttons with confirmation + reason,
 * an evidence drawer, and inline result messages. Every significant action
 * shows a clear success or error result, and destructive / high-impact ones
 * require confirmation (and a reason when the action is audited with one).
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Loader2 } from "lucide-react";
import { clsx } from "clsx";
import { api } from "@/lib/ui/api";
import { buttonStyles } from "@/components/ui/primitives";

export function ResultMessage({ result }: { result: { ok: boolean; message: string } | null }) {
  if (!result) return null;
  return (
    <p role={result.ok ? "status" : "alert"} className={clsx("text-sm", result.ok ? "text-emerald-700" : "text-red-700")}>
      {result.message}
    </p>
  );
}

export interface ActionButtonProps {
  label: string;
  path: string;
  method?: "POST" | "PUT" | "PATCH" | "DELETE";
  body?: Record<string, unknown>;
  variant?: keyof typeof buttonStyles;
  /** When set, a confirmation dialog is shown first. */
  confirm?: { title: string; description: React.ReactNode; confirmLabel?: string; requireReason?: boolean; reasonLabel?: string; reasonField?: string; extra?: React.ReactNode };
  successMessage?: string | ((data: unknown) => string);
  /** Navigate here on success instead of refreshing. */
  redirectTo?: string;
  disabled?: boolean;
  disabledReason?: string;
  icon?: React.ReactNode;
}

export function ActionButton(props: ActionButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    const body = props.confirm?.requireReason ? { ...(props.body ?? {}), [props.confirm.reasonField ?? "reason"]: reason } : props.body;
    let path = props.path;
    if (props.method === "DELETE" && props.confirm?.requireReason) path += `${path.includes("?") ? "&" : "?"}reason=${encodeURIComponent(reason)}`;
    const r = await api(path, { method: props.method ?? "POST", body: props.method === "DELETE" ? undefined : (body ?? {}) });
    setBusy(false);
    if (r.success) {
      const msg = typeof props.successMessage === "function" ? props.successMessage(r.data) : (props.successMessage ?? "Done.");
      setResult({ ok: true, message: msg });
      setOpen(false);
      setReason("");
      startTransition(() => (props.redirectTo ? router.push(props.redirectTo) : router.refresh()));
    } else {
      setResult({ ok: false, message: r.error });
    }
  }

  const button = (
    <button
      type="button"
      className={buttonStyles[props.variant ?? "secondary"]}
      disabled={props.disabled || busy || pending}
      title={props.disabled ? props.disabledReason : undefined}
      onClick={() => (props.confirm ? setOpen(true) : void run())}
    >
      {busy || pending ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : props.icon}
      {props.label}
    </button>
  );

  return (
    <div className="inline-flex flex-col items-start gap-1">
      {props.confirm ? (
        <Dialog.Root open={open} onOpenChange={setOpen}>
          {button}
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-panel p-5 shadow-xl">
              <Dialog.Title className="text-base font-medium text-ink">{props.confirm.title}</Dialog.Title>
              <Dialog.Description asChild>
                <div className="mt-2 text-sm text-muted">{props.confirm.description}</div>
              </Dialog.Description>
              {props.confirm.extra}
              {props.confirm.requireReason ? (
                <label className="mt-4 block text-sm">
                  <span className="text-ink">{props.confirm.reasonLabel ?? "Reason (recorded in the audit log)"}</span>
                  <textarea
                    className="mt-1 w-full rounded-md border border-line px-3 py-2 text-sm"
                    rows={3}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    minLength={3}
                    maxLength={500}
                  />
                </label>
              ) : null}
              {result && !result.ok ? <div className="mt-3"><ResultMessage result={result} /></div> : null}
              <div className="mt-5 flex justify-end gap-2">
                <Dialog.Close className={buttonStyles.ghost}>Cancel</Dialog.Close>
                <button
                  type="button"
                  className={props.variant === "danger" ? buttonStyles.danger : buttonStyles.primary}
                  disabled={busy || (props.confirm.requireReason && reason.trim().length < 3)}
                  onClick={() => void run()}
                >
                  {busy ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}
                  {props.confirm.confirmLabel ?? "Confirm"}
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : (
        button
      )}
      {!open ? <ResultMessage result={result} /> : null}
    </div>
  );
}

/** Side drawer used to show the raw evidence behind a check, event or statement. */
export function EvidenceDrawer({ trigger, title, children }: { trigger: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-line bg-panel shadow-xl">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <Dialog.Title className="text-sm font-medium text-ink">{title}</Dialog.Title>
            <Dialog.Close className={buttonStyles.ghost} aria-label="Close evidence">
              <X aria-hidden className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">Evidence details</Dialog.Description>
          <div className="flex-1 overflow-y-auto px-5 py-4 text-sm">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
