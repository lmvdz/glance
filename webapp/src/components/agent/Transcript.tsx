import { Suspense, lazy, useEffect, useRef } from "react";
import type { TranscriptEntry, TranscriptKind } from "@/lib/dto";
import { cn } from "@/lib/utils";

const Markdown = lazy(() => import("./Markdown"));

// Per-kind wrapper. assistant/user/thinking render as markdown (Streamdown);
// tool/system stay monospace + pre-wrapped to preserve raw log formatting.
const WRAP: Record<TranscriptKind, string> = {
  user: "border-l-2 border-accent pl-3 text-text-primary",
  assistant: "text-text-secondary",
  thinking: "text-text-faint",
  tool: "font-mono text-xs text-text-muted",
  system: "font-mono text-xs text-text-faint",
};

export function Transcript({ entries }: { entries: TranscriptEntry[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  useEffect(() => {
    if (atBottomRef.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length]);

  if (entries.length === 0) {
    return <div className="p-4 text-sm text-text-muted">No transcript yet.</div>;
  }

  return (
    <div
      className="flex h-full flex-col gap-3 overflow-y-auto p-4"
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      <Suspense fallback={<div className="text-xs text-text-faint">Loading transcript…</div>}>
        {entries.map((e, i) => {
          const markdown = e.kind === "assistant" || e.kind === "user" || e.kind === "thinking";
          return (
            <div key={i} className={cn("text-sm leading-relaxed", WRAP[e.kind])}>
              {e.kind === "tool" || e.kind === "thinking" ? (
                <span className="mr-1.5 text-[10px] uppercase tracking-wide opacity-60">{e.kind}</span>
              ) : null}
              {markdown ? <Markdown>{e.text}</Markdown> : <span className="whitespace-pre-wrap break-words">{e.text}</span>}
            </div>
          );
        })}
      </Suspense>
      <div ref={bottomRef} />
    </div>
  );
}
