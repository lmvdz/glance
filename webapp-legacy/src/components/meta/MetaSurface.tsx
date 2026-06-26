import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function MetaCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-[var(--radius-md)] border border-border bg-surface shadow-[var(--shadow-card)]",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function MetaSectionHeader({
  eyebrow,
  title,
  children,
  action,
}: {
  eyebrow?: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-border bg-surface-raised/40 px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        {eyebrow ? <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-text-muted">{eyebrow}</p> : null}
        <h2 className="truncate text-base font-semibold text-text-primary">{title}</h2>
        {children ? <p className="max-w-2xl text-[13px] leading-5 text-text-secondary">{children}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function MetaProgress({ value, label }: { value: number; label?: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="space-y-1.5" aria-label={label ?? `Progress ${Math.round(pct)}%`}>
      <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      {label ? <p className="text-xs text-text-muted">{label}</p> : null}
    </div>
  );
}

export function MetaPill({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "danger" | "accent";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-h-6 items-center rounded-full border px-2 text-xs font-medium",
        tone === "neutral" && "border-border bg-secondary text-text-secondary",
        tone === "good" && "border-done/30 bg-done-bg text-done",
        tone === "warn" && "border-progress/30 bg-progress-bg text-progress",
        tone === "danger" && "border-cancelled/30 bg-cancelled-bg text-cancelled",
        tone === "accent" && "border-accent/30 bg-accent-glow text-accent-light",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function MetaEmptyPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-dashed border-border bg-secondary/40 p-6 text-center">
      <p className="text-sm font-semibold text-text-primary">{title}</p>
      <p className="mt-1 text-sm text-text-muted">{children}</p>
    </div>
  );
}
