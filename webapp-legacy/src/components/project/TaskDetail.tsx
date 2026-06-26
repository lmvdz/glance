import { useEffect, useState } from "react";
import { CheckCircle2, Circle, ExternalLink, ShieldCheck, X } from "lucide-react";
import type { TaskDetail as TaskDetailDTO } from "@/lib/dto";
import { apiGet, apiPost } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SkeletonRow } from "@/components/ui/skeleton";
import { CommentsPanel } from "@/components/project/CommentsPanel";
import type { SquadState } from "@/hooks/useSquad";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { Transcript } from "@/components/agent/Transcript";
import { AnswerControls } from "@/components/agent/AnswerControls";
import { consoleHandoffHash, fencedRouteContext, taskHash } from "@/lib/routes";

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
// as preserved-whitespace blocks. ponytail: <pre> over a markdown renderer; add rich rendering only when needed.
function Pre({ children }: { children: string }) {
  return <pre className="whitespace-pre-wrap break-words font-mono text-xs text-text-secondary">{children}</pre>;
}

export function TaskDetail({ repo, taskId, onClose, squad }: { repo: string; taskId: string; onClose: () => void; squad: SquadState }) {
  const [task, setTask] = useState<TaskDetailDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();
  const [starting, setStarting] = useState(false);
  const agent = squad.agents.find((a) => a.issue !== undefined && (a.issue.id === taskId || (task?.identifier !== undefined && a.issue.identifier === task.identifier)));

  useEffect(() => {
    if (agent) squad.subscribe(agent.id);
  }, [agent?.id, squad.subscribe]);

  const start = async (): Promise<void> => {
    setStarting(true);
    const r = await apiPost<{ agentId: string }>(`/api/tasks/${encodeURIComponent(taskId)}/start`, { repo });
    setStarting(false);
    toast({ title: r ? "Agent started" : "Start failed", tone: r ? "success" : "danger" });
  };

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

  const handoffContext = fencedRouteContext({
    route: taskHash(repo, taskId),
    kind: "task",
    repo,
    taskId,
    identifier: task?.identifier,
    name: task?.name,
    state: task?.state,
    priority: task?.priority,
  });

  return (
    <div className="flex h-full w-full flex-col bg-base">
      <div className="sticky top-0 z-10 flex items-start gap-2 border-b border-border bg-base/95 px-4 py-3 backdrop-blur">
        <div className="min-w-0 flex-1">
          {task?.identifier ? <div className="font-mono text-xs text-text-muted">{task.identifier}</div> : null}
          <h2 className="truncate text-sm font-semibold text-text-primary">{task?.name ?? (loading ? "Loading…" : "Task")}</h2>
        </div>
        {task?.state ? <Badge tone={STATE_TONE[task.state] ?? "neutral"}>{task.state}</Badge> : null}
        <a href={consoleHandoffHash(handoffContext)} className="shrink-0 rounded-[var(--radius-sm)] border border-border bg-secondary px-2 py-1 text-xs text-foreground hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Control Tower
        </a>
        {task?.url ? <a href={task.url} target="_blank" rel="noreferrer" className="shrink-0 rounded px-1 py-1 text-xs text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Plane ↗</a> : null}
        <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 rounded p-1 text-text-muted hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
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
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
            <main className="min-w-0 space-y-3">
              {agent ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Agent · {agent.status}</CardTitle>
                    {agent.activity ? <span className="ml-2 min-w-0 truncate normal-case text-text-muted">{agent.activity}</span> : null}
                  </CardHeader>
                  <CardContent className="flex flex-col p-0">
                    {agent.pending.map((req) => (
                      <div key={req.id} className="border-b border-border p-3">
                        <div className="mb-1 text-sm font-medium text-text-primary">{req.title}</div>
                        <AnswerControls request={req} onAnswer={(v) => squad.send({ type: "answer", id: agent.id, requestId: req.id, value: v })} />
                      </div>
                    ))}
                    <div className="h-72 border-t border-border">
                      <Transcript entries={squad.transcripts.get(agent.id) ?? []} agent={agent} squad={squad} />
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <div className="flex items-center justify-between rounded-md border border-border bg-surface p-3">
                  <span className="text-sm text-text-secondary">No agent on this task yet.</span>
                  <Button variant="primary" size="sm" disabled={starting} onClick={() => void start()}>
                    {starting ? "Starting…" : "▶ Start agent"}
                  </Button>
                </div>
              )}

              {task.tier2.description || task.body ? (
                <section className="rounded-md border border-border bg-surface p-3">
                  <h3 className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-text-muted">Description</h3>
                  <p className="whitespace-pre-wrap break-words text-sm text-text-secondary">{task.tier2.description || task.body}</p>
                </section>
              ) : null}

              {task.tier2.acceptanceCriteria ? (
                <Card>
                  <CardHeader><CardTitle>Acceptance criteria</CardTitle></CardHeader>
                  <CardContent><Pre>{task.tier2.acceptanceCriteria}</Pre></CardContent>
                </Card>
              ) : null}

              {task.tier2.scope || task.tier2.verification || task.blockedBy.length > 0 ? (
                <Card>
                  <CardHeader><CardTitle>Context bundle</CardTitle></CardHeader>
                  <CardContent className="grid gap-3 md:grid-cols-2">
                    {task.tier2.scope ? <div><div className="mb-1 text-[0.65rem] uppercase tracking-wide text-text-muted">Scope</div><Pre>{task.tier2.scope}</Pre></div> : null}
                    {task.tier2.verification ? <div><div className="mb-1 text-[0.65rem] uppercase tracking-wide text-text-muted">Verification</div><Pre>{task.tier2.verification}</Pre></div> : null}
                    {task.blockedBy.length > 0 ? (
                      <div>
                        <div className="mb-1 text-[0.65rem] uppercase tracking-wide text-text-muted">Blocked by</div>
                        <ul className="list-inside list-disc text-xs text-text-secondary">
                          {task.blockedBy.map((b) => <li key={b} className="font-mono">{b}</li>)}
                        </ul>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              ) : null}

              <CommentsPanel repo={repo} subject={task.identifier ?? task.id} />
            </main>

            <aside className="space-y-3 xl:sticky xl:top-3 xl:self-start">
              <Card>
                <CardHeader><CardTitle>Properties</CardTitle></CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="flex items-center justify-between gap-3"><span className="text-text-muted">Status</span>{task.state ? <Badge tone={STATE_TONE[task.state] ?? "neutral"}>{task.state}</Badge> : <span className="text-text-secondary">—</span>}</div>
                  <div className="flex items-center justify-between gap-3"><span className="text-text-muted">Priority</span>{task.priority ? <Badge tone={PRIORITY_TONE[task.priority] ?? "neutral"}>{task.priority}</Badge> : <span className="text-text-secondary">—</span>}</div>
                  <div className="flex items-center justify-between gap-3"><span className="text-text-muted">Agent</span><span className="truncate text-text-secondary">{agent ? `${agent.name} · ${agent.status}` : "Unassigned"}</span></div>
                  <div className="flex items-center justify-between gap-3"><span className="text-text-muted">Repo</span><span className="truncate font-mono text-xs text-text-secondary">{repo}</span></div>
                  <div>
                    <div className="mb-1 text-text-muted">Labels</div>
                    <div className="flex flex-wrap gap-1.5">{task.labels.length ? task.labels.map((label) => <Badge key={label} tone="neutral">{label}</Badge>) : <span className="text-text-secondary">None</span>}</div>
                  </div>
                  {task.url ? <a href={task.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">Open in Plane <ExternalLink className="h-3.5 w-3.5" /></a> : null}
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle>Landing checklist</CardTitle></CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {[
                    ["Description", Boolean(task.tier2.description || task.body)],
                    ["Acceptance", Boolean(task.tier2.acceptanceCriteria)],
                    ["Scope", Boolean(task.tier2.scope)],
                    ["Verification", Boolean(task.tier2.verification)],
                    ["Unblocked", task.blockedBy.length === 0],
                  ].map(([label, ok]) => (
                    <div key={String(label)} className="flex items-center gap-2 text-text-secondary">
                      {ok ? <CheckCircle2 className="h-4 w-4 text-done" /> : <Circle className="h-4 w-4 text-text-muted" />}
                      <span>{label}</span>
                    </div>
                  ))}
                  <div className="mt-3 rounded-md border border-border bg-secondary/60 p-2 text-xs text-text-muted"><ShieldCheck className="mr-1 inline h-3.5 w-3.5 text-done" />Land only after the repo gate passes.</div>
                </CardContent>
              </Card>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
