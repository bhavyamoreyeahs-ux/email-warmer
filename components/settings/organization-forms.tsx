"use client";

/** Organisation settings forms (PATCH /api/v1/organization). Each shows its own result. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/ui/api";
import { buttonStyles, Callout } from "@/components/ui/primitives";
import { ResultMessage } from "@/components/ui/interactive";
import { hintCls, inputCls, labelCls, labelTextCls } from "@/components/settings/fields";

type Result = { ok: boolean; message: string } | null;

function usePatchOrganization() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);
  async function patch(body: Record<string, unknown>, successMessage: string): Promise<boolean> {
    setBusy(true);
    setResult(null);
    const r = await api("/api/v1/organization", { method: "PATCH", body });
    setBusy(false);
    if (r.success) {
      setResult({ ok: true, message: successMessage });
      router.refresh();
      return true;
    }
    setResult({ ok: false, message: r.error });
    return false;
  }
  return { busy, result, setResult, patch };
}

function SubmitRow({ busy, label, disabled, result, readOnlyNote }: { busy: boolean; label: string; disabled?: boolean; result: Result; readOnlyNote?: string }) {
  if (readOnlyNote) return <p className="text-xs text-muted">{readOnlyNote}</p>;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button type="submit" className={buttonStyles.primary} disabled={busy || disabled}>
        {busy ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}
        {label}
      </button>
      <ResultMessage result={result} />
    </div>
  );
}

const READ_ONLY = "Read only — changing settings needs organization:update.";

/* ─── Name ────────────────────────────────────────────────────────────── */

export function OrganizationNameForm({ name, canEdit }: { name: string; canEdit: boolean }) {
  const [value, setValue] = useState(name);
  const { busy, result, patch } = usePatchOrganization();
  const trimmed = value.trim();
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void patch({ name: trimmed }, "Organization name saved.");
      }}
    >
      <label className={labelCls}>
        <span className={labelTextCls}>Organization name</span>
        <input className={inputCls} value={value} onChange={(e) => setValue(e.target.value)} required minLength={2} maxLength={100} disabled={!canEdit || busy} />
      </label>
      <SubmitRow busy={busy} label="Save name" disabled={trimmed.length < 2 || trimmed === name} result={result} readOnlyNote={canEdit ? undefined : READ_ONLY} />
    </form>
  );
}

/* ─── Retention ───────────────────────────────────────────────────────── */

type RetentionKey = "eventRetentionDays" | "diagnosticRetentionDays" | "auditRetentionDays";
const RETENTION_FIELDS: Array<{ key: RetentionKey; label: string; min: number; help: string }> = [
  { key: "eventRetentionDays", label: "Provider events", min: 1, help: "Sent, bounce, reply and other classified mailbox events." },
  { key: "diagnosticRetentionDays", label: "Diagnostics", min: 1, help: "AI and rules-engine diagnoses and their evidence references." },
  { key: "auditRetentionDays", label: "Audit log", min: 30, help: "Security and change history. Minimum 30 days." },
];

export function RetentionForm({ values, defaults, canEdit }: { values: Record<RetentionKey, number | null>; defaults: Record<RetentionKey, number>; canEdit: boolean }) {
  const [draft, setDraft] = useState<Record<RetentionKey, string>>({
    eventRetentionDays: values.eventRetentionDays?.toString() ?? "",
    diagnosticRetentionDays: values.diagnosticRetentionDays?.toString() ?? "",
    auditRetentionDays: values.auditRetentionDays?.toString() ?? "",
  });
  const [confirmShorter, setConfirmShorter] = useState(false);
  const { busy, result, setResult, patch } = usePatchOrganization();

  function parse(): { body: Record<RetentionKey, number | null>; error: string | null } {
    const body: Record<RetentionKey, number | null> = { eventRetentionDays: null, diagnosticRetentionDays: null, auditRetentionDays: null };
    for (const f of RETENTION_FIELDS) {
      const raw = draft[f.key].trim();
      if (raw === "") continue;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < f.min || n > 3650) return { body, error: `${f.label}: enter a whole number of days between ${f.min} and 3650, or leave empty for the default.` };
      body[f.key] = n;
    }
    return { body, error: null };
  }

  const { body, error } = parse();
  const shortened = RETENTION_FIELDS.filter((f) => (body[f.key] ?? defaults[f.key]) < (values[f.key] ?? defaults[f.key]));
  const unchanged = RETENTION_FIELDS.every((f) => body[f.key] === values[f.key]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (error) {
      setResult({ ok: false, message: error });
      return;
    }
    if (shortened.length && !confirmShorter) {
      setConfirmShorter(true);
      return;
    }
    const saved = await patch(body, "Retention saved. The daily purge applies it.");
    if (saved) setConfirmShorter(false);
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {RETENTION_FIELDS.map((f) => {
          const current = values[f.key];
          return (
            <label key={f.key} className={labelCls}>
              <span className={labelTextCls}>{f.label} (days)</span>
              <input
                className={inputCls}
                type="number"
                inputMode="numeric"
                min={f.min}
                max={3650}
                step={1}
                value={draft[f.key]}
                placeholder={`Default: ${defaults[f.key]}`}
                disabled={!canEdit || busy}
                onChange={(e) => {
                  setDraft((d) => ({ ...d, [f.key]: e.target.value }));
                  setConfirmShorter(false);
                }}
                aria-describedby={`${f.key}-hint`}
              />
              <span id={`${f.key}-hint`} className={hintCls}>
                {f.help} Now: {current ?? defaults[f.key]} days{current === null ? " (deployment default)" : ""}. Leave empty to use the default ({defaults[f.key]} days).
              </span>
            </label>
          );
        })}
      </div>
      {confirmShorter && shortened.length ? (
        <Callout tone="warn" title="Shorter retention permanently deletes data">
          {shortened.map((f) => f.label).join(", ")}: records older than the new period will be deleted at the next daily purge and cannot be recovered. Select “Confirm and save” to continue.
        </Callout>
      ) : null}
      <SubmitRow
        busy={busy}
        label={confirmShorter && shortened.length ? "Confirm and save" : "Save retention"}
        disabled={unchanged && !error}
        result={result}
        readOnlyNote={canEdit ? undefined : READ_ONLY}
      />
    </form>
  );
}

/* ─── Notification defaults ───────────────────────────────────────────── */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function AlertEmailsForm({ emails, canEdit }: { emails: string[]; canEdit: boolean }) {
  const [value, setValue] = useState(emails.join("\n"));
  const { busy, result, setResult, patch } = usePatchOrganization();
  const list = [...new Set(value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
  const unchanged = list.join("\n") === emails.join("\n");

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const bad = list.filter((x) => !EMAIL_RE.test(x));
        if (bad.length) return setResult({ ok: false, message: `Not a valid email address: ${bad.join(", ")}` });
        if (list.length > 10) return setResult({ ok: false, message: "Enter at most 10 addresses." });
        void patch({ settings: { defaultAlertEmails: list } }, list.length ? `Saved ${list.length} default alert ${list.length === 1 ? "recipient" : "recipients"}.` : "Default alert recipients cleared.");
      }}
    >
      <label className={labelCls}>
        <span className={labelTextCls}>Default alert email recipients</span>
        <textarea className={inputCls} rows={3} value={value} onChange={(e) => setValue(e.target.value)} disabled={!canEdit || busy} placeholder={"ops@example.com\ndeliverability@example.com"} aria-describedby="alert-emails-hint" />
        <span id="alert-emails-hint" className={hintCls}>
          Up to 10 addresses, one per line or comma-separated. These addresses receive an email for every new alert, in addition to the recipients configured on each rule. Emails are only sent when SMTP is configured; otherwise they are recorded as not configured.
        </span>
      </label>
      <SubmitRow busy={busy} label="Save recipients" disabled={unchanged} result={result} readOnlyNote={canEdit ? undefined : READ_ONLY} />
    </form>
  );
}

/* ─── Freshness thresholds ────────────────────────────────────────────── */

export function FreshnessForm({
  syncStaleAfterHours,
  scanStaleAfterDays,
  defaults,
  canEdit,
}: {
  syncStaleAfterHours: number | null;
  scanStaleAfterDays: number | null;
  defaults: { syncStaleAfterHours: number; scanStaleAfterDays: number };
  canEdit: boolean;
}) {
  const [sync, setSync] = useState(String(syncStaleAfterHours ?? defaults.syncStaleAfterHours));
  const [scan, setScan] = useState(String(scanStaleAfterDays ?? defaults.scanStaleAfterDays));
  const { busy, result, setResult, patch } = usePatchOrganization();

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const h = Number(sync);
        const d = Number(scan);
        if (!Number.isInteger(h) || h < 1 || h > 72) return setResult({ ok: false, message: "Sync threshold: enter a whole number of hours between 1 and 72." });
        if (!Number.isInteger(d) || d < 1 || d > 60) return setResult({ ok: false, message: "Scan threshold: enter a whole number of days between 1 and 60." });
        void patch({ settings: { syncStaleAfterHours: h, scanStaleAfterDays: d } }, "Freshness thresholds saved.");
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className={labelCls}>
          <span className={labelTextCls}>Mailbox sync is stale after (hours)</span>
          <input className={inputCls} type="number" inputMode="numeric" min={1} max={72} step={1} required value={sync} onChange={(e) => setSync(e.target.value)} disabled={!canEdit || busy} aria-describedby="sync-stale-hint" />
          <span id="sync-stale-hint" className={hintCls}>
            1–72. Default {defaults.syncStaleAfterHours}{syncStaleAfterHours === null ? " (in use)" : ""}. Older data is shown as Stale, never Healthy.
          </span>
        </label>
        <label className={labelCls}>
          <span className={labelTextCls}>DNS scan is stale after (days)</span>
          <input className={inputCls} type="number" inputMode="numeric" min={1} max={60} step={1} required value={scan} onChange={(e) => setScan(e.target.value)} disabled={!canEdit || busy} aria-describedby="scan-stale-hint" />
          <span id="scan-stale-hint" className={hintCls}>
            1–60. Default {defaults.scanStaleAfterDays}{scanStaleAfterDays === null ? " (in use)" : ""}.
          </span>
        </label>
      </div>
      <SubmitRow busy={busy} label="Save thresholds" result={result} readOnlyNote={canEdit ? undefined : READ_ONLY} />
    </form>
  );
}
