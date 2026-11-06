"use client";

import { Card, EmptyState, buttonStyles } from "@/components/ui/primitives";
import { OctagonX } from "lucide-react";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Card>
      <EmptyState icon={OctagonX} title="This page could not be loaded" action={<button type="button" className={buttonStyles.secondary} onClick={reset}>Try again</button>}>
        Something went wrong on our side. No data was changed. {error.digest ? <>Reference: <code>{error.digest}</code></> : null}
      </EmptyState>
    </Card>
  );
}
