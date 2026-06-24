import { useState } from "react";
import type { PendingRequest } from "@/lib/dto";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Inline answer controls for one pending human-input request, keyed by kind:
 * confirm / host-tool -> approve|deny; select -> one button per option;
 * input -> text field; editor -> textarea. Submitting calls `onAnswer(value)`.
 */
export function AnswerControls({ request, onAnswer }: { request: PendingRequest; onAnswer: (value: string) => void }) {
  const [text, setText] = useState("");

  if (request.kind === "confirm" || request.source === "tool") {
    return (
      <div className="flex gap-2">
        <Button variant="primary" size="sm" onClick={() => onAnswer("yes")}>
          Approve
        </Button>
        <Button variant="danger" size="sm" onClick={() => onAnswer("no")}>
          Deny
        </Button>
      </div>
    );
  }

  if (request.kind === "select" && request.options && request.options.length > 0) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {request.options.map((o) => (
          <Button key={o} variant="secondary" size="sm" onClick={() => onAnswer(o)}>
            {o}
          </Button>
        ))}
      </div>
    );
  }

  return (
    <form
      className="flex items-start gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onAnswer(text);
      }}
    >
      {request.kind === "editor" ? (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={request.placeholder}
          rows={3}
          className="min-h-[40px] flex-1 rounded-[var(--radius-sm)] border border-border bg-secondary px-3 py-1.5 text-sm text-text-1 outline-none focus:border-accent"
        />
      ) : (
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={request.placeholder ?? "Type a reply"} />
      )}
      <Button type="submit" variant="primary" size="sm">
        Send
      </Button>
    </form>
  );
}
