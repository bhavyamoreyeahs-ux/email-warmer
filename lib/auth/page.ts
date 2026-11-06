/**
 * Server-component guard. Redirects unauthenticated users to /login and users
 * without a membership to /onboarding. Returns whether the role has the
 * permission so a page can render a permission-denied state instead of data.
 * (APIs enforce the same permissions independently.)
 */
import { redirect } from "next/navigation";
import { resolvePrincipal, type Principal } from "@/lib/api/principal";
import { can, type Permission } from "@/lib/rbac";

export async function requirePage(permission?: Permission): Promise<{ principal: Principal; allowed: boolean }> {
  const r = await resolvePrincipal();
  if (r.status === "unauthenticated") redirect("/login");
  if (r.status === "no_membership") redirect("/onboarding");
  return { principal: r.principal, allowed: permission ? can(r.principal.role, permission) : true };
}
