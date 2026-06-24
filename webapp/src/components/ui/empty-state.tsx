import { type ReactNode } from "react";
import { cn } from "@/lib/cn";

// SPA `.empty`: dotted card, centered title + hint, optional action slot.
const dots =
  "bg-[radial-gradient(circle,color-mix(in_srgb,var(--text-3)_10%,transparent)_1px,transparent_1.6px)] bg-[length:18px_18px]";

export function EmptyState({
  title,
  children,
  action,
  className,
  tone = "neutral",
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  tone?: "neutral" | "danger";
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : undefined}
      className={cn(
        "m-2 rounded-[var(--radius-md)] border px-5 py-6 text-center text-[length:var(--text-13)] leading-[1.45]",
        tone === "danger"
          ? "border-[color-mix(in_srgb,var(--danger)_28%,transparent)] bg-danger-subtle text-danger"
          : cn("border-border text-text-3", dots),
        className,
      )}
    >
      <strong
        className={cn(
          "mb-1 block text-[length:var(--text-13)] font-semibold",
          tone === "danger" ? "text-danger" : "text-text-2",
        )}
      >
        {title}
      </strong>
      {children}
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}
