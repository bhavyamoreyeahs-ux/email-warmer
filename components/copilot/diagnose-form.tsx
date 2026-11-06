"use client";

/**
 * Diagnosis request form and the one-click "Diagnose this alert" button.
 * Both POST /api/v1/diagnostics and navigate to /copilot?d=<id> on success.
 * Props are plain serializable data (no functions) so server pages can render them.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Stethoscope } from "lucide-react";
import { api } from "@/lib/ui/api";
import { buttonStyles } from "@/components/ui/primitives";
import { ResultMessage } from "@/components/ui/interactive";

type SubjectType = "organization" | "domain" | "mailbox" | "alert";
export interface SubjectOption {
  id: string;
  label: string;
}

const fieldCls = "mt-1 block w-full rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink placeholder:text-stone-400 disabled:opacity-60";

async function requestDiagnosis(body: { subjectType: SubjectType; subjectId?: string; question?: string }) {
  return api<{ id: string }>("/api/v1/diagnostics", { method: "POST", body });
}

export function DiagnoseForm({ domains, mailboxes, alerts }: { domains: SubjectOption[]; mailboxes: SubjectOption[]; alerts: SubjectOption[] }) {
  const router = useRouter();
  const [subjectType, setSubjectType] = useState<SubjectType>("organization");
  const [subjectId, setSubjectId] = useState("");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const scopes: Array<{ value: SubjectType; label: string; selectLabel: string; options: SubjectOption[] | null; empty: string }> = [
    { value: "organization", label: "Whole workspace", selectLabel: "", options: null, empty: "" },
    { value: "domain", label: "A domain", selectLabel: "Domain", options: domains, empty: "No domains yet" },
    { value: "mailbox", label: "A mailbox", selectLabel: "Mailbox", options: mailboxes, empty: "No mailboxes yet" },
    { value: "alert", label: "An open alert", selectLabel: "Open alert", options: alerts, empty: "No open alerts" },
  ];
  const current = scopes.find((s) => s.value === subjectType);
  const needsSubject = subjectType !== "organization";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (needsSubject && !subjectId) {
      setResult({ ok: false, message: `Choose ${current?.label.toLowerCase() ?? "a subject"} to diagnose.` });
      return;
    }
    setBusy(true);
    setResult(null);
    const r = await requestDiagnosis({ subjectType, subjectId: needsSubject ? subjectId : undefined, question: question.trim() || undefined });
    setBusy(false);
    if (r.success) {
      setResult({ ok: true, message: "Diagnosis complete. Loading it…" });
      setQuestion("");
      router.push(`/copilot?d=${r.data.id}`);
      router.refresh();
    } else {
      setResult({ ok: false, message: r.error });
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <fieldset className="min-w-0">
        <legend className="text-sm font-medium text-ink">What should be diagnosed?</legend>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {scopes.map((s) => {
            const unavailable = s.options !== null && s.options.length === 0;
            return (
              <label key={s.value} className={`flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm ${unavailable ? "text-muted" : "text-ink"}`}>
                <input
                  type="radio"
                  name="subjectType"
                  value={s.value}
                  checked={subjectType === s.value}
                  disabled={unavailable || busy}
                  onChange={() => {
                    setSubjectType(s.value);
                    setSubjectId(s.options?.[0]?.id ?? "");
                  }}
                  className="h-4 w-4"
                />
                {s.label}
                {unavailable ? <span className="text-xs">({s.empty})</span> : null}
              </label>
            );
          })}
        </div>
      </fieldset>

      {needsSubject && current?.options ? (
        <label className="block text-sm">
          <span className="text-ink">{current.selectLabel}</span>
          <select className={fieldCls} value={subjectId} onChange={(e) => setSubjectId(e.target.value)} disabled={busy} required>
            {current.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <label className="block text-sm">
        <span className="text-ink">Question (optional)</span>
        <textarea
          className={fieldCls}
          rows={2}
          maxLength={500}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={busy}
          placeholder="e.g. Why did bounces rise on this mailbox this week?"
          aria-describedby="question-help"
        />
        <span id="question-help" className="mt-1 block text-xs text-muted">
          Up to 500 characters. The answer is limited to what QuikReach&rsquo;s stored evidence shows.
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={buttonStyles.primary} disabled={busy}>
          {busy ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Stethoscope aria-hidden className="h-4 w-4" />}
          {busy ? "Diagnosing…" : "Run diagnosis"}
        </button>
        {busy ? (
          <span role="status" className="text-xs text-muted">
            Collecting evidence and analysing. This can take up to a minute.
          </span>
        ) : null}
        <ResultMessage result={result} />
      </div>
    </form>
  );
}

/** Used on the alert detail page: diagnose one alert and open the result in the Copilot. */
export function DiagnoseButton({ subjectType, subjectId, label = "Diagnose this alert" }: { subjectType: Exclude<SubjectType, "organization">; subjectId: string; label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    const r = await requestDiagnosis({ subjectType, subjectId });
    if (r.success) {
      setResult({ ok: true, message: "Diagnosis complete. Opening the Copilot…" });
      router.push(`/copilot?d=${r.data.id}`);
    } else {
      setBusy(false);
      setResult({ ok: false, message: r.error });
    }
  }

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button type="button" className={buttonStyles.secondary} disabled={busy} onClick={() => void run()}>
        {busy ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Stethoscope aria-hidden className="h-4 w-4" />}
        {busy ? "Diagnosing…" : label}
      </button>
      <ResultMessage result={result} />
    </div>
  );
}
