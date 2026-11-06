"use client";

/** Queue a DNS scan (manual or "re-check after changes"). Tells the user when a scan was already queued. */
import { RefreshCw, RotateCcw } from "lucide-react";
import { ActionButton } from "@/components/ui/interactive";
import type { buttonStyles } from "@/components/ui/primitives";

function wasDeduplicated(data: unknown): boolean {
  return typeof data === "object" && data !== null && "deduplicated" in data && (data as { deduplicated: unknown }).deduplicated === true;
}

export function ScanButton({
  domainId,
  trigger,
  label,
  variant = "secondary",
  disabled,
  disabledReason,
}: {
  domainId: string;
  trigger: "manual" | "recheck";
  label: string;
  variant?: keyof typeof buttonStyles;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <ActionButton
      label={label}
      path={`/api/v1/domains/${domainId}/scan${trigger === "recheck" ? "?trigger=recheck" : ""}`}
      variant={variant}
      disabled={disabled}
      disabledReason={disabledReason}
      icon={trigger === "recheck" ? <RotateCcw aria-hidden className="h-4 w-4" /> : <RefreshCw aria-hidden className="h-4 w-4" />}
      successMessage={(data) =>
        wasDeduplicated(data)
          ? "A scan is already queued or running for this domain — results will appear here when it finishes."
          : "Scan queued. Results usually appear within a minute; refresh this page to see them."
      }
    />
  );
}
