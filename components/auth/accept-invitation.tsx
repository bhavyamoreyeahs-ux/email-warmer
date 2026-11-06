"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/ui/api";
import { buttonStyles } from "@/components/ui/primitives";
import { inputCls } from "@/components/auth/auth-frame";

export function AcceptInvitation({ token, email, signedInAs, accountExists }: { token: string; email: string; signedInAs: string | null; accountExists: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await api<{ orgName: string; signedIn: boolean }>("/api/invitations/accept", { body: signedInAs ? { token } : { token, name, password } });
    if (!r.success) {
      setBusy(false);
      setError(r.error);
      return;
    }
    if (!r.data.signedIn) await signIn("credentials", { email, password, redirect: false });
    setBusy(false);
    router.push("/dashboard");
    router.refresh();
  }

  if (signedInAs && signedInAs.toLowerCase() !== email.toLowerCase()) {
    return <p className="text-sm text-red-700">You are signed in as {signedInAs}, but this invitation is for {email}. Sign out and open the link again.</p>;
  }
  if (!signedInAs && accountExists) {
    return (
      <p className="text-sm text-muted">
        An account already exists for {email}.{" "}
        <a className="text-accent-600 hover:underline" href={`/login?callbackUrl=${encodeURIComponent(`/invitations/accept?token=${token}`)}`}>
          Sign in
        </a>{" "}
        and you&apos;ll return here to accept.
      </p>
    );
  }
  return (
    <form onSubmit={accept} className="space-y-4">
      {!signedInAs ? (
        <>
          <label className="block text-sm">
            <span className="text-ink">Your name</span>
            <input required className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="text-ink">Choose a password</span>
            <input type="password" required minLength={12} autoComplete="new-password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} />
            <span className="mt-1 block text-xs text-muted">At least 12 characters, with letters and numbers. This is for QuikReach only — never your mailbox password.</span>
          </label>
        </>
      ) : null}
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      <button type="submit" disabled={busy} className={`${buttonStyles.primary} w-full py-2`}>
        {busy ? "Accepting…" : "Accept invitation"}
      </button>
    </form>
  );
}
