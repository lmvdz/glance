import { useMemo } from "react";
import type { SquadState } from "@/hooks/useSquad";
import { buildGraphModel } from "@/lib/graph-model";
import { GraphView } from "@/components/graph/GraphView";
import { DetailPanel } from "@/components/DetailPanel";

interface GraphPaneProps {
  squad: SquadState;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}

export function GraphPane({ squad, selectedId, onSelect, onClose }: GraphPaneProps) {
  const model = useMemo(() => buildGraphModel(squad.features, squad.agents), [squad.features, squad.agents]);
  const feature = selectedId ? (squad.features.find((f) => f.id === selectedId) ?? null) : null;
  return (
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
  );
}
