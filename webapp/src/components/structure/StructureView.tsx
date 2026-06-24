import type { AgentDTO, FeatureDTO } from "@/lib/dto";
import { cn } from "@/lib/utils";
import { agentColorVar, stageColorVar } from "@/lib/status";

function basename(p: string): string {
  const s = p.replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

interface StructureViewProps {
  features: FeatureDTO[];
  agentsByFeature: Map<string, AgentDTO[]>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function StructureView({ features, agentsByFeature, selectedId, onSelect }: StructureViewProps) {
  if (features.length === 0) {
    return (
      <div className="p-6 text-sm text-text-muted">
        No features yet. Spawn an agent or add a plans/ directory.
      </div>
    );
  }
  const byRepo = new Map<string, FeatureDTO[]>();
  for (const f of features) {
    const arr = byRepo.get(f.repo) ?? [];
    arr.push(f);
    byRepo.set(f.repo, arr);
  }
  return (
    <div className="p-2">
      {[...byRepo.entries()].map(([repo, list]) => (
        <div key={repo} className="mb-3">
          <div className="px-2 py-1 font-mono text-xs uppercase tracking-wide text-text-muted">
            {basename(repo)}
          </div>
          {list.map((f) => {
            const ags = agentsByFeature.get(f.id) ?? [];
            const waiting = ags.filter((a) => a.status === "input" || a.status === "error");
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => onSelect(f.id)}
                className={cn(
                  "group flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-hover",
                  selectedId === f.id && "bg-surface-hover",
                )}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: stageColorVar(f.stage) }}
                />
                <span className="min-w-0 flex-1 truncate text-text-primary">{f.title}</span>
                {waiting.length > 0 ? (
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: agentColorVar(waiting[0].status) }}
                    title="needs input"
                  />
                ) : null}
                {ags.length > 0 ? <span className="text-xs text-text-muted">{ags.length}</span> : null}
                {f.unlandedFiles > 0 ? (
                  <span className="text-xs" style={{ color: "var(--color-progress)" }}>
                    {f.unlandedFiles}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
