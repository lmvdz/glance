import type { AgentDTO, IssueRef } from "@/lib/dto";
import { cn } from "@/lib/utils";
import { agentColorVar } from "@/lib/status";

/** Plane state group → glyph color (reuses the feature-stage palette vars). */
function stateColor(state?: string): string {
  switch (state) {
    case "completed":
      return "var(--color-glyph-done)";
    case "started":
      return "var(--color-glyph-progress)";
    case "unstarted":
      return "var(--color-glyph-planned)";
    case "cancelled":
      return "var(--color-glyph-cancelled)";
    default:
      return "var(--color-glyph-draft)";
  }
}

interface TaskListProps {
  issues: IssueRef[];
  agentByIssueId: Map<string, AgentDTO>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function TaskList({ issues, agentByIssueId, selectedId, onSelect }: TaskListProps) {
  if (issues.length === 0) return <p className="px-2 py-1 text-xs text-text-muted">No tasks.</p>;
  return (
    <ul className="flex flex-col gap-0.5">
      {issues.map((i) => {
        const agent = agentByIssueId.get(i.id);
        const active = selectedId === i.id;
        const blocked = i.blockedBy?.length ?? 0;
        return (
          <li key={i.id}>
            <button
              type="button"
              onClick={() => onSelect(i.id)}
              aria-selected={active}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-hover",
                active && "bg-surface-hover",
              )}
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: stateColor(i.state) }} title={i.state ?? "unknown"} />
              {i.identifier ? <span className="shrink-0 font-mono text-xs text-text-muted">{i.identifier}</span> : null}
              <span className="min-w-0 flex-1 truncate text-text-primary">{i.name}</span>
              {blocked > 0 ? (
                <span className="shrink-0 text-xs tabular-nums text-text-muted" title={`blocked by ${blocked}`}>
                  ⛓{blocked}
                </span>
              ) : null}
              {agent ? (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: agentColorVar(agent.status) }} title={`agent: ${agent.status}`} />
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
