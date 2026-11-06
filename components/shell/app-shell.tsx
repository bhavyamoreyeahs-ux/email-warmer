"use client";

/**
 * Product chrome: dark navigation rail (QuikIT style), top bar with the
 * workspace switcher and user menu, and a persistent DEMO banner in demo
 * workspaces. Navigation items the role cannot view are omitted; the pages and
 * APIs enforce permissions independently.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { signOut } from "next-auth/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { clsx } from "clsx";
import { Activity, BarChart3, BellRing, ChevronDown, FlaskConical, Globe, Inbox, LayoutDashboard, Map, Menu, PauseCircle, Plug, Settings, Sparkles, X, type LucideIcon } from "lucide-react";
import type { NavItem } from "@/lib/ui/nav";
import { api } from "@/lib/ui/api";

const ICONS: Record<string, LucideIcon> = { LayoutDashboard, Globe, Inbox, Activity, BellRing, Sparkles, BarChart3, Plug, Settings, Map };

export interface ShellProps {
  nav: NavItem[];
  user: { name: string; email: string };
  org: { id: string; name: string; isDemo: boolean; automationPaused: boolean };
  role: string;
  memberships: Array<{ orgId: string; orgName: string; role: string; isDemo: boolean }>;
  children: React.ReactNode;
}

export function AppShell({ nav, user, org, role, memberships, children }: ShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

  async function switchOrg(orgId: string) {
    const r = await api("/api/v1/me/organization", { body: { orgId } });
    if (r.success) {
      router.push("/dashboard");
      router.refresh();
    }
  }

  const navList = (
    <nav aria-label="Main" className="flex flex-col gap-0.5 px-2">
      {nav.map((item) => {
        const Icon = ICONS[item.icon] ?? LayoutDashboard;
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setMobileOpen(false)}
            aria-current={active ? "page" : undefined}
            className={clsx(
              "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
              active ? "bg-white/10 text-white" : "text-white/65 hover:bg-white/5 hover:text-white",
            )}
          >
            <Icon aria-hidden className="h-4 w-4" />
            <span className="flex-1">{item.label}</span>
            {item.badge ? <span className="rounded bg-white/10 px-1.5 text-[10px] uppercase tracking-wider text-white/60">{item.badge}</span> : null}
          </Link>
        );
      })}
    </nav>
  );

  const brand = (
    <div className="flex items-center gap-2 px-5 py-5">
      <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md bg-white text-[13px] font-semibold text-black">Q</span>
      <div>
        <div className="text-sm font-medium tracking-tighter text-white">QuikReach</div>
        <div className="text-[10px] uppercase tracking-[0.2em] text-white/40">QuikIT</div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col bg-rail lg:flex">
        {brand}
        {navList}
        <div className="mt-auto px-5 py-4 text-[11px] leading-relaxed text-white/40">
          QuikReach shows observed signals, estimates and hypotheses — labelled as such. It does not measure inbox placement.
        </div>
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-rail">
            <div className="flex items-center justify-between pr-3">
              {brand}
              <button type="button" aria-label="Close menu" className="rounded p-2 text-white/70 hover:text-white" onClick={() => setMobileOpen(false)}>
                <X className="h-5 w-5" />
              </button>
            </div>
            {navList}
          </aside>
        </div>
      ) : null}

      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-panel/95 px-4 backdrop-blur sm:px-6">
          <button type="button" aria-label="Open menu" className="rounded p-1.5 text-muted hover:text-ink lg:hidden" onClick={() => setMobileOpen(true)}>
            <Menu className="h-5 w-5" />
          </button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm text-ink hover:bg-canvas">
              <span className="truncate font-medium">{org.name}</span>
              <ChevronDown aria-hidden className="h-4 w-4 text-muted" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="start" sideOffset={6} className="z-50 min-w-[260px] rounded-md border border-line bg-panel p-1 shadow-lg">
                <DropdownMenu.Label className="px-2 py-1.5 text-xs text-muted">Workspaces</DropdownMenu.Label>
                {memberships.map((m) => (
                  <DropdownMenu.Item key={m.orgId} onSelect={() => void switchOrg(m.orgId)} className="flex cursor-pointer items-center justify-between gap-3 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-canvas">
                    <span className="truncate">{m.orgName}</span>
                    <span className="text-xs text-muted">{m.orgId === org.id ? "current" : m.role.replace(/_/g, " ")}</span>
                  </DropdownMenu.Item>
                ))}
                <DropdownMenu.Separator className="my-1 h-px bg-line" />
                <DropdownMenu.Item asChild>
                  <Link href="/onboarding" className="block rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-canvas">
                    Create a workspace…
                  </Link>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-xs text-muted sm:inline">{role.replace(/_/g, " ")}</span>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger className="grid h-8 w-8 place-items-center rounded-full bg-ink text-xs font-medium text-white" aria-label="User menu">
                {(user.name || user.email).slice(0, 1).toUpperCase()}
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-[220px] rounded-md border border-line bg-panel p-1 shadow-lg">
                  <div className="px-2 py-1.5">
                    <div className="truncate text-sm text-ink">{user.name || user.email}</div>
                    <div className="truncate text-xs text-muted">{user.email}</div>
                  </div>
                  <DropdownMenu.Separator className="my-1 h-px bg-line" />
                  <DropdownMenu.Item onSelect={() => void signOut({ callbackUrl: "/login" })} className="cursor-pointer rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-canvas">
                    Sign out
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </header>

        {org.isDemo ? (
          <div role="note" className="flex items-center gap-2 border-b border-violet-200 bg-violet-50 px-4 py-2 text-sm text-violet-900 sm:px-6">
            <FlaskConical aria-hidden className="h-4 w-4 flex-shrink-0" />
            <span>
              <strong className="font-medium">Demo workspace — sample data only.</strong> Nothing here comes from a live mailbox or live DNS query, and live data cannot be added to it.
            </span>
          </div>
        ) : null}
        {org.automationPaused ? (
          <div role="note" className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 sm:px-6">
            <PauseCircle aria-hidden className="h-4 w-4 flex-shrink-0" />
            <span>
              <strong className="font-medium">Automation is paused for this workspace.</strong> Syncs, scheduled scans and automated campaign actions are not running; data will become stale.
            </span>
          </div>
        ) : null}

        <main id="main" className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
