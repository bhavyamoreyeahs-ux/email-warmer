import { redirect } from "next/navigation";
import { AuthFrame } from "@/components/auth/auth-frame";
import { OnboardingForm } from "@/components/auth/onboarding-form";
import { resolvePrincipal } from "@/lib/api/principal";

export const dynamic = "force-dynamic";
export const metadata = { title: "Create a workspace" };

export default async function OnboardingPage() {
  const who = await resolvePrincipal();
  if (who.status === "unauthenticated") redirect("/login");
  return (
    <AuthFrame
      title="Create a workspace"
      lede={who.status === "no_membership" ? "You're signed in but not a member of any workspace yet. Create one, or ask a colleague to invite you." : "Create an additional workspace. You'll be its owner."}
    >
      <OnboardingForm />
    </AuthFrame>
  );
}
