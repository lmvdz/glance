import { forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

// Ported from the SPA `.badge` + `.b-<status>` families. Each tone = subtle bg,
// solid text, 28% color-mix border (24% for accent families).
export const badgeVariants = cva(
  "inline-flex items-center gap-1 whitespace-nowrap rounded-[var(--radius-full)] border border-transparent px-2 py-0.5 text-[length:var(--text-11)] font-semibold uppercase leading-[1.45] tracking-[0.04em]",
  {
    variants: {
      tone: {
        success:
          "bg-success-subtle text-success border-[color-mix(in_srgb,var(--success)_28%,transparent)]",
        warning:
          "bg-warning-subtle text-warning border-[color-mix(in_srgb,var(--warning)_28%,transparent)]",
        attention:
          "bg-attention-subtle text-attention border-[color-mix(in_srgb,var(--attention)_28%,transparent)]",
        danger:
          "bg-danger-subtle text-danger border-[color-mix(in_srgb,var(--danger)_28%,transparent)]",
        accent:
          "bg-accent-subtle text-accent border-[color-mix(in_srgb,var(--accent)_24%,transparent)]",
        neutral: "bg-neutral-subtle text-neutral border-border",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(({ className, tone, ...props }, ref) => (
  <span ref={ref} className={cn(badgeVariants({ tone }), className)} {...props} />
));
Badge.displayName = "Badge";
