"use client";

/** Queue a manual mailbox sync. Tells the user when a sync was already queued. */
import { RefreshCw } from "lucide-react";
import { ActionButton } from "@/components/ui/interactive";

function wasDeduplicated(data: unknown): boolean {
  return typeof data === "object" && data !== null && "deduplicated" in data && (data as { deduplicated: unknown }).deduplicated === true;
}

export function SyncNowButton({ connectionId, disabled, disabledReason }: { connectionId: string; disabled?: boolean; disabledReason?: string }) {
  return (
    <ActionButton
      label="Sync now"
      path={`/api/v1/mailboxes/${connectionId}/sync`}
      variant="primary"
      disabled={disabled}
      disabledReason={disabledReason}
      icon={<RefreshCw aria-hidden className="h-4 w-4" />}
      successMessage={(data) =>
        wasDeduplicated(data)
          ? "A sync is already queued for this mailbox — new events appear when it finishes."
          : "Sync queued. New events usually appear within a few minutes; refresh this page to see them."
      }
    />
  );
}
