import { useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { SquadState } from "@/hooks/useSquad";
import type { AgentDTO } from "@/lib/dto";
import { useProjectIssues } from "@/hooks/useTasks";
import { groupTasks } from "@/lib/projects";
import { STAGE_LABEL, stageColorVar } from "@/lib/status";
import { TaskList } from "@/components/project/TaskList";
import { TaskDetail } from "@/components/project/TaskDetail";

export function ProjectView({ repo, squad }: { repo: string; squad: SquadState }) {
  const reduce = useReducedMotion();
  const { issues, configured } = useProjectIssues(repo);
  const [taskId, setTaskId] = useState<string | null>(null);

  const features = useMemo(() => squad.features.filter((f) => f.repo === repo), [squad.features, repo]);
  const agentByIssueId = useMemo(() => {
    const m = new Map<string, AgentDTO>();
    for (const a of squad.agents) if (a.issue?.id) m.set(a.issue.id, a);
    return m;
  }, [squad.agents]);
  const { byFeature, unplanned } = useMemo(() => groupTasks(features, issues), [features, issues]);

  const name = repo.split("/").filter(Boolean).pop() ?? repo;
  const empty = features.length === 0 && issues.length === 0;
  const transition = reduce ? { duration: 0 } : { duration: 0.22, ease: [0.16, 1, 0.3, 1] as const };

  return (
    <div className="relative h-full overflow-y-auto">
      <div className="border-b border-border px-4 py-3">
        <h1 className="truncate text-sm font-semibold text-text-primary" title={repo}>
          {name}
        </h1>
        <p className="text-xs text-text-muted">
          {features.length} feature{features.length === 1 ? "" : "s"} · {issues.length} task{issues.length === 1 ? "" : "s"}
          {configured ? "" : " · Plane not configured"}
        </p>
      </div>

      {empty ? (
        <div className="p-6 text-sm text-text-muted">No features or tasks for this project yet.</div>
      ) : (
        <div className="p-2">
          {byFeature.map(({ feature, tasks }) => (
            <section key={feature.id} className="mb-3">
              <div className="flex items-center gap-2 px-2 py-1">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: stageColorVar(feature.stage) }} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{feature.title}</span>
                <span className="shrink-0 text-xs text-text-muted">{STAGE_LABEL[feature.stage]}</span>
              </div>
              <TaskList issues={tasks} agentByIssueId={agentByIssueId} selectedId={taskId} onSelect={setTaskId} />
            </section>
          ))}
          {unplanned.length > 0 ? (
            <section className="mb-3">
              <div className="px-2 py-1 text-[0.65rem] font-medium uppercase tracking-wide text-text-muted">Unplanned</div>
              <TaskList issues={unplanned} agentByIssueId={agentByIssueId} selectedId={taskId} onSelect={setTaskId} />
            </section>
          ) : null}
        </div>
      )}

      <AnimatePresence>
        {taskId ? (
          <motion.div
            key="task-detail"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={transition}
            className="absolute bottom-0 right-0 top-0 z-20 flex w-[480px] max-w-[90vw] border-l border-border bg-base shadow-[var(--shadow-float)]"
          >
            <TaskDetail repo={repo} taskId={taskId} onClose={() => setTaskId(null)} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
