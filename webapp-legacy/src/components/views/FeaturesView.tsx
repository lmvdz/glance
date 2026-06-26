import { useMemo } from "react";
import { AlertTriangle, CheckCircle2, GitBranch, Layers3, ShieldCheck, Trophy, Users, Workflow } from "lucide-react";
import type { SquadState } from "@/hooks/useSquad";
import type { AgentDTO, FeatureDTO, FeatureStage } from "@/lib/dto";
import { buildGraphModel } from "@/lib/graph-model";
import { STAGE_LABEL, agentColorVar, stageColorVar } from "@/lib/status";
import { Button } from "@/components/ui/button";
import { DetailPanel } from "@/components/DetailPanel";
import { MetaCard, MetaEmptyPanel, MetaPill, MetaProgress, MetaSectionHeader } from "@/components/meta/MetaSurface";
import { cn } from "@/lib/cn";
import { consoleHandoffHash, featureHash, fencedRouteContext } from "@/lib/routes";

interface FeaturesViewProps {
  squad: SquadState;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}

const LANES: FeatureStage[] = ["planned", "issues-created", "in-progress", "review", "landed", "done"];

function featureProgress(feature: FeatureDTO): number {
  if (feature.workflowProgress?.total) return (feature.workflowProgress.done / feature.workflowProgress.total) * 100;
  if (feature.stage === "done") return 100;
  if (feature.stage === "landed") return 88;
  if (feature.stage === "review") return 68;
  if (feature.stage === "in-progress") return 42;
  if (feature.stage === "issues-created") return 22;
  return 10;
}

function stageTone(feature: FeatureDTO): "neutral" | "good" | "warn" | "danger" | "accent" {
  if (feature.divergent || feature.blocked) return "danger";
  if (feature.stage === "done" || feature.stage === "landed") return "good";
  if (feature.stage === "review") return "accent";
  if (feature.stage === "in-progress") return "warn";
  return "neutral";
}

function FeatureTournamentCard({
  feature,
  agents,
  selected,
  onSelect,
}: {
  feature: FeatureDTO;
  agents: AgentDTO[];
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const waiting = agents.some((a) => a.status === "input" || a.status === "error") || feature.blocked || feature.divergent;
  const progress = featureProgress(feature);
  return (
    <button
      type="button"
      onClick={() => onSelect(feature.id)}
      className={cn(
        "group w-full rounded-[var(--radius-md)] border border-border bg-surface/70 p-3 text-left shadow-[var(--shadow-card)] transition-colors hover:border-border-strong hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "border-accent shadow-[var(--shadow-glow-accent)]",
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-secondary">
          {waiting ? (
            <AlertTriangle className="h-4 w-4 text-progress" aria-hidden="true" />
          ) : feature.stage === "done" || feature.stage === "landed" ? (
            <CheckCircle2 className="h-4 w-4 text-done" aria-hidden="true" />
          ) : (
            <Workflow className="h-4 w-4 text-accent-light" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-text-primary">{feature.title}</span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-text-muted">
            <span className="font-mono">{feature.repo.split("/").filter(Boolean).pop() ?? feature.repo}</span>
            {feature.workflowStage ? <span>{feature.workflowStage}</span> : null}
            {feature.planDir ? <span className="truncate font-mono">{feature.planDir}</span> : null}
          </span>
        </span>
        <MetaPill tone={stageTone(feature)}>{STAGE_LABEL[feature.stage]}</MetaPill>
      </div>
      <div className="mt-3">
        <MetaProgress
          value={progress}
          label={feature.workflowProgress ? `${feature.workflowProgress.done} / ${feature.workflowProgress.total} gates cleared` : `${Math.round(progress)}% workflow confidence`}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-text-muted">
        <span className="inline-flex items-center gap-1">
          <Users className="h-3.5 w-3.5" aria-hidden="true" />
          {agents.length || feature.agentIds.length} agent{(agents.length || feature.agentIds.length) === 1 ? "" : "s"}
        </span>
        {feature.unlandedFiles > 0 ? <span className="text-progress">{feature.unlandedFiles} unlanded files</span> : null}
        {feature.issueIdentifiers?.length ? <span>{feature.issueIdentifiers.length} issues</span> : null}
        {waiting ? <span className="text-progress">operator attention</span> : null}
      </div>
      {agents.length > 0 ? (
        <div className="mt-3 grid gap-1.5">
          {agents.slice(0, 3).map((agent) => (
            <span key={agent.id} className="flex min-w-0 items-center gap-2 rounded bg-secondary/70 px-2 py-1 text-xs text-text-secondary">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: agentColorVar(agent.status) }} />
              <span className="min-w-0 flex-1 truncate">{agent.name}</span>
              <span className="shrink-0 text-text-muted">{agent.status}</span>
            </span>
          ))}
        </div>
      ) : null}
    </button>
  );
}

export function FeaturesView({ squad, selectedId, onSelect, onClose }: FeaturesViewProps) {
  const model = useMemo(() => buildGraphModel(squad.features, squad.agents), [squad.features, squad.agents]);
  const feature = selectedId ? (squad.features.find((f) => f.id === selectedId) ?? null) : null;
  const active = squad.features.filter((f) => f.stage === "in-progress" || f.stage === "review").length;
  const cleared = squad.features.filter((f) => f.stage === "landed" || f.stage === "done").length;
  const attention = squad.features.filter((f) => f.blocked || f.divergent).length + squad.agents.filter((a) => a.status === "input" || a.status === "error").length;
  const completion = squad.features.length ? (cleared / squad.features.length) * 100 : 0;

  if (selectedId) {
    if (!feature) {
      return (
        <div className="h-full overflow-y-auto bg-base p-3">
          <MetaEmptyPanel title="Feature route not found">
            This mission is not in the live squad feed. Return to the mission board or wait for the daemon to reconnect.
          </MetaEmptyPanel>
          <Button type="button" className="mt-3" variant="secondary" onClick={onClose}>
            Back to missions
          </Button>
        </div>
      );
    }
    const agents = model.agentsByFeature.get(feature.id) ?? [];
    const context = fencedRouteContext({
      route: featureHash(feature.id),
      kind: "feature",
      featureId: feature.id,
      title: feature.title,
      repo: feature.repo,
      stage: STAGE_LABEL[feature.stage],
      workflowStage: feature.workflowStage,
      planDir: feature.planDir,
    });
    return (
      <div className="flex h-full min-h-0 flex-col bg-base">
        <div className="sticky top-0 z-10 flex items-start gap-3 border-b border-border bg-base/95 px-4 py-3 backdrop-blur">
          <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: stageColorVar(feature.stage) }} />
          <div className="min-w-0 flex-1">
            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-text-muted">Feature workspace</p>
            <h1 className="truncate text-base font-semibold text-text-primary">{feature.title}</h1>
            <p className="mt-0.5 truncate text-xs text-text-muted">{feature.repo}</p>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <a
              href={consoleHandoffHash(context)}
              className="inline-flex min-h-8 items-center justify-center rounded-[var(--radius-sm)] border border-border bg-secondary px-2.5 text-[length:var(--text-13)] text-foreground transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Open in Control Tower
            </a>
            <Button type="button" variant="secondary" onClick={onClose}>
              All missions
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 p-3">
          <div className="h-full overflow-hidden rounded-[var(--radius-md)] border border-border bg-surface">
            <DetailPanel
              feature={feature}
              agents={agents}
              onClose={onClose}
              onAnswer={(agentId, requestId, value) => squad.send({ type: "answer", id: agentId, requestId, value })}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full overflow-hidden bg-base">
      <div className="h-full overflow-y-auto p-3">
        <MetaCard className="mb-3 overflow-hidden">
          <MetaSectionHeader
            eyebrow="Feature tournament"
            title="Fleet workflows"
            action={
              <Button type="button" size="sm" variant="secondary" onClick={onClose} disabled={!feature}>
                Clear selection
              </Button>
            }
          >
            Track every promoted goal as a bracket: plan gates, active agents, review pressure, and landing readiness.
          </MetaSectionHeader>
          <div className="grid gap-2 p-3 sm:grid-cols-3">
            <div className="rounded-[var(--radius-sm)] border border-border bg-secondary/50 p-2.5">
              <div className="flex items-center gap-2 text-xs text-text-muted"><Trophy className="h-4 w-4 text-done" aria-hidden="true" />Cleared</div>
              <p className="mt-1 text-xl font-semibold text-text-primary">{cleared}</p>
              <MetaProgress value={completion} label={`${Math.round(completion)}% complete`} />
            </div>
            <div className="rounded-[var(--radius-sm)] border border-border bg-secondary/50 p-2.5">
              <div className="flex items-center gap-2 text-xs text-text-muted"><Layers3 className="h-4 w-4 text-accent-light" aria-hidden="true" />Active lanes</div>
              <p className="mt-1 text-xl font-semibold text-text-primary">{active}</p>
              <p className="mt-0.5 text-xs text-text-muted">In progress or review.</p>
            </div>
            <div className="rounded-[var(--radius-sm)] border border-border bg-secondary/50 p-2.5">
              <div className="flex items-center gap-2 text-xs text-text-muted"><ShieldCheck className="h-4 w-4 text-progress" aria-hidden="true" />Needs operator</div>
              <p className="mt-1 text-xl font-semibold text-text-primary">{attention}</p>
              <p className="mt-0.5 text-xs text-text-muted">Conflicts, gates, or inputs.</p>
            </div>
          </div>
        </MetaCard>

        {squad.features.length === 0 ? (
          <MetaEmptyPanel title="No feature workflows yet">Spawn an agent or add a plans/ directory and the tournament board will populate here.</MetaEmptyPanel>
        ) : (
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {LANES.map((lane) => {
                const items = squad.features.filter((f) => f.stage === lane);
                if (items.length === 0) return null;
                return (
                  <MetaCard key={lane} className="overflow-hidden">
                    <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                      <span className="h-2 w-2 rounded-full" style={{ background: stageColorVar(lane) }} />
                      {STAGE_LABEL[lane]}
                      <span className="text-text-faint">{items.length}</span>
                    </div>
                    <div className="grid gap-1.5 p-1.5">
                      {items.map((f) => (
                        <FeatureTournamentCard key={f.id} feature={f} agents={model.agentsByFeature.get(f.id) ?? []} selected={selectedId === f.id} onSelect={onSelect} />
                      ))}
                    </div>
                  </MetaCard>
                );
              })}
            </div>
            <MetaCard className="h-fit overflow-hidden">
              <MetaSectionHeader eyebrow="Trace lane" title="Merge path">
                Ordered from the live feature list; selecting a row opens the feature workspace route.
              </MetaSectionHeader>
              <div className="space-y-2 p-2.5">
                {squad.features.slice(0, 4).map((f, index) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => onSelect(f.id)}
                    className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] border border-border bg-secondary/40 px-2.5 py-1.5 text-left hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border text-xs text-text-secondary">{index + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-text-primary">{f.title}</span>
                      <span className="text-xs text-text-muted">{STAGE_LABEL[f.stage]}</span>
                    </span>
                    <GitBranch className="h-4 w-4 text-text-muted" aria-hidden="true" />
                  </button>
                ))}
              </div>
            </MetaCard>
          </div>
        )}
      </div>

    </div>
  );
}
