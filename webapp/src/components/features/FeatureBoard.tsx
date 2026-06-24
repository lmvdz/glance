import type { AgentDTO, FeatureDTO, FeatureStage } from "@/lib/dto";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { STAGE_LABEL, stageColorVar } from "@/lib/status";

const LANES: FeatureStage[] = ["planned", "issues-created", "in-progress", "review", "landed", "done"];
const ALWAYS: FeatureStage[] = ["in-progress", "review"];

interface FeatureBoardProps {
  features: FeatureDTO[];
  agentsByFeature: Map<string, AgentDTO[]>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function FeatureBoard({ features, agentsByFeature, selectedId, onSelect }: FeatureBoardProps) {
  if (features.length === 0) {
    return (
      <div className="p-3">
        <EmptyState title="No features yet">Spawn an agent or add a plans/ directory and work shows up here.</EmptyState>
      </div>
    );
  }
  return (
    <div className="flex h-full gap-3 overflow-x-auto p-3">
      {LANES.map((lane) => {
        const items = features.filter((f) => f.stage === lane);
        if (items.length === 0 && !ALWAYS.includes(lane)) return null;
        return (
          <div key={lane} className="flex w-64 shrink-0 flex-col gap-2">
            <div className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
              <span className="h-2 w-2 rounded-full" style={{ background: stageColorVar(lane) }} />
              {STAGE_LABEL[lane]}
              <span className="text-text-faint">{items.length}</span>
            </div>
            {items.map((f) => {
              const ags = agentsByFeature.get(f.id) ?? [];
              const waiting = ags.some((a) => a.status === "input" || a.status === "error");
              return (
                <Card
                  key={f.id}
                  onClick={() => onSelect(f.id)}
                  className={cn("cursor-pointer p-2.5 hover:border-border-strong", selectedId === f.id && "border-accent")}
                >
                  <div className="text-sm text-text-1">{f.title}</div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-text-3">
                    {ags.length > 0 ? <span>{ags.length} agent{ags.length === 1 ? "" : "s"}</span> : null}
                    {f.unlandedFiles > 0 ? <span style={{ color: "var(--color-progress)" }}>{f.unlandedFiles} unlanded</span> : null}
                    {waiting ? <span style={{ color: "var(--color-progress)" }}>needs you</span> : null}
                    {f.divergent ? <span style={{ color: "var(--color-cancelled)" }}>diverged</span> : null}
                  </div>
                </Card>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
