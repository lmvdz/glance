import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ForceGraph } from "@/components/graph/ForceGraph";
import type { GraphModel } from "@/lib/graph-model";
import type { FeatureStage } from "@/lib/dto";
import { STAGE_LABEL, stageColorVar } from "@/lib/status";

const OVERLAY_W = 520;
const LEGEND: FeatureStage[] = ["planned", "in-progress", "review", "landed", "diverged"];

interface GraphViewProps {
  model: GraphModel;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDeselect: () => void;
  detail: ReactNode;
}

/**
 * Full-bleed force-graph with a Motion slide-over detail panel pinned right.
 * The canvas keeps its layout; selection just adds a layer (rightInset feeds
 * the camera so the focused node stays clear of the overlay).
 */
export function GraphView({ model, selectedId, onSelect, onDeselect, detail }: GraphViewProps) {
  const reduce = useReducedMotion();
  const overlayOpen = Boolean(detail && selectedId);
  const rightInset = overlayOpen ? OVERLAY_W : 0;
  const transition = reduce ? { duration: 0 } : { duration: 0.24, ease: [0.16, 1, 0.3, 1] as const };
  return (
    <div className="relative h-full w-full overflow-hidden bg-base">
      <ForceGraph
        projectId="fleet"
        tasks={model.nodes}
        edges={model.edges}
        selectedNodeId={selectedId}
        onSelectNode={onSelect}
        onDeselect={onDeselect}
        rightInset={rightInset}
        stageMap={model.stageMap}
        agentsByFeature={model.agentsByFeature}
      />
      <div className="absolute bottom-3 left-3 z-10 flex flex-col gap-1 rounded-md border border-border bg-surface/80 p-2 text-xs backdrop-blur">
        {LEGEND.map((s) => (
          <div key={s} className="flex items-center gap-1.5 text-text-muted">
            <span className="h-2 w-2 rounded-full" style={{ background: stageColorVar(s) }} />
            <span>{STAGE_LABEL[s]}</span>
          </div>
        ))}
      </div>
      <AnimatePresence>
        {overlayOpen ? (
          <motion.div
            key="detail"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={transition}
            className="absolute bottom-0 right-0 top-0 z-20 flex bg-base shadow-[var(--shadow-float)]"
            style={{ width: OVERLAY_W }}
          >
            <div className="w-px bg-gradient-to-b from-border-strong via-border to-transparent" />
            <div className="flex min-w-0 flex-1 flex-col">{detail}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
