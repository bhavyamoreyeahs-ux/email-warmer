"use client";

/**
 * Alert-rule builder: create, edit (or view read-only), dry-run test, save and delete.
 *
 * Rates are entered as percentages and sent to the API as fractions. All
 * props are plain data (no functions) so server pages can render this.
 * Validation is enforced by the API (alertRuleInput); the client checks only
 * what it needs to build a well-formed request and maps API issues to fields.
 */
import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FlaskConical, Loader2, Save, Trash2 } from "lucide-react";
import { clsx } from "clsx";
import { api } from "@/lib/ui/api";
import { pct } from "@/lib/ui/format";
import { Callout, Card, Pill, Table, Td, buttonStyles } from "@/components/ui/primitives";
import { ActionButton, ResultMessage } from "@/components/ui/interactive";
import type { AlertRuleInput } from "@/lib/alerts/schemas";
import type { TargetEvaluation } from "@/lib/alerts/evaluate";
import type { AlertMetric, Severity } from "@/lib/db/schema";

type MetricInfo = Record<AlertMetric, { label: string; unit: "rate" | "count"; help: string }>;
type ScopeType = "organization" | "domain" | "mailbox";
type WindowUnit = "minutes" | "hours" | "days";

export interface RuleBuilderProps {
  mode: "create" | "edit";
  ruleId?: string;
  version?: number;
  initial?: AlertRuleInput;
  metricInfo: MetricInfo;
  domains: Array<{ id: string; name: string }>;
  mailboxes: Array<{ id: string; label: string }>;
  webhooks: Array<{ id: string; name: string }>;
  campaignIntegrationActive: boolean;
  emailDeliveryConfigured: boolean;
  canManage: boolean;
  canTest: boolean;
}

interface FormState {
  name: string;
  description: string;
  metric: AlertMetric;
  scopeType: ScopeType;
  scopeId: string;
  comparator: "gt" | "gte";
  threshold: string;
  windowValue: string;
  windowUnit: WindowUnit;
  minSample: string;
  severity: Severity;
  inApp: boolean;
  emails: string;
  webhookId: string;
  actionPolicy: "notify_only" | "pause_campaigns";
  requireManualResume: boolean;
  cooldown: string;
  enabled: boolean;
}

type FieldKey = keyof FormState | "window" | "general";
type Errors = Partial<Record<FieldKey, string>>;

interface DryRunResult {
  dryRun: true;
  results: TargetEvaluation[];
  wouldTrigger: number;
  action: string;
  wouldNotify: string[];
}

const UNIT_MINUTES: Record<WindowUnit, number> = { minutes: 1, hours: 60, days: 1440 };
const EVENT_METRICS = new Set<AlertMetric>(["bounce_rate", "hard_bounce_rate", "complaint_count", "provider_error_count", "sent_volume"]);

const THRESHOLD_HELP: Record<AlertMetric, string> = {
  bounce_rate: "Percentage of provider-recorded sends, e.g. 5 for 5%.",
  hard_bounce_rate: "Percentage of provider-recorded sends, e.g. 2 for 2%.",
  complaint_count: "Number of complaint reports in the window (per mailbox, or per domain when scoped to a domain).",
  provider_error_count: "Number of provider errors and sending-limit notices in the window.",
  sent_volume: "Number of provider-recorded sends in the window — useful for catching unexpected spikes.",
  dns_check_failing: "Number of failing checks in a domain's latest scan. 1 alerts on any failing check.",
  mailbox_connection_unhealthy: "Each mailbox scores 1 when affected and 0 otherwise, so use at or above 1.",
  sync_stale: "Each mailbox scores 1 when affected and 0 otherwise, so use at or above 1.",
};

const SEVERITY_HELP: Record<Severity, string> = {
  info: "Informational — worth knowing, no urgency.",
  warning: "Needs attention soon.",
  critical: "Needs action now. Critical rules that pause campaigns always require manual review before resuming.",
};

const STATUS_PILL: Record<TargetEvaluation["status"], { label: string; tone: "bad" | "good" | "unknown" }> = {
  triggered: { label: "Triggered", tone: "bad" },
  ok: { label: "OK", tone: "good" },
  insufficient_data: { label: "Insufficient data", tone: "unknown" },
  no_data: { label: "No data", tone: "unknown" },
};

const DEFAULT_STATE: FormState = {
  name: "",
  description: "",
  metric: "bounce_rate",
  scopeType: "organization",
  scopeId: "",
  comparator: "gte",
  threshold: "5",
  windowValue: "24",
  windowUnit: "hours",
  minSample: "50",
  severity: "warning",
  inApp: true,
  emails: "",
  webhookId: "",
  actionPolicy: "notify_only",
  requireManualResume: true,
  cooldown: "60",
  enabled: true,
};

const trimNumber = (n: number) => String(Number(n.toFixed(4)));

function fromInput(input: AlertRuleInput, info: MetricInfo): FormState {
  const unit: WindowUnit = input.windowMinutes % 1440 === 0 ? "days" : input.windowMinutes % 60 === 0 ? "hours" : "minutes";
  return {
    name: input.name,
    description: input.description,
    metric: input.metric,
    scopeType: input.scopeType,
    scopeId: input.scopeId ?? "",
    comparator: input.comparator,
    threshold: info[input.metric].unit === "rate" ? trimNumber(input.threshold * 100) : trimNumber(input.threshold),
    windowValue: String(input.windowMinutes / UNIT_MINUTES[unit]),
    windowUnit: unit,
    minSample: String(input.minSample),
    severity: input.severity,
    inApp: input.notificationTargets.inApp,
    emails: input.notificationTargets.emails.join(", "),
    webhookId: input.notificationTargets.webhookIntegrationId ?? "",
    actionPolicy: input.actionPolicy,
    requireManualResume: input.requireManualResume,
    cooldown: String(input.cooldownMinutes),
    enabled: input.enabled,
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function buildInput(s: FormState, info: MetricInfo): { input: AlertRuleInput | null; errors: Errors } {
  const errors: Errors = {};
  const isRate = info[s.metric].unit === "rate";
  const name = s.name.trim();
  if (name.length < 3 || name.length > 120) errors.name = "Name must be 3–120 characters.";
  if (s.description.trim().length > 500) errors.description = "Description must be 500 characters or fewer.";

  const threshold = Number(s.threshold);
  if (s.threshold.trim() === "" || !Number.isFinite(threshold) || threshold < 0) errors.threshold = "Enter a number of 0 or more.";
  else if (isRate && threshold > 100) errors.threshold = "Enter a percentage between 0 and 100.";

  const windowValue = Number(s.windowValue);
  const windowMinutes = Math.round(windowValue * UNIT_MINUTES[s.windowUnit]);
  if (s.windowValue.trim() === "" || !Number.isFinite(windowValue) || windowMinutes < 5 || windowMinutes > 43_200) errors.window = "The window must be between 5 minutes and 30 days.";
  else if (!Number.isInteger(windowValue * UNIT_MINUTES[s.windowUnit])) errors.window = "The window must be a whole number of minutes.";

  const minSample = Number(s.minSample);
  if (s.minSample.trim() === "" || !Number.isInteger(minSample) || minSample < 0) errors.minSample = "Enter a whole number of 0 or more.";
  else if (isRate && minSample < 1) errors.minSample = "Rate rules need a minimum sample of at least 1 send (we recommend 50 or more).";

  const cooldown = Number(s.cooldown);
  if (s.cooldown.trim() === "" || !Number.isInteger(cooldown) || cooldown < 0 || cooldown > 10_080) errors.cooldown = "Enter whole minutes between 0 and 10080 (7 days).";

  if (s.scopeType !== "organization" && !s.scopeId) errors.scopeId = `Choose the ${s.scopeType} this rule applies to.`;

  const emails = s.emails
    .split(/[\s,;]+/)
    .map((e) => e.trim())
    .filter(Boolean);
  const badEmail = emails.find((e) => !EMAIL_RE.test(e) || e.length > 254);
  if (badEmail) errors.emails = `"${badEmail}" is not a valid email address.`;
  else if (emails.length > 10) errors.emails = "Add at most 10 email addresses.";

  if (Object.keys(errors).length) return { input: null, errors };
  const forcedManualResume = s.severity === "critical" && s.actionPolicy === "pause_campaigns";
  return {
    errors,
    input: {
      name,
      description: s.description.trim(),
      metric: s.metric,
      scopeType: s.scopeType,
      scopeId: s.scopeType === "organization" ? null : s.scopeId,
      comparator: s.comparator,
      threshold: isRate ? Number((threshold / 100).toFixed(6)) : threshold,
      windowMinutes,
      minSample,
      severity: s.severity,
      notificationTargets: { inApp: s.inApp, emails, webhookIntegrationId: s.webhookId || null },
      actionPolicy: s.actionPolicy,
      requireManualResume: forcedManualResume ? true : s.requireManualResume,
      cooldownMinutes: cooldown,
      enabled: s.enabled,
    },
  };
}

/** Map API validation issues ({ path, message }) back onto form fields. */
function apiIssues(details: Record<string, unknown> | undefined, isRate: boolean): Errors {
  const issues = details?.issues;
  if (!Array.isArray(issues)) return {};
  const out: Errors = {};
  const map: Record<string, FieldKey> = {
    name: "name",
    description: "description",
    metric: "metric",
    scopeType: "scopeType",
    scopeId: "scopeId",
    comparator: "comparator",
    threshold: "threshold",
    windowMinutes: "window",
    minSample: "minSample",
    severity: "severity",
    "notificationTargets.inApp": "inApp",
    "notificationTargets.emails": "emails",
    "notificationTargets.webhookIntegrationId": "webhookId",
    actionPolicy: "actionPolicy",
    requireManualResume: "requireManualResume",
    cooldownMinutes: "cooldown",
    enabled: "enabled",
  };
  for (const issue of issues) {
    if (!issue || typeof issue !== "object") continue;
    const path = "path" in issue && typeof issue.path === "string" ? issue.path : "";
    const message = "message" in issue && typeof issue.message === "string" ? issue.message : "Invalid value.";
    const key = map[path.replace(/\.\d+$/, "")] ?? "general";
    const text = key === "threshold" && isRate && /fraction/i.test(message) ? "Enter a percentage between 0 and 100." : message;
    out[key] = out[key] ? `${out[key]} ${text}` : text;
  }
  return out;
}

const fieldCls = "mt-1 block w-full rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink placeholder:text-stone-400 disabled:bg-canvas disabled:text-muted aria-[invalid=true]:border-red-500";

export function RuleBuilder(props: RuleBuilderProps) {
  const { metricInfo: info } = props;
  const router = useRouter();
  const uid = useId();
  const resultsRef = useRef<HTMLHeadingElement>(null);
  const [s, setS] = useState<FormState>(() => (props.initial ? fromInput(props.initial, info) : DEFAULT_STATE));
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [dryRun, setDryRun] = useState<{ data: DryRunResult; metric: AlertMetric } | null>(null);

  const readOnly = !props.canManage;
  const isRate = info[s.metric].unit === "rate";
  const isEventMetric = EVENT_METRICS.has(s.metric);
  const forcedManualResume = s.severity === "critical" && s.actionPolicy === "pause_campaigns";
  const id = (k: string) => `${uid}-${k}`;

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setS((prev) => ({ ...prev, [key]: value }));
    // Results describe the rule as it was tested; drop them once the form changes.
    setDryRun(null);
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function changeMetric(metric: AlertMetric) {
    setS((prev) => {
      const next: FormState = { ...prev, metric };
      const wasRate = info[prev.metric].unit === "rate";
      const nowRate = info[metric].unit === "rate";
      if (wasRate !== nowRate) next.threshold = nowRate ? "5" : metric === "sent_volume" ? "1000" : "1";
      if (nowRate && (Number(prev.minSample) || 0) < 1) next.minSample = "50";
      if (metric === "dns_check_failing" && prev.scopeType === "mailbox") {
        next.scopeType = "organization";
        next.scopeId = "";
      }
      return next;
    });
    setErrors({});
    setDryRun(null);
  }

  function changeScope(scopeType: ScopeType) {
    const first = scopeType === "domain" ? props.domains[0]?.id : scopeType === "mailbox" ? props.mailboxes[0]?.id : undefined;
    setS((prev) => ({ ...prev, scopeType, scopeId: first ?? "" }));
    setErrors((prev) => ({ ...prev, scopeId: undefined }));
    setDryRun(null);
  }

  function fieldError(key: FieldKey) {
    const msg = errors[key];
    return msg ? (
      <span id={id(`${key}-error`)} className="mt-1 block text-xs text-red-700">
        {msg}
      </span>
    ) : null;
  }
  const a11y = (key: FieldKey, helpId?: string) => ({
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": [errors[key] ? id(`${key}-error`) : null, helpId ?? null].filter(Boolean).join(" ") || undefined,
  });

  function prepare(): AlertRuleInput | null {
    const { input, errors: e } = buildInput(s, info);
    setErrors(e);
    if (!input) setResult({ ok: false, message: "Fix the highlighted fields and try again." });
    return input;
  }

  async function runTest() {
    setResult(null);
    setDryRun(null);
    const input = prepare();
    if (!input) return;
    setBusy("test");
    const r = await api<DryRunResult>("/api/v1/alert-rules/test", { method: "POST", body: input });
    setBusy(null);
    if (r.success) {
      setDryRun({ data: r.data, metric: input.metric });
      setResult({ ok: true, message: `Dry run finished: would trigger for ${r.data.wouldTrigger} of ${r.data.results.length} target(s). Nothing was saved or sent.` });
      requestAnimationFrame(() => resultsRef.current?.focus());
    } else {
      setErrors(apiIssues(r.details, isRate));
      setResult({ ok: false, message: r.error });
    }
  }

  async function save() {
    setResult(null);
    const input = prepare();
    if (!input) return;
    setBusy("save");
    const r =
      props.mode === "create"
        ? await api<{ id: string; version: number }>("/api/v1/alert-rules", { method: "POST", body: input })
        : await api<{ id: string; version: number }>(`/api/v1/alert-rules/${props.ruleId ?? ""}`, { method: "PUT", body: input });
    if (r.success) {
      setResult({ ok: true, message: props.mode === "create" ? "Rule created. Returning to Alerts & rules…" : `Rule saved as version ${r.data.version}. Returning to Alerts & rules…` });
      router.push("/alerts");
      router.refresh();
    } else {
      setBusy(null);
      setErrors(apiIssues(r.details, isRate));
      setResult({ ok: false, message: r.error });
    }
  }

  const errorList = Object.entries(errors).filter((e): e is [FieldKey, string] => typeof e[1] === "string");

  return (
    <div className="space-y-6">
      {readOnly ? <Callout tone="unknown">Read-only: your role can view this rule but not change it.{props.canTest ? " You can still run a dry-run test." : ""}</Callout> : null}

      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!readOnly) void save();
        }}
        className="space-y-6"
        aria-label={props.mode === "create" ? "New alert rule" : "Edit alert rule"}
      >
        <fieldset disabled={readOnly || busy !== null} className="min-w-0 space-y-6">
          <Card title="Basics">
            <div className="grid gap-4">
              <label className="block text-sm">
                <span className="text-ink">Name</span>
                <input className={fieldCls} value={s.name} onChange={(e) => set("name", e.target.value)} maxLength={120} required {...a11y("name")} />
                {fieldError("name")}
              </label>
              <label className="block text-sm">
                <span className="text-ink">Description (optional)</span>
                <textarea className={fieldCls} rows={2} value={s.description} onChange={(e) => set("description", e.target.value)} maxLength={500} {...a11y("description")} />
                {fieldError("description")}
              </label>
            </div>
          </Card>

          <Card title="Condition" description="What is measured, where, and when it counts as a problem.">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="block text-sm md:col-span-2">
                <span className="text-ink">Metric</span>
                <select className={fieldCls} value={s.metric} onChange={(e) => changeMetric(e.target.value as AlertMetric)} {...a11y("metric", id("metric-help"))}>
                  {(Object.keys(info) as AlertMetric[]).map((m) => (
                    <option key={m} value={m}>
                      {info[m].label}
                    </option>
                  ))}
                </select>
                <span id={id("metric-help")} className="mt-1 block text-xs text-muted">
                  {info[s.metric].help}
                </span>
                {fieldError("metric")}
              </label>

              <fieldset className="min-w-0 md:col-span-2">
                <legend className="text-sm text-ink">Scope</legend>
                <div className="mt-1 flex flex-wrap gap-2">
                  {(
                    [
                      { v: "organization", label: "Whole organization", disabled: false, note: "" },
                      { v: "domain", label: "One domain", disabled: !props.domains.length, note: "No domains yet" },
                      { v: "mailbox", label: "One mailbox", disabled: !props.mailboxes.length || s.metric === "dns_check_failing", note: s.metric === "dns_check_failing" ? "DNS rules apply to domains" : "No mailboxes yet" },
                    ] as const
                  ).map((o) => (
                    <label key={o.v} className={clsx("flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-sm", o.disabled ? "text-muted" : "text-ink")}>
                      <input type="radio" name={id("scope")} value={o.v} checked={s.scopeType === o.v} disabled={o.disabled} onChange={() => changeScope(o.v)} className="h-4 w-4" />
                      {o.label}
                      {o.disabled ? <span className="text-xs">({o.note})</span> : null}
                    </label>
                  ))}
                </div>
                <p className="mt-1 text-xs text-muted">
                  {s.scopeType === "organization"
                    ? s.metric === "dns_check_failing"
                      ? "Evaluated for each monitored domain."
                      : "Evaluated separately for each connected mailbox, so an alert always names the mailbox."
                    : s.scopeType === "domain"
                      ? isEventMetric
                        ? "Events are added up across all mailboxes on this domain."
                        : "Only this domain (and its mailboxes)."
                      : "Only this mailbox."}
                </p>
                {s.scopeType === "domain" ? (
                  <label className="mt-2 block text-sm">
                    <span className="text-ink">Domain</span>
                    <select className={fieldCls} value={s.scopeId} onChange={(e) => set("scopeId", e.target.value)} {...a11y("scopeId")}>
                      <option value="">Choose a domain…</option>
                      {props.domains.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : s.scopeType === "mailbox" ? (
                  <label className="mt-2 block text-sm">
                    <span className="text-ink">Mailbox</span>
                    <select className={fieldCls} value={s.scopeId} onChange={(e) => set("scopeId", e.target.value)} {...a11y("scopeId")}>
                      <option value="">Choose a mailbox…</option>
                      {props.mailboxes.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {fieldError("scopeId")}
              </fieldset>

              <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-2 md:col-span-2">
                <label className="block text-sm">
                  <span className="text-ink">Fires when value is</span>
                  <select className={fieldCls} value={s.comparator} onChange={(e) => set("comparator", e.target.value === "gt" ? "gt" : "gte")} {...a11y("comparator")}>
                    <option value="gte">at or above (≥)</option>
                    <option value="gt">above (&gt;)</option>
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="text-ink">Threshold{isRate ? " (%)" : ""}</span>
                  <span className="relative block">
                    <input
                      type="number"
                      inputMode="decimal"
                      step="any"
                      min={0}
                      max={isRate ? 100 : undefined}
                      className={clsx(fieldCls, isRate && "pr-8")}
                      value={s.threshold}
                      onChange={(e) => set("threshold", e.target.value)}
                      {...a11y("threshold", id("threshold-help"))}
                    />
                    {isRate ? (
                      <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted">
                        %
                      </span>
                    ) : null}
                  </span>
                </label>
                <span id={id("threshold-help")} className="col-span-2 -mt-1 block text-xs text-muted">
                  {THRESHOLD_HELP[s.metric]}
                </span>
                <span className="col-span-2">{fieldError("comparator")}{fieldError("threshold")}</span>
              </div>

              <div className="text-sm">
                <span id={id("window-label")} className="text-ink">
                  Window
                </span>
                <div className="mt-1 grid grid-cols-[minmax(0,1fr)_minmax(0,8rem)] gap-2" role="group" aria-labelledby={id("window-label")}>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    aria-label="Window length"
                    className={clsx(fieldCls, "mt-0")}
                    value={s.windowValue}
                    onChange={(e) => set("windowValue", e.target.value)}
                    {...a11y("window", id("window-help"))}
                  />
                  <select aria-label="Window unit" className={clsx(fieldCls, "mt-0")} value={s.windowUnit} onChange={(e) => set("windowUnit", e.target.value as WindowUnit)}>
                    <option value="minutes">minutes</option>
                    <option value="hours">hours</option>
                    <option value="days">days</option>
                  </select>
                </div>
                <span id={id("window-help")} className="mt-1 block text-xs text-muted">
                  {isEventMetric ? "How far back events are counted. 5 minutes to 30 days." : "State-based metric: the current state is checked; the window is recorded as the evidence period."}
                </span>
                {fieldError("window")}
              </div>

              <label className="block text-sm">
                <span className="text-ink">Minimum sample (provider-recorded sends)</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={isRate ? 1 : 0}
                  step={1}
                  className={fieldCls}
                  value={s.minSample}
                  onChange={(e) => set("minSample", e.target.value)}
                  disabled={!isEventMetric}
                  {...a11y("minSample", id("minSample-help"))}
                />
                <span id={id("minSample-help")} className="mt-1 block text-xs text-muted">
                  {isRate
                    ? "A rate rule never fires until the window has at least this many sends. Below it the result is “insufficient data” — not healthy and not zero. At least 1; we recommend 50 or more."
                    : isEventMetric
                      ? "Optional. Skip evaluation when fewer sends than this were recorded in the window (0 = always evaluate)."
                      : "Not used by this metric."}
                </span>
                {fieldError("minSample")}
              </label>
            </div>
          </Card>

          <Card title="Severity & notifications">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="block text-sm">
                <span className="text-ink">Severity</span>
                <select className={fieldCls} value={s.severity} onChange={(e) => set("severity", e.target.value as Severity)} {...a11y("severity", id("severity-help"))}>
                  <option value="info">Info</option>
                  <option value="warning">Warning</option>
                  <option value="critical">Critical</option>
                </select>
                <span id={id("severity-help")} className="mt-1 block text-xs text-muted">
                  {SEVERITY_HELP[s.severity]}
                </span>
              </label>

              <fieldset className="min-w-0 md:col-span-2">
                <legend className="text-sm text-ink">Notify</legend>
                <div className="mt-2 space-y-3">
                  <label className="flex items-start gap-2 text-sm text-ink">
                    <input type="checkbox" className="mt-0.5 h-4 w-4" checked={s.inApp} onChange={(e) => set("inApp", e.target.checked)} />
                    <span>
                      In-app notification
                      <span className="block text-xs text-muted">Shown to everyone in this workspace.</span>
                    </span>
                  </label>
                  <label className="block text-sm">
                    <span className="text-ink">Email addresses (optional)</span>
                    <input
                      type="text"
                      inputMode="email"
                      autoComplete="off"
                      className={fieldCls}
                      placeholder="ops@example.com, deliverability@example.com"
                      value={s.emails}
                      onChange={(e) => set("emails", e.target.value)}
                      {...a11y("emails", id("emails-help"))}
                    />
                    <span id={id("emails-help")} className="mt-1 block text-xs text-muted">
                      Up to 10 addresses, separated by commas.
                      {props.emailDeliveryConfigured ? "" : " Email delivery is not configured on this server — email notifications will be recorded as “not configured” and not sent."}
                    </span>
                    {fieldError("emails")}
                  </label>
                  <label className="block text-sm">
                    <span className="text-ink">Notification webhook (optional)</span>
                    <select className={fieldCls} value={s.webhookId} onChange={(e) => set("webhookId", e.target.value)} disabled={!props.webhooks.length && !s.webhookId} {...a11y("webhookId", id("webhook-help"))}>
                      <option value="">None</option>
                      {props.webhooks.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                      {s.webhookId && !props.webhooks.some((w) => w.id === s.webhookId) ? <option value={s.webhookId}>Inactive or removed webhook</option> : null}
                    </select>
                    <span id={id("webhook-help")} className="mt-1 block text-xs text-muted">
                      {props.webhooks.length ? "A signed POST to an active notification webhook." : "No active notification webhooks. Add one on the Integrations page."}
                    </span>
                    {fieldError("webhookId")}
                  </label>
                </div>
              </fieldset>
            </div>
          </Card>

          <Card title="Campaign action" description="QuikReach does not send campaigns. It can only ask a connected sending system to pause them.">
            <fieldset className="min-w-0">
              <legend className="sr-only">Action policy</legend>
              <div className="space-y-2">
                <label className="flex items-start gap-2 rounded-md border border-line p-3 text-sm text-ink">
                  <input type="radio" name={id("policy")} className="mt-0.5 h-4 w-4" checked={s.actionPolicy === "notify_only"} onChange={() => set("actionPolicy", "notify_only")} />
                  <span>
                    Monitor only <span className="text-muted">(default)</span>
                    <span className="block text-xs text-muted">Notify the targets above. No campaign action is taken.</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 rounded-md border border-line p-3 text-sm text-ink">
                  <input type="radio" name={id("policy")} className="mt-0.5 h-4 w-4" checked={s.actionPolicy === "pause_campaigns"} onChange={() => set("actionPolicy", "pause_campaigns")} />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      Request a pause of linked campaigns
                      {props.campaignIntegrationActive ? null : <Pill tone="unknown">Currently unavailable — no campaign integration</Pill>}
                    </span>
                    <span className="block text-xs text-muted">
                      Works only with an active campaign integration and campaigns linked to the affected mailbox or domain. A campaign counts as paused only when the sending system confirms it.
                      {props.campaignIntegrationActive ? "" : " Until an integration is set up, alerts from this rule will record “Not paused — no campaign integration”."}
                    </span>
                  </span>
                </label>
              </div>
              {fieldError("actionPolicy")}
            </fieldset>
            {s.actionPolicy === "pause_campaigns" ? (
              <label className="mt-4 flex items-start gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4"
                  checked={forcedManualResume || s.requireManualResume}
                  disabled={forcedManualResume}
                  onChange={(e) => set("requireManualResume", e.target.checked)}
                  {...a11y("requireManualResume", id("resume-help"))}
                />
                <span>
                  Require manual review before resuming
                  <span id={id("resume-help")} className="block text-xs text-muted">
                    {forcedManualResume ? "Always on for critical rules that pause campaigns." : "A reviewer with campaign-review permission must approve resuming a campaign this rule paused."}
                  </span>
                  {fieldError("requireManualResume")}
                </span>
              </label>
            ) : null}
          </Card>

          <Card title="Behaviour">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="block text-sm">
                <span className="text-ink">Cooldown after resolve (minutes)</span>
                <input type="number" inputMode="numeric" min={0} max={10_080} step={1} className={fieldCls} value={s.cooldown} onChange={(e) => set("cooldown", e.target.value)} {...a11y("cooldown", id("cooldown-help"))} />
                <span id={id("cooldown-help")} className="mt-1 block text-xs text-muted">
                  After an alert is resolved, this rule will not re-open an alert for the same target for this long. 0–10080 (7 days).
                </span>
                {fieldError("cooldown")}
              </label>
              <label className="flex items-start gap-2 self-start text-sm text-ink md:mt-6">
                <input type="checkbox" className="mt-0.5 h-4 w-4" checked={s.enabled} onChange={(e) => set("enabled", e.target.checked)} />
                <span>
                  Enabled
                  <span className="block text-xs text-muted">Evaluated every 5 minutes and after each sync or scan. Disabled rules raise no alerts.</span>
                </span>
              </label>
            </div>
          </Card>
        </fieldset>

        {errorList.length ? (
          <div role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800 ring-1 ring-inset ring-red-200">
            <p className="font-medium">Please fix the following:</p>
            <ul className="mt-1 list-disc pl-5">
              {errorList.map(([k, msg]) => (
                <li key={k}>{msg}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          {props.canTest ? (
            <button type="button" className={buttonStyles.secondary} disabled={busy !== null} onClick={() => void runTest()}>
              {busy === "test" ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <FlaskConical aria-hidden className="h-4 w-4" />}
              Test (dry run)
            </button>
          ) : null}
          {!readOnly ? (
            <button type="submit" className={buttonStyles.primary} disabled={busy !== null}>
              {busy === "save" ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Save aria-hidden className="h-4 w-4" />}
              {props.mode === "create" ? "Create rule" : "Save changes"}
            </button>
          ) : null}
          <ResultMessage result={result} />
          {!readOnly && props.mode === "edit" && props.ruleId ? (
            <div className="ml-auto">
              <ActionButton
                label="Delete rule"
                path={`/api/v1/alert-rules/${props.ruleId}`}
                method="DELETE"
                variant="danger"
                icon={<Trash2 aria-hidden className="h-4 w-4" />}
                successMessage="Rule deleted."
                redirectTo="/alerts"
                confirm={{
                  title: "Delete this rule?",
                  description: "The rule stops being evaluated immediately. Existing alerts keep their history but no longer link to the rule. This cannot be undone — consider disabling it instead.",
                  confirmLabel: "Delete rule",
                }}
              />
            </div>
          ) : null}
        </div>
      </form>

      {dryRun ? (
        <Card title={<span ref={resultsRef} tabIndex={-1} className="outline-none">Dry-run results</span>} description="Evaluated against current data. Nothing was saved, no alert was created and no notification or campaign action was sent.">
          <div className="space-y-4">
            <p className="text-sm text-ink">
              Would trigger for <strong>{dryRun.data.wouldTrigger}</strong> of {dryRun.data.results.length} target(s).
            </p>
            {dryRun.data.results.length ? (
              <div className="-mx-4">
                <Table caption="Per-target dry-run results" head={["Target", "Status", "Value", "Details"]}>
                  {dryRun.data.results.map((r, i) => {
                    const pill = STATUS_PILL[r.status];
                    const rate = info[dryRun.metric].unit === "rate";
                    const value = r.observedValue === null ? "n/a" : rate ? pct(r.observedValue, 2) : String(Math.round(r.observedValue * 100) / 100);
                    return (
                      <tr key={`${r.targetId ?? "org"}-${i}`}>
                        <Td className="break-words">
                          {r.targetLabel}
                          <span className="block text-xs capitalize text-muted">{r.targetType}</span>
                        </Td>
                        <Td>
                          <Pill tone={pill.tone}>{pill.label}</Pill>
                        </Td>
                        <Td className="whitespace-nowrap">
                          {value}
                          {r.denominator !== undefined ? <span className="block text-xs text-muted">{r.numerator ?? 0} of {r.denominator} sent</span> : null}
                        </Td>
                        <Td className="text-xs text-muted">{r.message}</Td>
                      </tr>
                    );
                  })}
                </Table>
              </div>
            ) : (
              <p className="text-sm text-muted">No targets in scope (for example no connected mailboxes or monitored domains), so nothing could be evaluated. This is not a healthy result.</p>
            )}
            <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-6">
              <dt className="text-muted">Campaign action</dt>
              <dd className="text-ink">{dryRun.data.action}</dd>
              <dt className="text-muted">Would notify</dt>
              <dd className="text-ink">{dryRun.data.wouldNotify.length ? dryRun.data.wouldNotify.join(", ") : dryRun.data.wouldTrigger ? "Nobody — no notification targets are set." : "Nobody — nothing would trigger."}</dd>
            </dl>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
