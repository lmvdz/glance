import { cn } from "@/lib/cn";
import type { AgentStatus } from "@/lib/time";

// Mirrors the SPA `.d.<status>` dot colors.
const STATUS_COLOR: Record<AgentStatus, string> = {
  working: "bg-warning",
  idle: "bg-success",
  input: "bg-attention",
  error: "bg-danger",
  starting: "bg-accent",
  stopped: "bg-neutral",
};

export function StatusDot({ status, className }: { status: AgentStatus; className?: string }) {
  return (
    <span
      role="img"
      aria-label={status}
      className={cn("inline-block size-2 rounded-full", STATUS_COLOR[status], className)}
    />
  );
}
