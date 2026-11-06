import { requirePage } from "@/lib/auth/page";
import { AppShell } from "@/components/shell/app-shell";
import { NAV } from "@/lib/ui/nav";
import { can } from "@/lib/rbac";

// Session and membership are resolved per request — never prerender.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { principal } = await requirePage();
  const nav = NAV.filter((n) => !n.permission || can(principal.role, n.permission));
  return (
    <AppShell
      nav={nav}
      user={{ name: principal.name, email: principal.email }}
      org={{ id: principal.orgId, name: principal.orgName, isDemo: principal.isDemoOrg, automationPaused: principal.automationPaused }}
      role={principal.role}
      memberships={principal.memberships}
    >
      {children}
    </AppShell>
  );
}
