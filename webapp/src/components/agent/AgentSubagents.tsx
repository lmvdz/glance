import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface SubEntry {
  status: string;
  agent: string;
  description?: string;
  task?: string;
}

export function AgentSubagents({ agentId }: { agentId: string }) {
  const [subs, setSubs] = useState<SubEntry[] | null>(null);
  useEffect(() => {
    let alive = true;
    apiGet<SubEntry[]>(`/api/agents/${encodeURIComponent(agentId)}/subagents`).then((d) => {
      if (alive) setSubs(d ?? []);
    });
    return () => {
      alive = false;
    };
  }, [agentId]);

  if (subs === null) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-5 w-2/3" />
        ))}
      </div>
    );
  }
  if (subs.length === 0) return <div className="p-4 text-sm text-text-muted">No subagents.</div>;
  return (
    <div className="flex flex-col gap-1.5 overflow-y-auto p-4">
      {subs.map((s, i) => (
        <div key={i} className="flex items-center gap-2 text-sm">
          <Badge tone="neutral">{s.status}</Badge>
          <span className="text-text-1">{s.agent}</span>
          <span className="truncate text-xs text-text-3">{s.description ?? s.task ?? ""}</span>
        </div>
      ))}
    </div>
  );
}
