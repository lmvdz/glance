import { useEffect, useMemo, useState } from "react";
import type { SquadState } from "@/hooks/useSquad";
import type { View } from "@/components/layout/Sidebar";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { fuzzyRank } from "@/lib/fuzzy";
import { cn } from "@/lib/utils";

interface Entry {
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

const VIEW_ITEMS: View[] = ["inbox", "agents", "features", "graph", "audit"];

interface PaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  squad: SquadState;
  onView: (v: View) => void;
  onSelectAgent: (id: string) => void;
  onSelectFeature: (id: string) => void;
  onToggleTheme: () => void;
}

export function CommandPalette({ open, onOpenChange, squad, onView, onSelectAgent, onSelectFeature, onToggleTheme }: PaletteProps) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const v of VIEW_ITEMS) out.push({ id: "view:" + v, label: v[0].toUpperCase() + v.slice(1), hint: "view", run: () => onView(v) });
    for (const a of squad.agents) out.push({ id: "agent:" + a.id, label: a.name, hint: "agent · " + a.status, run: () => onSelectAgent(a.id) });
    for (const f of squad.features) out.push({ id: "feat:" + f.id, label: f.title, hint: "feature", run: () => onSelectFeature(f.id) });
    out.push({ id: "act:theme", label: "Toggle theme", hint: "action", run: onToggleTheme });
    return out;
  }, [squad.agents, squad.features, onView, onSelectAgent, onSelectFeature, onToggleTheme]);

  const filtered = useMemo(() => fuzzyRank(entries, q, (e) => e.label), [entries, q]);

  useEffect(() => {
    setActive(0);
  }, [q]);

  const runAt = (i: number) => {
    const e = filtered[i];
    if (!e) return;
    e.run();
    onOpenChange(false);
    setQ("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[18%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              runAt(active);
            }
          }}
          placeholder="Jump to a view, agent, or feature…"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm text-text-1 outline-none placeholder:text-text-3"
        />
        <ul className="max-h-80 overflow-y-auto p-1">
          {filtered.length === 0 ? <li className="px-3 py-2 text-sm text-text-muted">No matches.</li> : null}
          {filtered.map((e, i) => (
            <li key={e.id}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => runAt(i)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-[var(--radius-sm)] px-3 py-1.5 text-left text-sm",
                  i === active ? "bg-secondary text-text-1" : "text-text-2",
                )}
              >
                <span className="truncate">{e.label}</span>
                <span className="shrink-0 text-xs text-text-3">{e.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
