import type { SquadState } from "@/hooks/useSquad";
import { TwoPanelLayout } from "@/components/layout/TwoPanelLayout";
import { AgentList } from "@/components/agent/AgentList";
import { AgentDetail } from "@/components/agent/AgentDetail";
import { EmptyState } from "@/components/ui/empty-state";

interface AgentsViewProps {
  squad: SquadState;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function AgentsView({ squad, selectedId, onSelect }: AgentsViewProps) {
  const agent = selectedId ? (squad.agents.find((a) => a.id === selectedId) ?? null) : null;
  return (
    <TwoPanelLayout
      activePanelHint={agent ? "right" : "left"}
      left={<AgentList agents={squad.agents} selectedId={selectedId} onSelect={onSelect} />}
      right={
        agent ? (
          <AgentDetail agent={agent} squad={squad} />
        ) : (
          <div className="p-3">
            <EmptyState title="No agent selected">Pick an agent to see its transcript and controls.</EmptyState>
          </div>
        )
      }
    />
  );
}
