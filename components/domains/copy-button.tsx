"use client";

/** Copies a DNS value to the clipboard and announces the result to screen readers. */
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { buttonStyles } from "@/components/ui/primitives";

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 2500);
    return () => clearTimeout(t);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" className={buttonStyles.secondary} onClick={() => void copy()} aria-label={`Copy ${label}`}>
        {state === "copied" ? <Check aria-hidden className="h-4 w-4 text-emerald-700" /> : <Copy aria-hidden className="h-4 w-4" />}
        {state === "copied" ? "Copied" : "Copy"}
      </button>
      <span role="status" aria-live="polite" className={state === "failed" ? "text-xs text-red-700" : "sr-only"}>
        {state === "copied" ? `${label} copied to clipboard.` : state === "failed" ? "Copy failed — select the text and copy it manually." : ""}
      </span>
    </span>
  );
}
