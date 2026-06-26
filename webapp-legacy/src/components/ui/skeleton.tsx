import { cn } from "@/lib/cn";

// SPA `.skel` shimmer; reduced-motion handled globally in index.css.
const shimmer =
  "bg-[linear-gradient(90deg,var(--surface-2)_25%,var(--surface-3)_50%,var(--surface-2)_75%)] bg-[length:200%_100%] animate-[skel_1.3s_ease-in-out_infinite]";

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-[var(--radius-sm)]", shimmer, className)} {...props} />;
}

export function SkeletonRow({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <Skeleton className={cn("my-2 h-[14px]", className)} {...props} />;
}

export function SkeletonCard({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <Skeleton className={cn("h-16 rounded-[var(--radius-md)]", className)} {...props} />;
}
