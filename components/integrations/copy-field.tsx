"use client";

/** Read-only value with a copy button (one-time secrets, invitation links). */
import { useId, useState } from "react";
import { Check, Copy } from "lucide-react";
import { buttonStyles } from "@/components/ui/primitives";

export function CopyField({ label, value, description }: { label: string; value: string; description?: React.ReactNode }) {
  const id = useId();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
      <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
        <input
          id={id}
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-3 py-2 font-mono text-xs text-ink"
        />
        <button type="button" onClick={() => void copy()} className={buttonStyles.secondary}>
          {state === "copied" ? <Check aria-hidden className="h-4 w-4" /> : <Copy aria-hidden className="h-4 w-4" />}
          {state === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
      <p role="status" aria-live="polite" className="mt-1 min-h-[1rem] text-xs text-muted">
        {state === "copied" ? "Copied to the clipboard." : state === "failed" ? "Could not copy automatically — select the text and copy it manually." : ""}
      </p>
    </div>
  );
}
