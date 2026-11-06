"use client";

/**
 * Sends a signed `ping` to an integration endpoint. The API call can succeed
 * while the TEST fails (endpoint unreachable or did not reply {"ok": true}),
 * so the result message reflects the test outcome, not just the HTTP call.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send } from "lucide-react";
import { api } from "@/lib/ui/api";
import { buttonStyles } from "@/components/ui/primitives";
import { ResultMessage } from "@/components/ui/interactive";

export function TestIntegrationButton({ integrationId, name }: { integrationId: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    const r = await api<{ success: boolean; outcome: string }>(`/api/v1/integrations/${integrationId}/test`, { method: "POST", body: {} });
    setBusy(false);
    if (r.success) {
      setResult({ ok: r.data.success, message: r.data.success ? `Test passed — ${r.data.outcome}` : `Test failed — ${r.data.outcome}` });
      startTransition(() => router.refresh());
    } else {
      setResult({ ok: false, message: r.error });
    }
  }

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button type="button" className={buttonStyles.secondary} disabled={busy || pending} onClick={() => void run()} aria-label={`Send a signed test ping to ${name}`}>
        {busy || pending ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Send aria-hidden className="h-4 w-4" />}
        Test
      </button>
      <div className="max-w-xs">
        <ResultMessage result={result} />
      </div>
    </div>
  );
}
