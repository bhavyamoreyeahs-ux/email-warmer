"use client";

/** Add a sending domain. On success, opens the domain page with its verification steps. */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { api } from "@/lib/ui/api";
import { buttonStyles } from "@/components/ui/primitives";
import { ResultMessage } from "@/components/ui/interactive";

export function AddDomainForm({ disabled = false, disabledReason }: { disabled?: boolean; disabledReason?: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = name.trim();
    if (value.length < 3) {
      setResult({ ok: false, message: "Enter the domain you send from, for example example.com." });
      return;
    }
    setBusy(true);
    setResult(null);
    const r = await api<{ id: string; name: string }>("/api/v1/domains", { method: "POST", body: { name: value } });
    setBusy(false);
    if (r.success) {
      setName("");
      setResult({ ok: true, message: `Added ${r.data.name}. A first DNS scan is queued — opening the verification steps…` });
      startTransition(() => router.push(`/domains/${r.data.id}`));
    } else {
      setResult({ ok: false, message: r.error });
    }
  }

  const working = busy || pending;

  return (
    <form onSubmit={(e) => void onSubmit(e)} noValidate className="space-y-2">
      <label htmlFor="add-domain-name" className="block text-sm text-ink">
        Domain name
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id="add-domain-name"
          name="name"
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="example.com"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={disabled || working}
          aria-describedby="add-domain-help"
          maxLength={300}
          className="min-w-0 flex-1 rounded-md border border-line bg-panel px-3 py-1.5 text-sm text-ink placeholder:text-stone-400 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <button type="submit" className={buttonStyles.primary} disabled={disabled || working}>
          {working ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Plus aria-hidden className="h-4 w-4" />}
          Add domain
        </button>
      </div>
      <p id="add-domain-help" className="text-xs text-muted">
        {disabled && disabledReason
          ? disabledReason
          : "The domain you send email from. You will publish one DNS TXT record to prove ownership — QuikReach only reads DNS and never edits it."}
      </p>
      <ResultMessage result={result} />
    </form>
  );
}
