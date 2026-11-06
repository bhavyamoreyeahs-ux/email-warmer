import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthFrame } from "@/components/auth/auth-frame";
import { SignupForm } from "@/components/auth/signup-form";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const metadata = { title: "Create a workspace" };

export default function SignupPage() {
  const e = env();
  if (e.authMode !== "credentials" || !e.selfSignupAllowed) redirect("/login");
  return (
    <AuthFrame title="Create a workspace" lede="You'll be the workspace owner. You can invite your team afterwards.">
      <SignupForm />
      <p className="mt-6 text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="text-accent-600 hover:underline">
          Sign in
        </Link>
      </p>
    </AuthFrame>
  );
}
