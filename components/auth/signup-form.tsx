"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/ui/api";
import { buttonStyles } from "@/components/ui/primitives";
import { inputCls } from "@/components/auth/auth-frame";

export function SignupForm() {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", email: "", password: "", orgName: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await api("/api/auth/signup", { body: form });
    if (!r.success) {
      setBusy(false);
      setError(r.error);
      return;
    }
    const s = await signIn("credentials", { email: form.email, password: form.password, redirect: false });
    setBusy(false);
    if (s?.ok) {
      router.push("/dashboard");
      router.refresh();
    } else router.push("/login");
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block text-sm">
        <span className="text-ink">Your name</span>
        <input required autoComplete="name" className={inputCls} value={form.name} onChange={set("name")} />
      </label>
      <label className="block text-sm">
        <span className="text-ink">Work email</span>
        <input type="email" required autoComplete="email" className={inputCls} value={form.email} onChange={set("email")} />
      </label>
      <label className="block text-sm">
        <span className="text-ink">Password</span>
        <input type="password" required minLength={12} autoComplete="new-password" className={inputCls} value={form.password} onChange={set("password")} aria-describedby="pw-help" />
        <span id="pw-help" className="mt-1 block text-xs text-muted">
          At least 12 characters, with letters and numbers.
        </span>
      </label>
      <label className="block text-sm">
        <span className="text-ink">Workspace name</span>
        <input required className={inputCls} value={form.orgName} onChange={set("orgName")} placeholder="e.g. Acme Outbound" />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={busy} className={`${buttonStyles.primary} w-full py-2`}>
        {busy ? "Creating…" : "Create workspace"}
      </button>
    </form>
  );
}
