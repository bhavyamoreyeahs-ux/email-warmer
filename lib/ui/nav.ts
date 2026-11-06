import type { Permission } from "@/lib/rbac";

export interface NavItem {
  label: string;
  href: string;
  icon: string;
  permission?: Permission;
  badge?: string;
}

export const NAV: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: "LayoutDashboard" },
  { label: "Domains", href: "/domains", icon: "Globe", permission: "domain:view" },
  { label: "Mailboxes", href: "/mailboxes", icon: "Inbox", permission: "mailbox:view" },
  { label: "Events", href: "/events", icon: "Activity", permission: "event:view" },
  { label: "Alerts & Rules", href: "/alerts", icon: "BellRing", permission: "alert:view" },
  { label: "AI Copilot", href: "/copilot", icon: "Sparkles", permission: "diagnostic:view" },
  { label: "Reports & Usage", href: "/reports", icon: "BarChart3", permission: "report:view" },
  { label: "Integrations", href: "/integrations", icon: "Plug", permission: "integration:view" },
  { label: "Settings & Audit", href: "/settings", icon: "Settings", permission: "organization:view" },
  { label: "Roadmap", href: "/roadmap", icon: "Map", badge: "Later" },
];
