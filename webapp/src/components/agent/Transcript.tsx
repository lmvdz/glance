import { useEffect, useRef } from "react";
import type { TranscriptEntry, TranscriptKind } from "@/lib/dto";
import { cn } from "@/lib/utils";

const KIND_STYLE: Record<TranscriptKind, string> = {
  user: "border-l-2 border-accent pl-2 text-text-primary",
  assistant: "text-text-secondary",
  thinking: "italic text-text-faint",
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
      className="flex h-full flex-col gap-2 overflow-y-auto p-4"
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {entries.map((e, i) => (
        <div
          key={i}
          className={cn("whitespace-pre-wrap break-words text-sm leading-relaxed", KIND_STYLE[e.kind])}
        >
          {e.kind === "tool" || e.kind === "thinking" ? (
            <span className="mr-1.5 uppercase opacity-60">{e.kind}</span>
          ) : null}
          {e.text}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
