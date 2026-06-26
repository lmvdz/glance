import { forwardRef } from "react";
import { cn } from "@/lib/cn";

export const Table = forwardRef<HTMLTableElement, React.TableHTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <table
      ref={ref}
      className={cn("w-full border-collapse text-[length:var(--text-13)] tabular-nums", className)}
      {...props}
    />
  ),
);
Table.displayName = "Table";

export const THead = forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <thead ref={ref} className={cn("", className)} {...props} />,
);
THead.displayName = "THead";

export const TBody = forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <tbody ref={ref} className={cn("", className)} {...props} />,
);
TBody.displayName = "TBody";

export const Tr = forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr ref={ref} className={cn("border-b border-border hover:bg-secondary", className)} {...props} />
  ),
);
Tr.displayName = "Tr";

export const Th = forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th
      ref={ref}
      className={cn(
        "px-3 py-2 text-left text-[length:var(--text-11)] font-semibold uppercase tracking-[0.06em] text-text-3",
        className,
      )}
      {...props}
    />
  ),
);
Th.displayName = "Th";

export const Td = forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td ref={ref} className={cn("px-3 py-2 text-text-1", className)} {...props} />
  ),
);
Td.displayName = "Td";
