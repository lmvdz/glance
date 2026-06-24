import type { FeatureStage } from "@/lib/dto";
import { cn } from "@/lib/utils";

// The automation loop, as a breadcrumb: Plan → Tasks → Agents → Land. The active step is derived
// from the feature's stage so the operator can see where in the pipeline this feature sits.
const STEPS = ["plan", "tasks", "agents", "land"] as const;
type Step = (typeof STEPS)[number];
const LABEL: Record<Step, string> = { plan: "Plan", tasks: "Tasks", agents: "Agents", land: "Land" };
const STAGE_STEP: Record<FeatureStage, Step> = {
  planned: "plan",
  "issues-created": "tasks",
  "in-progress": "agents",
  review: "agents",
  diverged: "agents",
  landed: "land",
  done: "land",
};

export function LoopBreadcrumb({ stage, counts }: { stage: FeatureStage; counts: { concerns: number; issues: number; agents: number } }) {
  const activeIdx = STEPS.indexOf(STAGE_STEP[stage]);
  const countOf: Record<Step, number | null> = { plan: counts.concerns, tasks: counts.issues, agents: counts.agents, land: null };
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs" aria-label="automation loop">
      {STEPS.map((s, i) => {
        const cur = i === activeIdx;
        const done = i < activeIdx;
        const n = countOf[s];
        return (
          <div key={s} className="flex items-center gap-1">
            {i > 0 ? <span className="text-text-faint">→</span> : null}
            <span
              className={cn(
                "rounded px-1.5 py-0.5 tabular-nums",
                cur ? "bg-accent/15 font-medium text-accent" : done ? "text-text-secondary" : "text-text-muted",
              )}
            >
              {LABEL[s]}
              {n !== null ? ` ${n}` : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}
