/**
 * Post-action confirmation shown after a mutation that removes its own button
 * (e.g. removing a member). The page maps a fixed `?notice=` key to a message;
 * arbitrary text from the URL is never rendered.
 */
import { Callout } from "@/components/ui/primitives";

export function readNotice(raw: string | string[] | undefined, messages: Record<string, string>): string | null {
  const key = Array.isArray(raw) ? raw[0] : raw;
  return key && Object.prototype.hasOwnProperty.call(messages, key) ? (messages[key] ?? null) : null;
}

export function Notice({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div role="status" className="mb-6">
      <Callout tone="info">{message}</Callout>
    </div>
  );
}
