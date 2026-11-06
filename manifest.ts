/**
 * QuikIT app manifest (QuikIT platform contract). Static; read by the QuikIT
 * launcher at build time when QuikReach joins the monorepo. Permission strings
 * must be coordinated with the QuikIT integration owner before integration —
 * left empty here on purpose (the app's own RBAC lives in lib/rbac.ts).
 */
export interface AppManifest {
  appId: string;
  name: string;
  description: string;
  routePrefix: string;
  icon: string;
  permissions: string[];
  navigation: { label: string; href: string; icon: string }[];
}

const manifest: AppManifest = {
  appId: "quikreach",
  name: "QuikReach",
  description: "Email-domain health, mailbox monitoring, deliverability diagnostics and campaign safety",
  routePrefix: "/reach",
  icon: "MailCheck",
  permissions: [],
  navigation: [
    { label: "Dashboard", href: "/dashboard", icon: "LayoutDashboard" },
    { label: "Domains", href: "/domains", icon: "Globe" },
    { label: "Mailboxes", href: "/mailboxes", icon: "Inbox" },
    { label: "Events", href: "/events", icon: "Activity" },
    { label: "Alerts & Rules", href: "/alerts", icon: "BellRing" },
    { label: "AI Copilot", href: "/copilot", icon: "Sparkles" },
    { label: "Reports & Usage", href: "/reports", icon: "BarChart3" },
    { label: "Integrations", href: "/integrations", icon: "Plug" },
    { label: "Settings & Audit", href: "/settings", icon: "Settings" },
  ],
};

export default manifest;
