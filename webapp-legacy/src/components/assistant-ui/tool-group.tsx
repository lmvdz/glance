import type { ComponentProps, PropsWithChildren } from "react";
import { ChevronDownIcon, LoaderIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function ToolGroupRoot({ className, children, open, ...props }: ComponentProps<"details"> & { variant?: "ghost" | "outline" | "muted" }) {
  return (
    <details open={open ?? true} className={cn("aui-tool-group-root group/tool rounded-[var(--radius-md)] border border-border bg-secondary/30 px-3 py-2", className)} {...props}>
      {children}
    </details>
  );
}

export function ToolGroupTrigger({ count, active, className, ...props }: ComponentProps<"summary"> & { count: number; active?: boolean }) {
  return (
    <summary className={cn("aui-tool-group-trigger flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)} {...props}>
      {active ? <LoaderIcon className="size-3.5 animate-spin" aria-hidden="true" /> : null}
      <span>{count} tool {count === 1 ? "call" : "calls"}</span>
      <ChevronDownIcon className="ml-auto size-4 transition-transform group-open/tool:rotate-180" aria-hidden="true" />
    </summary>
  );
}

export function ToolGroupContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("aui-tool-group-content mt-2 space-y-2 border-t border-border pt-2", className)} {...props} />;
}

export function ToolGroup({ children, startIndex, endIndex }: PropsWithChildren<{ startIndex: number; endIndex: number }>) {
  return (
    <ToolGroupRoot>
      <ToolGroupTrigger count={endIndex - startIndex + 1} />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
}
