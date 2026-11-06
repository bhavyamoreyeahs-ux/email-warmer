import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { AuthFrame } from "@/components/auth/auth-frame";
import { LoginForm } from "@/components/auth/login-form";
import { resolvePrincipal } from "@/lib/api/principal";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  const who = await resolvePrincipal();
  if (who.status === "ok") redirect("/dashboard");
  const e = env();
  return (
    <AuthFrame title="Sign in to QuikReach" lede={e.authMode === "quikit_sso" ? "Use your QuikIT account." : undefined}>
      <Suspense>
        <LoginForm mode={e.authMode} />
      </Suspense>
      {e.authMode === "credentials" && e.selfSignupAllowed ? (
        <p className="mt-6 text-sm text-muted">
          New to QuikReach?{" "}
          <Link href="/signup" className="text-accent-600 underline-offset-2 hover:underline">
            Create a workspace
          </Link>
        </p>
      ) : null}
    </AuthFrame>
  );
}
