"use client";

/**
 * "Check now" for domain ownership: one bounded TXT lookup run inline by the
 * API. A record that is not found (or a lookup that did not complete) is a
 * result, not a request failure, so it is shown as such with the API's detail.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, CircleHelp, Loader2, SearchCheck } from "lucide-react";
import { api } from "@/lib/ui/api";
import { buttonStyles } from "@/components/ui/primitives";
import { ResultMessage } from "@/components/ui/interactive";

type VerifyResponse = { verified: boolean; detail: string; verificationStatus: string };

export function VerifyButton({ domainId, disabled = false, disabledReason }: { domainId: string; disabled?: boolean; disabledReason?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<VerifyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setOutcome(null);
    setError(null);
    const r = await api<VerifyResponse>(`/api/v1/domains/${domainId}/verify`, { method: "POST", body: {} });
    setBusy(false);
    if (r.success) {
      setOutcome(r.data);
      startTransition(() => router.refresh());
    } else {
      setError(r.error);
    }
  }

  const working = busy || pending;

  return (
    <div className="space-y-2">
      <button type="button" className={buttonStyles.primary} onClick={() => void run()} disabled={disabled || working}>
        {working ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <SearchCheck aria-hidden className="h-4 w-4" />}
        Check now
      </button>
      {disabled && disabledReason ? <p className="text-xs text-muted">{disabledReason}</p> : null}
      {outcome ? (
        <p role="status" className={`flex items-start gap-1.5 text-sm ${outcome.verified ? "text-emerald-700" : "text-amber-800"}`}>
          {outcome.verified ? <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 flex-shrink-0" /> : <CircleHelp aria-hidden className="mt-0.5 h-4 w-4 flex-shrink-0" />}
          <span>
            <span className="font-medium">{outcome.verified ? "Verified. " : "Not verified yet. "}</span>
            {outcome.detail}
          </span>
        </p>
      ) : null}
      <ResultMessage result={error ? { ok: false, message: error } : null} />
    </div>
  );
}
