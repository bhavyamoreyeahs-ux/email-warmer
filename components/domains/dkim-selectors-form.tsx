"use client";

/**
 * Edit the DKIM selectors QuikReach looks up. Selectors are not discoverable
 * from DNS, so the customer supplies them from a sent message's
 * DKIM-Signature header (the `s=` tag). Saving suggests a re-check so the DKIM
 * result reflects the new list.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Save } from "lucide-react";
import { api } from "@/lib/ui/api";
import { buttonStyles } from "@/components/ui/primitives";
import { ResultMessage } from "@/components/ui/interactive";
import { ScanButton } from "@/components/domains/scan-button";

const SELECTOR_RE = /^[a-z0-9._-]{1,63}$/;
const MAX_SELECTORS = 10;

function parseSelectors(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,;]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export function DkimSelectorsForm({
  domainId,
  initial,
  disabled = false,
  disabledReason,
  canRecheck,
  recheckDisabledReason,
}: {
  domainId: string;
  initial: string[];
  disabled?: boolean;
  disabledReason?: string;
  canRecheck: boolean;
  recheckDisabledReason?: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initial.join(", "));
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saved, setSaved] = useState(false);

  const selectors = parseSelectors(value);
  const invalid = selectors.filter((s) => !SELECTOR_RE.test(s));
  const tooMany = selectors.length > MAX_SELECTORS;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (invalid.length) {
      setResult({ ok: false, message: `Not a valid selector: ${invalid.join(", ")}. Use letters, digits, dot, underscore and hyphen only.` });
      return;
    }
    if (tooMany) {
      setResult({ ok: false, message: `At most ${MAX_SELECTORS} selectors.` });
      return;
    }
    setBusy(true);
    setResult(null);
    setSaved(false);
    const r = await api<{ dkimSelectors: string[] }>(`/api/v1/domains/${domainId}`, { method: "PATCH", body: { dkimSelectors: selectors } });
    setBusy(false);
    if (r.success) {
      const n = r.data.dkimSelectors.length;
      setValue(r.data.dkimSelectors.join(", "));
      setSaved(true);
      setResult({
        ok: true,
        message:
          n === 0
            ? "Saved. No selectors are configured, so the DKIM check can only try common selectors and may be inconclusive."
            : `Saved ${n} selector${n === 1 ? "" : "s"}. The current DKIM result was computed before this change — run a re-check to use them.`,
      });
      startTransition(() => router.refresh());
    } else {
      setResult({ ok: false, message: r.error });
    }
  }

  const working = busy || pending;

  return (
    <div className="space-y-3">
      <form onSubmit={(e) => void onSubmit(e)} noValidate className="space-y-2">
        <label htmlFor="dkim-selectors" className="block text-sm text-ink">
          Selectors (comma or space separated)
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="dkim-selectors"
            type="text"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="google, selector1, selector2"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setSaved(false);
            }}
            disabled={disabled || working}
            aria-describedby="dkim-selectors-help"
            aria-invalid={invalid.length > 0 || tooMany}
            className="min-w-0 flex-1 rounded-md border border-line bg-panel px-3 py-1.5 font-mono text-sm text-ink placeholder:text-stone-400 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <button type="submit" className={buttonStyles.secondary} disabled={disabled || working}>
            {working ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Save aria-hidden className="h-4 w-4" />}
            Save selectors
          </button>
        </div>
        <p id="dkim-selectors-help" className="text-xs text-muted">
          {disabled && disabledReason ? (
            disabledReason
          ) : (
            <>
              {selectors.length} of {MAX_SELECTORS} selectors.{" "}
              {invalid.length ? <span className="text-red-700">Invalid: {invalid.join(", ")}.</span> : null}
              {tooMany ? <span className="text-red-700"> Too many selectors.</span> : null}
            </>
          )}
        </p>
        <ResultMessage result={result} />
      </form>
      {saved ? (
        <div className="flex flex-wrap items-start gap-2">
          <ScanButton
            domainId={domainId}
            trigger="recheck"
            label="Re-check now"
            variant="primary"
            disabled={!canRecheck}
            disabledReason={recheckDisabledReason}
          />
          {!canRecheck && recheckDisabledReason ? <p className="text-xs text-muted">{recheckDisabledReason}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
