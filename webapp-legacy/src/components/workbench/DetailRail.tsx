import { Activity, Bot, ChevronRight, ClipboardList, GitBranch, PanelRightClose, Settings } from "lucide-react";
import type { SquadState } from "@/hooks/useSquad";
import type { View } from "@/components/layout/Sidebar";
import type { Project } from "@/lib/projects";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface DetailRailProps {
  squad: SquadState;
  view: View;
  selectedId: string | null;
  projects: Project[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PAGE_COPY: Partial<Record<View, { title: string; detail: string }>> = {
  console: { title: "Control Tower", detail: "Spawn, steer, interrupt, and inspect agents without leaving the workbench." },
  heatmap: { title: "Context heat", detail: "Select hot files to turn repeated churn into scout work and refactors." },
  audit: { title: "Audit provenance", detail: "Append-only daemon records, exportable as JSON from the observer page." },
  network: { title: "Federation", detail: "Labels federation registry, local roster fallback, and DB-registry-hidden presence honestly." },
  profiles: { title: "Profiles", detail: "Profiles come from /api/profiles and are cross-referenced with live agent profileId values." },
  tournaments: { title: "Best-of-N", detail: "Promotion bracket controls stay hidden until backed by daemon APIs." },
  observability: { title: "Observability", detail: "Heatmap, trace, audit, fleet health, and resource signals share one diagnostics surface." },
  governance: { title: "Governance", detail: "Shows configured versus missing daemon capabilities without fake local save controls." },
  settings: { title: "Settings", detail: "Local UI preferences are live; daemon settings are read-only until config APIs land." },
  conflicts: { title: "Conflict resolver", detail: "Diverged or blocked work appears here; resolution actions require daemon support." },
  onboarding: { title: "Onboarding", detail: "First-run checklist for repo, profile, and initial agent setup." },
};

function repoName(repo: string): string {
  return repo.split("/").filter(Boolean).pop() ?? repo;
}

export function DetailRail({ squad, view, selectedId, projects, open, onOpenChange }: DetailRailProps) {
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className="hidden w-8 shrink-0 items-center justify-center border-l border-border bg-base-2 text-text-muted hover:text-text-primary xl:flex"
        aria-label="Open detail rail"
      >
        <ChevronRight className="size-4 rotate-180" aria-hidden="true" />
      </button>
    );
  }

  const agent = selectedId ? squad.agents.find((a) => a.id === selectedId) : null;
  const feature = selectedId ? squad.features.find((f) => f.id === selectedId) : null;
  const project = view === "project" && selectedId ? projects.find((p) => p.repo === selectedId) : null;
  const page = PAGE_COPY[view];

  return (
    <aside className="hidden shrink-0 flex-col border-l border-border bg-base-2/95 xl:flex" style={{ width: "var(--rail-w)" }} aria-label="Detail rail">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-text-muted">Detail</div>
          <div className="truncate text-sm font-semibold text-text-primary">
            {agent?.name ?? feature?.title ?? project?.name ?? page?.title ?? "Workbench"}
          </div>
        </div>
        <Button type="button" variant="ghost" size="icon" onClick={() => onOpenChange(false)} aria-label="Collapse detail rail">
          <PanelRightClose className="size-4" aria-hidden="true" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-[13px]">
        {agent ? (
          <section className="rounded-[var(--radius-md)] border border-border bg-surface p-3">
            <div className="mb-3 flex items-center gap-2">
              <Bot className="size-4 text-accent" aria-hidden="true" />
              <h2 className="font-semibold text-text-primary">Agent</h2>
              <Badge tone={agent.status === "error" ? "danger" : agent.status === "input" ? "warning" : agent.status === "working" ? "success" : "neutral"}>{agent.status}</Badge>
            </div>
            <dl className="space-y-2 text-text-secondary">
              <div><dt className="text-text-muted">Repo</dt><dd className="truncate text-text-primary">{repoName(agent.repo)}</dd></div>
              <div><dt className="text-text-muted">Branch</dt><dd className="truncate">{agent.branch ?? "not reported"}</dd></div>
              <div><dt className="text-text-muted">Model</dt><dd>{agent.model ?? "not reported"}</dd></div>
              <div><dt className="text-text-muted">Activity</dt><dd className="line-clamp-3">{agent.activity ?? agent.todo?.active ?? "idle"}</dd></div>
            </dl>
          </section>
        ) : feature ? (
          <section className="rounded-[var(--radius-md)] border border-border bg-surface p-3">
            <div className="mb-3 flex items-center gap-2">
              <ClipboardList className="size-4 text-accent" aria-hidden="true" />
              <h2 className="font-semibold text-text-primary">Mission</h2>
              <Badge tone={feature.stage === "diverged" ? "danger" : feature.stage === "review" ? "warning" : feature.stage === "done" || feature.stage === "landed" ? "success" : "neutral"}>{feature.stage}</Badge>
            </div>
            <p className="line-clamp-4 text-text-secondary">{feature.workflowStage ?? feature.planDir ?? "No workflow detail in daemon payload."}</p>
            <div className="mt-3 rounded-[var(--radius-sm)] border border-border bg-secondary/50 p-2 font-mono text-xs text-text-muted">{feature.repo}</div>
          </section>
        ) : project ? (
          <section className="rounded-[var(--radius-md)] border border-border bg-surface p-3">
            <div className="mb-3 flex items-center gap-2">
              <GitBranch className="size-4 text-accent" aria-hidden="true" />
              <h2 className="font-semibold text-text-primary">Project</h2>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded border border-border p-2"><div className="text-lg text-text-primary">{project.agentCount}</div><div className="text-[11px] text-text-muted">agents</div></div>
              <div className="rounded border border-border p-2"><div className="text-lg text-text-primary">{project.featureCount}</div><div className="text-[11px] text-text-muted">missions</div></div>
              <div className="rounded border border-border p-2"><div className="text-lg text-text-primary">{project.waiting}</div><div className="text-[11px] text-text-muted">waiting</div></div>
            </div>
          </section>
        ) : (
          <section className="rounded-[var(--radius-md)] border border-border bg-surface p-3">
            <div className="mb-2 flex items-center gap-2">
              {view === "settings" ? <Settings className="size-4 text-accent" aria-hidden="true" /> : <Activity className="size-4 text-accent" aria-hidden="true" />}
              <h2 className="font-semibold text-text-primary">{page?.title ?? "No item selected"}</h2>
            </div>
            <p className="leading-relaxed text-text-secondary">{page?.detail ?? "Select an agent, mission, project, task, diff, or setting to inspect details here."}</p>
          </section>
        )}

        <section className="rounded-[var(--radius-md)] border border-border bg-surface p-3">
          <div className="mb-2 text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-text-muted">Live rollup</div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded border border-border p-2"><div className="text-lg text-text-primary">{squad.agents.length}</div><div className="text-[11px] text-text-muted">agents</div></div>
            <div className="rounded border border-border p-2"><div className="text-lg text-text-primary">{squad.features.length}</div><div className="text-[11px] text-text-muted">missions</div></div>
            <div className="rounded border border-border p-2"><div className="text-lg text-text-primary">{projects.length}</div><div className="text-[11px] text-text-muted">repos</div></div>
          </div>
        </section>
      </div>
    </aside>
  );
}
