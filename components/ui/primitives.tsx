/**
 * QuikReach presentation kit (server-safe; no hooks).
 *
 * Status is NEVER colour-only: every status pill renders an icon and a text
 * label. Unknown / stale / inconclusive have their own neutral treatments and
 * never borrow the "healthy" green.
 * TODO(integration): upstream to @quikit/ui where shapes match.
 */
import Link from "next/link";
import { clsx } from "clsx";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  CircleHelp,
  Clock,
  Info,
  Lock,
  OctagonX,
  FlaskConical,
  type LucideIcon,
} from "lucide-react";
import type { CheckStatus, ConnectionState, HealthState } from "@/lib/db/schema";
import { CHECK_LABEL, CONNECTION_LABEL, HEALTH_LABEL } from "@/lib/ui/format";

/* ─── Layout ──────────────────────────────────────────────────────────── */

export function PageHeader({ title, lede, meta, actions }: { title: string; lede?: React.ReactNode; meta?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <header className="mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-medium tracking-tighter text-ink sm:text-[28px]">{title}</h1>
          {lede ? <p className="mt-1.5 max-w-3xl text-sm text-muted">{lede}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {meta ? <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted">{meta}</div> : null}
    </header>
  );
}

export function Card({ title, description, actions, children, className, padded = true }: { title?: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children?: React.ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={clsx("min-w-0 rounded-lg border border-line bg-panel", className)}>
      {title || actions ? (
        <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title ? <h2 className="text-sm font-medium text-ink">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={padded ? "p-4" : undefined}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone = "neutral" }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: "neutral" | "good" | "warn" | "bad" | "unknown" }) {
  const toneCls = { neutral: "text-ink", good: "text-emerald-700", warn: "text-amber-700", bad: "text-red-700", unknown: "text-muted" }[tone];
  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-3">
      <div className="text-xs uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className={clsx("mt-1 text-2xl font-medium tracking-tightest", toneCls)}>{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
    </div>
  );
}

export function KeyValue({ items }: { items: Array<[React.ReactNode, React.ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[minmax(140px,max-content)_1fr]">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ─── Buttons & links ─────────────────────────────────────────────────── */

const btnBase = "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";
export const buttonStyles = {
  primary: `${btnBase} bg-accent-600 text-white hover:bg-accent-700`,
  secondary: `${btnBase} border border-line bg-panel text-ink hover:bg-canvas`,
  danger: `${btnBase} border border-red-200 bg-white text-red-700 hover:bg-red-50`,
  ghost: `${btnBase} text-muted hover:bg-canvas hover:text-ink`,
};

export function LinkButton({ href, children, variant = "secondary" }: { href: string; children: React.ReactNode; variant?: keyof typeof buttonStyles }) {
  return (
    <Link href={href} className={buttonStyles[variant]}>
      {children}
    </Link>
  );
}

/* ─── Status ──────────────────────────────────────────────────────────── */

type Tone = "good" | "warn" | "bad" | "unknown" | "stale" | "info" | "demo";
const TONE: Record<Tone, { cls: string; icon: LucideIcon }> = {
  good: { cls: "bg-emerald-50 text-emerald-800 ring-emerald-200", icon: CheckCircle2 },
  warn: { cls: "bg-amber-50 text-amber-800 ring-amber-200", icon: AlertTriangle },
  bad: { cls: "bg-red-50 text-red-800 ring-red-200", icon: OctagonX },
  unknown: { cls: "bg-stone-100 text-stone-700 ring-stone-300", icon: CircleHelp },
  stale: { cls: "bg-slate-100 text-slate-700 ring-slate-300", icon: Clock },
  info: { cls: "bg-sky-50 text-sky-800 ring-sky-200", icon: Info },
  demo: { cls: "bg-violet-50 text-violet-800 ring-violet-200", icon: FlaskConical },
};

export function Pill({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) {
  const { cls, icon: Icon } = TONE[tone];
  return (
    <span title={title} className={clsx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", cls)}>
      <Icon aria-hidden className="h-3.5 w-3.5" />
      {children}
    </span>
  );
}

const healthTone: Record<HealthState, Tone> = { healthy: "good", at_risk: "warn", critical: "bad", unknown: "unknown", stale: "stale" };
export function HealthPill({ state }: { state: HealthState }) {
  return <Pill tone={healthTone[state]}>{HEALTH_LABEL[state]}</Pill>;
}

const checkTone: Record<CheckStatus, Tone> = { pass: "good", warn: "warn", fail: "bad", inconclusive: "unknown" };
export function CheckPill({ status }: { status: CheckStatus }) {
  return <Pill tone={checkTone[status]}>{CHECK_LABEL[status]}</Pill>;
}

const connTone: Record<ConnectionState, Tone> = { connected: "good", degraded: "warn", reauth_required: "bad", pending: "info", disconnected: "unknown", paused: "stale", demo: "demo" };
export function ConnectionPill({ state }: { state: ConnectionState }) {
  return <Pill tone={connTone[state]}>{CONNECTION_LABEL[state]}</Pill>;
}

export function SeverityPill({ severity }: { severity: "info" | "warning" | "critical" }) {
  return <Pill tone={severity === "critical" ? "bad" : severity === "warning" ? "warn" : "info"}>{severity[0]!.toUpperCase() + severity.slice(1)}</Pill>;
}

/* ─── Callouts & states ───────────────────────────────────────────────── */

export function Callout({ tone = "info", title, children }: { tone?: "info" | "warn" | "bad" | "demo" | "unknown"; title?: React.ReactNode; children?: React.ReactNode }) {
  const t = { info: TONE.info, warn: TONE.warn, bad: TONE.bad, demo: TONE.demo, unknown: TONE.unknown }[tone];
  const Icon = t.icon;
  return (
    <div role={tone === "bad" ? "alert" : "note"} className={clsx("flex gap-3 rounded-lg px-4 py-3 text-sm ring-1 ring-inset", t.cls)}>
      <Icon aria-hidden className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <div className="min-w-0">
        {title ? <div className="font-medium">{title}</div> : null}
        {children ? <div className={title ? "mt-0.5" : undefined}>{children}</div> : null}
      </div>
    </div>
  );
}

export function EmptyState({ icon: Icon = CircleDashed, title, children, action }: { icon?: LucideIcon; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <Icon aria-hidden className="h-8 w-8 text-stone-400" />
      <h3 className="mt-3 text-sm font-medium text-ink">{title}</h3>
      {children ? <div className="mt-1 max-w-md text-sm text-muted">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function PermissionDenied({ permission }: { permission: string }) {
  return (
    <Card>
      <EmptyState icon={Lock} title="You don't have access to this page">
        Your role does not include <code className="rounded bg-canvas px-1">{permission}</code>. Ask an Owner or Administrator if you need it.
      </EmptyState>
    </Card>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={clsx("animate-pulse rounded bg-stone-200/70", className)} />;
}

export function Freshness({ at, staleAfterMs, label = "Updated" }: { at: Date | string | null; staleAfterMs: number; label?: string }) {
  if (!at) return <Pill tone="unknown">No data yet</Pill>;
  const t = typeof at === "string" ? new Date(at) : at;
  const stale = Date.now() - t.getTime() > staleAfterMs;
  const ago = Math.round((Date.now() - t.getTime()) / 60_000);
  const text = ago < 60 ? `${ago}m ago` : ago < 1440 ? `${Math.round(ago / 60)}h ago` : `${Math.round(ago / 1440)}d ago`;
  return (
    <Pill tone={stale ? "stale" : "info"} title={t.toISOString()}>
      {stale ? "Stale · " : `${label} `}
      {text}
    </Pill>
  );
}

/* ─── Tables ──────────────────────────────────────────────────────────── */

export function Table({ head, children, caption }: { head: React.ReactNode[]; children: React.ReactNode; caption?: string }) {
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-left text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr className="border-b border-line text-xs uppercase tracking-[0.08em] text-muted">
            {head.map((h, i) => (
              <th key={i} scope="col" className="px-4 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <td className={clsx("px-4 py-2.5 align-top", className)}>{children}</td>;
}
