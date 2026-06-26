import { useMemo } from "react";
import { Activity, GitMerge, Network, Radio, ShieldCheck } from "lucide-react";
import type { SquadState } from "@/hooks/useSquad";
import { buildGraphModel } from "@/lib/graph-model";
import { GraphView } from "@/components/graph/GraphView";
import { DetailPanel } from "@/components/DetailPanel";
import { Button } from "@/components/ui/button";
import { MetaCard, MetaPill, MetaProgress } from "@/components/meta/MetaSurface";
import { STAGE_LABEL, agentColorVar } from "@/lib/status";

interface GraphPaneProps {
  squad: SquadState;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}

export function GraphPane({ squad, selectedId, onSelect, onClose }: GraphPaneProps) {
  const model = useMemo(() => buildGraphModel(squad.features, squad.agents), [squad.features, squad.agents]);
  const feature = selectedId ? (squad.features.find((f) => f.id === selectedId) ?? null) : null;
  const linkedAgents = feature ? (model.agentsByFeature.get(feature.id) ?? []) : squad.agents.filter((a) => a.featureId).slice(0, 3);
  const landed = squad.features.filter((f) => f.stage === "landed" || f.stage === "done").length;
  const progress = squad.features.length ? (landed / squad.features.length) * 100 : 0;

  return (
    <div className="relative h-full overflow-hidden bg-base">
      <GraphView
        model={model}
        selectedId={selectedId}
        onSelect={onSelect}
        onDeselect={onClose}
        detail={
          feature ? (
            <DetailPanel feature={feature} agents={model.agentsByFeature.get(feature.id) ?? []} onClose={onClose} />
          ) : null
        }
      />

      <MetaCard className="pointer-events-auto absolute left-3 right-3 top-3 z-10 overflow-hidden backdrop-blur md:left-3 md:right-auto md:w-[32rem]">
        <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-text-muted">
              <Network className="h-4 w-4 text-accent-light" aria-hidden="true" /> Trace graph
            </div>
            <h1 className="mt-0.5 truncate text-base font-semibold text-text-primary">
              {feature ? feature.title : "Cross-workflow dependency shell"}
            </h1>
            <p className="mt-0.5 text-[13px] text-text-secondary">
              {feature ? `${STAGE_LABEL[feature.stage]} · ${feature.repo}` : "Select a node to inspect agents, gates, and merge pressure."}
            </p>
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={onClose} disabled={!selectedId}>
            Reset trace
          </Button>
        </div>
        <div className="grid gap-2 border-t border-border p-3 sm:grid-cols-3">
          <div>
            <p className="text-xs text-text-muted">Nodes</p>
            <p className="text-xl font-semibold text-text-primary">{model.nodes.length}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">Edges</p>
            <p className="text-xl font-semibold text-text-primary">{model.edges.length}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">Landing</p>
            <MetaProgress value={progress} label={`${landed} landed`} />
          </div>
        </div>
      </MetaCard>

      <MetaCard className="pointer-events-auto absolute bottom-3 left-3 z-10 hidden w-80 overflow-hidden backdrop-blur md:block">
        <div className="border-b border-border px-3 py-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Radio className="h-4 w-4 text-done" aria-hidden="true" /> Live trace
          </div>
          <p className="mt-0.5 text-xs text-text-muted">Agent presence on selected workflow nodes.</p>
        </div>
        <div className="space-y-1.5 p-2.5">
          {linkedAgents.length > 0 ? (
            linkedAgents.map((agent) => (
              <div key={agent.id} className="rounded-[var(--radius-sm)] border border-border bg-secondary/50 p-2">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ background: agentColorVar(agent.status) }} />
                  <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{agent.name}</span>
                  <MetaPill tone={agent.status === "error" ? "danger" : agent.status === "input" ? "warn" : "neutral"}>{agent.status}</MetaPill>
                </div>
                {agent.activity ? <p className="mt-1 truncate text-xs text-text-muted">{agent.activity}</p> : null}
              </div>
            ))
          ) : (
            <p className="rounded-[var(--radius-sm)] border border-dashed border-border p-3 text-sm text-text-muted">No live agents are attached to this trace yet.</p>
          )}
        </div>
      </MetaCard>

      <div className="pointer-events-none absolute bottom-3 right-14 z-10 hidden gap-2 md:flex">
        <MetaPill tone="good"><ShieldCheck className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> proof-aware</MetaPill>
        <MetaPill tone="accent"><GitMerge className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> merge points</MetaPill>
        <MetaPill tone="neutral"><Activity className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> live</MetaPill>
      </div>
    </div>
  );
}
