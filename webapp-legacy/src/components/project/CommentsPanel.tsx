import { useState } from "react";
import { cn } from "@/lib/utils";
import { useComments } from "@/hooks/useComments";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Review thread on a subject (a task's Plane identifier) — "review the plan, not the diff". Operators
 * leave feedback before the work is dispatched; Slice 2 feeds unresolved comments into the next phase.
 */
export function CommentsPanel({ repo, subject }: { repo: string; subject: string }) {
  const { comments, add, resolve } = useComments(repo, subject);
  const [draft, setDraft] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const openCount = comments.filter((c) => c.resolvedAt === undefined).length;

  const submit = async (): Promise<void> => {
    if (!draft.trim()) return;
    setBusy(true);
    const ok = await add(draft.trim(), urgent);
    setBusy(false);
    if (ok) {
      setDraft("");
      setUrgent(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Review</CardTitle>
        {openCount > 0 ? <span className="text-text-muted">{openCount} open</span> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {comments.length === 0 ? <p className="text-xs text-text-muted">No comments yet — leave review feedback before this work is dispatched.</p> : null}
        {comments.map((c) => (
          <div key={c.id} className={cn("rounded-md border border-border p-2", c.resolvedAt !== undefined && "opacity-50")}>
            <div className="mb-0.5 flex items-center gap-2 text-xs">
              <span className="font-medium text-text-secondary">{c.author}</span>
              {c.urgent ? <span style={{ color: "var(--color-cancelled)" }}>urgent</span> : null}
              <span className="flex-1" />
              {c.resolvedAt === undefined ? (
                <button type="button" onClick={() => void resolve(c.id)} className="text-text-muted hover:text-text-primary">
                  resolve
                </button>
              ) : (
                <span className="text-text-muted">resolved</span>
              )}
            </div>
            <p className="whitespace-pre-wrap break-words text-sm text-text-primary">{c.body}</p>
          </div>
        ))}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder="Leave review feedback…"
          className="w-full rounded-[var(--radius-sm)] border border-border bg-secondary px-2 py-1.5 text-sm text-text-1 outline-none focus:border-accent"
        />
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-1.5 text-xs text-text-muted">
            <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
            urgent
          </label>
          <Button size="sm" variant="primary" disabled={busy || !draft.trim()} onClick={() => void submit()}>
            {busy ? "…" : "Comment"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
