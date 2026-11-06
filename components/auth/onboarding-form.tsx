"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/ui/api";
import { buttonStyles } from "@/components/ui/primitives";
import { inputCls } from "@/components/auth/auth-frame";

export function OnboardingForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await api("/api/v1/organizations", { body: { name } });
    setBusy(false);
    if (r.success) {
      router.push("/dashboard");
      router.refresh();
    } else setError(r.error);
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block text-sm">
        <span className="text-ink">Workspace name</span>
        <input required minLength={2} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      <button type="submit" disabled={busy || name.trim().length < 2} className={`${buttonStyles.primary} w-full py-2`}>
        {busy ? "Creating…" : "Create workspace"}
      </button>
    </form>
  );
}
