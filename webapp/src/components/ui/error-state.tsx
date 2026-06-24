import { type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

// Danger-tinted EmptyState with a retry action.
export function ErrorState({
  title = "Something went wrong",
  children,
  onRetry,
  className,
}: {
  title?: string;
  children?: ReactNode;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <EmptyState
      tone="danger"
      title={title}
      className={className}
      action={onRetry ? <Button size="sm" onClick={onRetry}>Retry</Button> : undefined}
    >
      {children}
    </EmptyState>
  );
}
