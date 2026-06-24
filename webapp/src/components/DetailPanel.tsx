import type { AgentDTO, FeatureDTO } from "@/lib/dto";
import { AGENT_LABEL, STAGE_LABEL, agentColorVar, stageColorVar } from "@/lib/status";

function basename(p: string): string {
  const s = p.replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

interface DetailPanelProps {
  feature: FeatureDTO;
  agents: AgentDTO[];
  onClose: () => void;
}

export function DetailPanel({ feature, agents, onClose }: DetailPanelProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start gap-2 border-b border-border px-4 py-3">
        <span
          className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: stageColorVar(feature.stage) }}
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-text-primary">{feature.title}</h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-text-muted">
            <span>{STAGE_LABEL[feature.stage]}</span>
            <span className="font-mono">{basename(feature.repo)}</span>
            {feature.planDir ? <span className="font-mono">{feature.planDir}</span> : null}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-1.5 text-text-muted hover:bg-surface-hover hover:text-text-primary"
          aria-label="Close detail"
        >
          X
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {feature.issueIdentifiers && feature.issueIdentifiers.length > 0 ? (
          <div className="mb-4 flex flex-wrap gap-1.5">
            {feature.issueIdentifiers.map((id) => (
              <span
                key={id}
                className="rounded border border-border px-1.5 py-0.5 font-mono text-xs text-text-secondary"
              >
                {id}
              </span>
            ))}
          </div>
        ) : null}
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
          Agents ({agents.length})
        </h3>
        {agents.length === 0 ? (
          <p className="text-sm text-text-muted">No agents on this feature.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {agents.map((a) => (
              <AgentRow key={a.id} agent={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentRow({ agent }: { agent: AgentDTO }) {
  const pct = Math.round((agent.contextPct ?? 0) * 100);
  return (
    <div className="rounded-md border border-border bg-surface p-2.5">
      <div className="flex items-center gap-2">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: agentColorVar(agent.status) }}
        />
        <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{agent.name}</span>
        <span className="text-xs" style={{ color: agentColorVar(agent.status) }}>
          {AGENT_LABEL[agent.status]}
        </span>
      </div>
      {agent.activity ? <p className="mt-1 truncate text-xs text-text-muted">{agent.activity}</p> : null}
      <div className="mt-1.5 flex items-center gap-3 text-xs text-text-muted">
        {agent.todo ? (
          <span>
            {agent.todo.done}/{agent.todo.total} todo
          </span>
        ) : null}
        {agent.pending.length > 0 ? (
          <span style={{ color: "var(--color-progress)" }}>{agent.pending.length} pending</span>
        ) : null}
        {agent.contextPct != null ? <span className="ml-auto">ctx {pct}%</span> : null}
      </div>
    </div>
  );
}
