import { forwardRef } from "react";
import { cn } from "@/lib/cn";

// SPA parity: surface-2 fill, hairline border, accent focus border, 40px min-height.
export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "min-h-[40px] w-full rounded-[var(--radius-sm)] border border-border bg-secondary px-3 py-1.5 text-[length:var(--text-14)] text-text-1 outline-none transition-colors duration-150 placeholder:text-text-3 focus:border-accent disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
