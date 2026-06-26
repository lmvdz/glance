import { memo, type ComponentProps } from "react";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import type { ReasoningMessagePartComponent } from "@assistant-ui/react";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { cn } from "@/lib/utils";

export function ReasoningRoot({ className, children, open, ...props }: ComponentProps<"details"> & { streaming?: boolean }) {
  return (
    <details open={open ?? true} className={cn("aui-reasoning-root group/reasoning rounded-[var(--radius-md)] border border-border bg-secondary/40 px-3 py-2", className)} {...props}>
      {children}
    </details>
  );
}

export function ReasoningTrigger({ active, className, ...props }: ComponentProps<"summary"> & { active?: boolean }) {
  return (
    <summary className={cn("aui-reasoning-trigger flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)} {...props}>
      <BrainIcon className={cn("size-4", active && "animate-pulse")} aria-hidden="true" />
      <span>{active ? "Reasoning…" : "Reasoning"}</span>
      <ChevronDownIcon className="ml-auto size-4 transition-transform group-open/reasoning:rotate-180" aria-hidden="true" />
    </summary>
  );
}

export function ReasoningContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("aui-reasoning-content mt-2 border-t border-border pt-2 text-text-secondary", className)} {...props} />;
}

export function ReasoningText({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("aui-reasoning-text", className)} {...props} />;
}

const ReasoningImpl: ReasoningMessagePartComponent = () => <MarkdownText />;
export const Reasoning = memo(ReasoningImpl) as ReasoningMessagePartComponent;
