"use client";

/** Sub-navigation shared by every Settings page. Links the role cannot view are omitted (pages re-check). */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";
import { can, type Permission } from "@/lib/rbac";
import type { Role } from "@/lib/db/schema";

const LINKS: ReadonlyArray<{ href: string; label: string; permission: Permission }> = [
  { href: "/settings", label: "General", permission: "organization:view" },
  { href: "/settings/members", label: "Members", permission: "member:view" },
  { href: "/settings/audit", label: "Audit log", permission: "audit:view" },
  { href: "/settings/jobs", label: "Jobs", permission: "job:view" },
];

export function SettingsNav({ role }: { role: Role }) {
  const pathname = usePathname();
  const links = LINKS.filter((l) => can(role, l.permission));
  return (
    <nav aria-label="Settings sections" className="mb-6 overflow-x-auto border-b border-line">
      <ul className="flex min-w-max gap-1">
        {links.map((l) => {
          const active = l.href === "/settings" ? pathname === "/settings" : pathname === l.href || pathname.startsWith(`${l.href}/`);
          return (
            <li key={l.href}>
              <Link
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={clsx(
                  "-mb-px inline-block border-b-2 px-3 py-2 text-sm transition-colors",
                  active ? "border-accent-600 font-medium text-ink" : "border-transparent text-muted hover:text-ink",
                )}
              >
                {l.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
