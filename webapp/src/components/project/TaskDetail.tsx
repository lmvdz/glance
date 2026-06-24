import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { TaskDetail as TaskDetailDTO } from "@/lib/dto";
import { apiGet } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SkeletonRow } from "@/components/ui/skeleton";
import { CommentsPanel } from "@/components/project/CommentsPanel";

type Tone = "success" | "warning" | "attention" | "danger" | "accent" | "neutral";

const STATE_TONE: Record<string, Tone> = {
  completed: "success",
  started: "accent",
  unstarted: "neutral",
  backlog: "neutral",
  cancelled: "danger",
};
const PRIORITY_TONE: Record<string, Tone> = {
  urgent: "danger",
  high: "attention",
  medium: "warning",
  low: "neutral",
};

// The parsed Tier-2 sections are already plain text (tags stripped in src/tier2.ts), so render them
// as preserved-whitespace blocks — keeps commands/lists intact without pulling Shiki/Markdown into
// the main bundle. ponytail: <pre> over a markdown renderer; swap to the lazy Markdown component if
// rich rendering is ever wanted here.
function Pre({ children }: { children: string }) {
  return <pre className="whitespace-pre-wrap break-words font-mono text-xs text-text-secondary">{children}</pre>;
}

export function TaskDetail({ repo, taskId, onClose }: { repo: string; taskId: string; onClose: () => void }) {
  const [task, setTask] = useState<TaskDetailDTO | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setTask(null);
    void apiGet<TaskDetailDTO>(`/api/tasks/${encodeURIComponent(taskId)}?repo=${encodeURIComponent(repo)}`).then((t) => {
      if (!alive) return;
      setTask(t);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [repo, taskId]);

  const ctx = task && (task.tier2.scope || task.tier2.verification || task.blockedBy.length > 0);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-start gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          {task?.identifier ? <div className="font-mono text-xs text-text-muted">{task.identifier}</div> : null}
          <h2 className="truncate text-sm font-semibold text-text-primary">{task?.name ?? (loading ? "Loading…" : "Task")}</h2>
        </div>
        {task?.url ? (
          <a href={task.url} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-accent hover:underline">
            Plane ↗
          </a>
        ) : null}
        <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 rounded p-1 text-text-muted hover:bg-surface-hover hover:text-text-primary">
          <X size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading ? (
          <>
            <SkeletonRow className="w-1/2" />
            <SkeletonRow />
            <SkeletonRow />
          </>
        ) : !task ? (
          <p className="text-sm text-text-muted">Task unavailable (Plane not configured or issue not found).</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {task.state ? <Badge tone={STATE_TONE[task.state] ?? "neutral"}>{task.state}</Badge> : null}
              {task.priority ? <Badge tone={PRIORITY_TONE[task.priority] ?? "neutral"}>{task.priority}</Badge> : null}
              {task.labels.map((l) => (
                <Badge key={l} tone="neutral">
                  {l}
                </Badge>
              ))}
              {task.blockedBy.length > 0 ? <Badge tone="warning">blocked ×{task.blockedBy.length}</Badge> : null}
            </div>

            {task.tier2.description || task.body ? (
              <section>
                <h3 className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-text-muted">Description</h3>
                <p className="whitespace-pre-wrap break-words text-sm text-text-secondary">{task.tier2.description || task.body}</p>
              </section>
            ) : null}

            {task.tier2.acceptanceCriteria ? (
              <Card>
                <CardHeader>
                  <CardTitle>Acceptance criteria</CardTitle>
                </CardHeader>
                <CardContent>
                  <Pre>{task.tier2.acceptanceCriteria}</Pre>
                </CardContent>
              </Card>
            ) : null}

            {ctx ? (
              <Card>
                <CardHeader>
                  <CardTitle>Context bundle</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {task.tier2.scope ? (
                    <div>
                      <div className="mb-1 text-[0.65rem] uppercase tracking-wide text-text-muted">Scope</div>
                      <Pre>{task.tier2.scope}</Pre>
                    </div>
                  ) : null}
                  {task.tier2.verification ? (
                    <div>
                      <div className="mb-1 text-[0.65rem] uppercase tracking-wide text-text-muted">Verification</div>
                      <Pre>{task.tier2.verification}</Pre>
                    </div>
                  ) : null}
                  {task.blockedBy.length > 0 ? (
                    <div>
                      <div className="mb-1 text-[0.65rem] uppercase tracking-wide text-text-muted">Blocked by</div>
                      <ul className="list-inside list-disc text-xs text-text-secondary">
                        {task.blockedBy.map((b) => (
                          <li key={b} className="font-mono">
                            {b}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            ) : null}

            <CommentsPanel repo={repo} subject={task.identifier ?? task.id} />
          </div>
        )}
      </div>
    </div>
  );
}
