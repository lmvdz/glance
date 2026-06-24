import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";

interface DiffEntry {
  path?: string;
  file?: string;
  status?: string;
  additions?: number;
  deletions?: number;
}

export function AgentChanges({ agentId }: { agentId: string }) {
  const [files, setFiles] = useState<DiffEntry[] | null>(null);
  useEffect(() => {
    let alive = true;
    apiGet<DiffEntry[]>(`/api/agents/${encodeURIComponent(agentId)}/diff`).then((d) => {
      if (alive) setFiles(d ?? []);
    });
    return () => {
      alive = false;
    };
  }, [agentId]);

  if (files === null) return <div className="p-4 text-sm text-text-muted">Loading changes…</div>;
  if (files.length === 0) return <div className="p-4 text-sm text-text-muted">No uncommitted changes.</div>;
  return (
    <ul className="overflow-y-auto p-4">
      {files.map((f, i) => (
        <li key={i} className="flex items-center justify-between gap-2 py-0.5 font-mono text-xs">
          <span className="truncate text-text-1">{f.path ?? f.file ?? "(file)"}</span>
          {f.status ? <span className="shrink-0 text-text-3">{f.status}</span> : null}
        </li>
      ))}
    </ul>
  );
}
