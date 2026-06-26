import { memo, useState, type ComponentProps } from "react";
import { AlertCircleIcon, CheckIcon, ChevronDownIcon, LoaderIcon, XCircleIcon } from "lucide-react";
import type { ToolCallMessagePartComponent, ToolCallMessagePartStatus } from "@assistant-ui/react";
import { cn } from "@/lib/utils";

function iconFor(status?: ToolCallMessagePartStatus) {
  if (status?.type === "running") return LoaderIcon;
  if (status?.type === "requires-action") return AlertCircleIcon;
  if (status?.type === "incomplete") return XCircleIcon;
  return CheckIcon;
}

export function ToolFallbackRoot({ className, children, open, ...props }: ComponentProps<"details">) {
  return (
    <details open={open ?? true} className={cn("aui-tool-fallback-root group/tool-fallback", className)} {...props}>
      {children}
    </details>
  );
}

export function ToolFallbackTrigger({ toolName, status, className, ...props }: ComponentProps<"summary"> & { toolName: string; status?: ToolCallMessagePartStatus }) {
  const Icon = iconFor(status);
  const running = status?.type === "running";
  return (
    <summary className={cn("aui-tool-fallback-trigger flex cursor-pointer list-none items-center gap-2 py-1 text-sm text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)} {...props}>
      <Icon className={cn("size-4", running && "animate-spin")} aria-hidden="true" />
      <span>{status?.type === "requires-action" ? "Needs input" : "Used tool"}: <b>{toolName}</b></span>
      <ChevronDownIcon className="size-4 transition-transform group-open/tool-fallback:rotate-180" aria-hidden="true" />
    </summary>
  );
}

export function ToolFallbackContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("aui-tool-fallback-content space-y-2 pl-6 text-xs", className)} {...props} />;
}

export function ToolFallbackArgs({ argsText, className }: { argsText?: string; className?: string }) {
  if (!argsText) return null;
  return <pre className={cn("rounded-[var(--radius-sm)] border border-border bg-base p-2 text-text-secondary whitespace-pre-wrap", className)}>{argsText}</pre>;
}

export function ToolFallbackResult({ result }: { result?: unknown }) {
  if (result === undefined) return null;
  return <pre className="rounded-[var(--radius-sm)] border border-border bg-base p-2 text-text-secondary whitespace-pre-wrap">{typeof result === "string" ? result : JSON.stringify(result, null, 2)}</pre>;
}

const ToolFallbackImpl: ToolCallMessagePartComponent = ({ toolName, argsText, result, status }) => {
  const [open, setOpen] = useState(status?.type === "requires-action");
  return (
    <ToolFallbackRoot open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <ToolFallbackTrigger toolName={toolName} status={status} />
      <ToolFallbackContent>
        <ToolFallbackArgs argsText={argsText} />
        <ToolFallbackResult result={result} />
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
};

export const ToolFallback = memo(ToolFallbackImpl) as ToolCallMessagePartComponent;
