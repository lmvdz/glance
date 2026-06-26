import { useEffect, useState } from "react";
import type { AgentDTO } from "@/lib/dto";
import type { SquadState } from "@/hooks/useSquad";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/agent/status-badge";
import { RelativeTime } from "@/components/agent/relative-time";
import { Transcript } from "@/components/agent/Transcript";
import { AgentChanges } from "@/components/agent/AgentChanges";
import { AgentSubagents } from "@/components/agent/AgentSubagents";
import { AnswerControls } from "@/components/agent/AnswerControls";

type Tab = "transcript" | "changes" | "subagents";
const TABS: { id: Tab; label: string }[] = [
  { id: "transcript", label: "Transcript" },
  { id: "changes", label: "Changes" },
  { id: "subagents", label: "Subagents" },
];

export function AgentDetail({ agent, squad }: { agent: AgentDTO; squad: SquadState }) {
  const { subscribe } = squad;
  useEffect(() => {
    subscribe(agent.id);
  }, [agent.id, subscribe]);
  const [tab, setTab] = useState<Tab>("transcript");

  const repo = agent.repo.split("/").filter(Boolean).pop() ?? agent.repo;
  const entries = squad.transcripts.get(agent.id) ?? [];

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <StatusBadge status={agent.status} />
          <span className="truncate text-sm font-semibold text-text-primary">{agent.name}</span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
          {agent.model ? <span>{agent.model}</span> : null}
          {agent.branch ? <span className="font-mono">{agent.branch}</span> : null}
          <span className="font-mono">{repo}</span>
          {agent.todo ? (
            <span>
              {agent.todo.done}/{agent.todo.total} todo
            </span>
          ) : null}
          {agent.contextPct != null ? <span>ctx {Math.round(agent.contextPct * 100)}%</span> : null}
          <RelativeTime ts={agent.lastActivity} />
        </div>
        {agent.activity ? <p className="mt-1.5 truncate text-xs text-text-secondary">{agent.activity}</p> : null}
      </div>

      {agent.pending.length > 0 ? (
        <div className="flex flex-col gap-3 border-b border-border bg-progress/5 px-4 py-3">
          {agent.pending.map((req) => (
            <div key={req.id}>
              <div className="text-sm font-medium text-text-1">{req.title}</div>
              {req.message ? <div className="mt-0.5 whitespace-pre-wrap text-xs text-text-2">{req.message}</div> : null}
              <div className="mt-2">
                <AnswerControls
                  request={req}
                  onAnswer={(v) => squad.send({ type: "answer", id: agent.id, requestId: req.id, value: v })}
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}


      <div className="flex gap-1 border-b border-border px-3" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "border-b-2 px-2.5 py-1.5 text-xs transition-colors",
              tab === t.id ? "border-accent text-text-primary" : "border-transparent text-text-muted hover:text-text-primary",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1">
        {tab === "transcript" && <Transcript entries={entries} agent={agent} squad={squad} />}
        {tab === "changes" && <AgentChanges agentId={agent.id} />}
        {tab === "subagents" && <AgentSubagents agentId={agent.id} />}
      </div>
    </div>
  );
}
