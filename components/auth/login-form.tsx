"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { buttonStyles } from "@/components/ui/primitives";
import { inputCls } from "@/components/auth/auth-frame";

export function LoginForm({ mode }: { mode: "credentials" | "quikit_sso" }) {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(params.get("error") ? "Sign-in failed. Check your details and try again." : null);
  const callbackUrl = params.get("callbackUrl")?.startsWith("/") ? params.get("callbackUrl")! : "/dashboard";

  if (mode === "quikit_sso") {
    return (
      <button type="button" className={`${buttonStyles.primary} w-full py-2`} onClick={() => void signIn("quikit", { callbackUrl })}>
        Continue with QuikIT
      </button>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await signIn("credentials", { email, password, redirect: false });
    setBusy(false);
    if (r?.ok) {
      router.push(callbackUrl);
      router.refresh();
    } else {
      setError("Email or password is incorrect, the account is disabled, or too many attempts were made. Try again later.");
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <label className="block text-sm">
        <span className="text-ink">Work email</span>
        <input type="email" autoComplete="email" required className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="block text-sm">
        <span className="text-ink">Password</span>
        <input type="password" autoComplete="current-password" required className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={busy || !email || !password} className={`${buttonStyles.primary} w-full py-2`}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      <p className="text-xs text-muted">This is your QuikReach account. QuikReach never asks for your Google or Microsoft mailbox password.</p>
    </form>
  );
}
