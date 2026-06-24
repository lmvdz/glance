import type { AgentDTO, AgentStatus } from "@/lib/dto";
import { cn } from "@/lib/utils";
import { StatusDot } from "@/components/agent/status-dot";
import { RelativeTime } from "@/components/agent/relative-time";

const ORDER: Record<AgentStatus, number> = {
  input: 0,
  error: 0,
  working: 1,
  starting: 2,
  idle: 3,
  stopped: 4,
};

interface AgentListProps {
  agents: AgentDTO[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function AgentList({ agents, selectedId, onSelect }: AgentListProps) {
  if (agents.length === 0) {
    return <div className="p-6 text-sm text-text-muted">No agents. Spawn one to get started.</div>;
  }
  const sorted = [...agents].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.lastActivity - a.lastActivity);
  return (
    <div className="p-2">
      {sorted.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onSelect(a.id)}
          className={cn(
            "flex w-full items-center gap-2.5 rounded px-2 py-2 text-left hover:bg-surface-hover",
            selectedId === a.id && "bg-surface-hover",
          )}
        >
          <StatusDot status={a.status} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm text-text-primary">{a.name}</span>
              {a.pending.length > 0 ? (
                <span className="text-xs font-medium" style={{ color: "var(--color-progress)" }}>
                  {a.pending.length}
                </span>
              ) : null}
            </div>
            <div className="truncate text-xs text-text-muted">{a.activity ?? a.status}</div>
          </div>
          <span className="shrink-0 text-xs text-text-faint">
            <RelativeTime ts={a.lastActivity} />
          </span>
        </button>
      ))}
    </div>
  );
}
