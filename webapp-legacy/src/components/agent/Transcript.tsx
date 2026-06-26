import { useMemo } from "react";
import { AssistantRuntimeProvider, useExternalStoreRuntime } from "@assistant-ui/react";
import type { AgentDTO, TranscriptEntry } from "@/lib/dto";
import type { SquadState } from "@/hooks/useSquad";
import { Thread } from "@/components/assistant-ui/thread";
import { appendText } from "@/lib/assistant-text";
import { buildOmpMessages, toThreadMessage, type OmpChatMessage } from "@/lib/omp-thread";

export function Transcript({ entries, agent, squad }: { entries: TranscriptEntry[]; agent?: AgentDTO; squad?: SquadState }) {
  const messages = useMemo<OmpChatMessage[]>(() => buildOmpMessages(agent?.id ?? null, entries, [], agent?.status === "working" || agent?.status === "starting"), [agent?.id, agent?.status, entries]);
  const runtime = useExternalStoreRuntime<OmpChatMessage>({
    messages,
    convertMessage: toThreadMessage,
    isRunning: agent?.status === "working" || agent?.status === "starting",
    isSendDisabled: !agent || !squad?.connected,
    onNew: async (message) => {
      const text = appendText(message).trim();
      if (!text || !agent || !squad) return;
      squad.send({ type: "prompt", id: agent.id, message: text, clientTurnId: `turn:${Date.now()}:${Math.random().toString(36).slice(2)}` });
    },
    onCancel: async () => {
      if (agent && squad) squad.send({ type: "interrupt", id: agent.id });
    },
    unstable_capabilities: { copy: true },
  });

  if (entries.length === 0) return <div className="p-4 text-sm text-text-muted">No transcript yet.</div>;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread inputPlaceholder={agent ? "Reply or steer this live omp session…" : "Transcript is read-only"} />
    </AssistantRuntimeProvider>
  );
}
