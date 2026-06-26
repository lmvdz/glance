import { Badge, type BadgeProps } from "@/components/ui/badge";
import type { AgentStatus } from "@/lib/time";

// Single keyed map — extend this (not ad-hoc classes) if the status enum grows.
const STATUS_TONE: Record<AgentStatus, NonNullable<BadgeProps["tone"]>> = {
  working: "warning",
  idle: "success",
  input: "attention",
  error: "danger",
  starting: "accent",
  stopped: "neutral",
};

export function StatusBadge({ status, className }: { status: AgentStatus; className?: string }) {
  return (
    <Badge tone={STATUS_TONE[status]} className={className}>
      {status}
    </Badge>
  );
}
