import { redirect } from "next/navigation";
import { resolvePrincipal } from "@/lib/api/principal";

export const dynamic = "force-dynamic";

export default async function Home() {
  const r = await resolvePrincipal();
  redirect(r.status === "ok" ? "/dashboard" : r.status === "no_membership" ? "/onboarding" : "/login");
}
