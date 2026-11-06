import { Card, EmptyState, LinkButton } from "@/components/ui/primitives";

export default function NotFound() {
  return (
    <Card>
      <EmptyState title="Not found" action={<LinkButton href="/dashboard">Back to dashboard</LinkButton>}>
        This record does not exist in your current workspace.
      </EmptyState>
    </Card>
  );
}
