import { useMemo } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { SquadState } from "@/hooks/useSquad";
import { buildGraphModel } from "@/lib/graph-model";
import { FeatureBoard } from "@/components/features/FeatureBoard";
import { DetailPanel } from "@/components/DetailPanel";

interface FeaturesViewProps {
  squad: SquadState;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}

export function FeaturesView({ squad, selectedId, onSelect, onClose }: FeaturesViewProps) {
  const reduce = useReducedMotion();
  const model = useMemo(() => buildGraphModel(squad.features, squad.agents), [squad.features, squad.agents]);
  const feature = selectedId ? (squad.features.find((f) => f.id === selectedId) ?? null) : null;
  const transition = reduce ? { duration: 0 } : { duration: 0.22, ease: [0.16, 1, 0.3, 1] as const };
  return (
    <div className="relative h-full">
      <FeatureBoard
        features={squad.features}
        agentsByFeature={model.agentsByFeature}
        selectedId={selectedId}
        onSelect={onSelect}
      />
      <AnimatePresence>
        {feature ? (
          <motion.div
            key="feature-detail"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={transition}
            className="absolute bottom-0 right-0 top-0 z-20 flex w-[480px] max-w-[90vw] border-l border-border bg-base shadow-[var(--shadow-float)]"
          >
            <DetailPanel feature={feature} agents={model.agentsByFeature.get(feature.id) ?? []} onClose={onClose} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
