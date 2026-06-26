import { forwardRef } from "react";
import { cn } from "@/lib/cn";

// Mirrors the SPA `.section` panel: hairline border, radius-md, card surface, shadow-1.
export const Card = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "overflow-hidden rounded-[var(--radius-md)] border border-border bg-surface shadow-[var(--shadow-1)]",
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = "Card";

// Uppercase 11px label row (the SPA `.section > h3`).
export const CardHeader = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "flex items-center gap-2 border-b border-border bg-surface-raised/45 px-2.5 py-1.5 text-[length:var(--text-11)] font-semibold uppercase tracking-[0.06em] text-text-3",
        className,
      )}
      {...props}
    />
  ),
);
CardHeader.displayName = "CardHeader";

export const CardTitle = forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => <h3 ref={ref} className={cn("m-0", className)} {...props} />,
);
CardTitle.displayName = "CardTitle";

export const CardContent = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("p-2.5", className)} {...props} />,
);
CardContent.displayName = "CardContent";
