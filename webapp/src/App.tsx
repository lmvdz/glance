import { useMemo, useState } from "react";
import { useSquad } from "@/hooks/useSquad";
import { buildGraphModel } from "@/lib/graph-model";
import { TopBar } from "@/components/layout/TopBar";
import { TwoPanelLayout } from "@/components/layout/TwoPanelLayout";
import { GraphView } from "@/components/graph/GraphView";
import { StructureView } from "@/components/structure/StructureView";
import { DetailPanel } from "@/components/DetailPanel";

type View = "structure" | "graph";

export function App() {
  const { agents, features, connected } = useSquad();
  const model = useMemo(() => buildGraphModel(features, agents), [features, agents]);
  const [view, setView] = useState<View>("graph");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selectedFeature = selectedId ? (features.find((f) => f.id === selectedId) ?? null) : null;
  const detail = selectedFeature ? (
    <DetailPanel
      feature={selectedFeature}
      agents={model.agentsByFeature.get(selectedFeature.id) ?? []}
      onClose={() => setSelectedId(null)}
    />
  ) : null;

  return (
    <div className="flex flex-col" style={{ height: "var(--viewport-height)" }}>
      <TopBar
        agents={agents}
        features={features}
        connected={connected}
        unassigned={model.unassigned.length}
        view={view}
        onView={setView}
      />
      <div className="min-h-0 flex-1">
        {view === "graph" ? (
          <GraphView
            model={model}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onDeselect={() => setSelectedId(null)}
            detail={detail}
          />
        ) : (
          <TwoPanelLayout
            activePanelHint={selectedId ? "right" : "left"}
            left={
              <StructureView
                features={features}
                agentsByFeature={model.agentsByFeature}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            }
            right={
              detail ?? (
                <div className="flex h-full items-center justify-center p-8 text-sm text-text-muted">
                  Select a feature to see details.
                </div>
              )
            }
          />
        )}
      </div>
    </div>
  );
}
