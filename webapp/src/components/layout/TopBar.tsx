import { useState } from "react";
import { List, Network } from "lucide-react";
import { ViewTabs } from "@/components/shared/ViewTabs";
import type { AgentDTO, FeatureDTO } from "@/lib/dto";

interface TopBarProps {
  agents: AgentDTO[];
  features: FeatureDTO[];
  connected: boolean;
  unassigned: number;
  view: "structure" | "graph";
  onView: (v: "structure" | "graph") => void;
}

export function TopBar({ agents, features, connected, unassigned, view, onView }: TopBarProps) {
  const working = agents.filter((a) => a.status === "working").length;
  const waiting = agents.filter((a) => a.status === "input" || a.status === "error").length;
  const [light, setLight] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("light"),
  );
  const toggleTheme = () => {
    const el = document.documentElement;
    el.classList.toggle("light");
    setLight(el.classList.contains("light"));
  };
  return (
    <header
      className="flex items-center gap-4 border-b border-border bg-surface px-4"
      style={{ height: "var(--topbar-h)" }}
    >
      <div className="flex items-center gap-2">
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: connected ? "var(--color-done)" : "var(--color-cancelled)" }}
          title={connected ? "connected" : "reconnecting"}
        />
        <span className="text-sm font-semibold text-text-primary">omp-graph</span>
      </div>
      <ViewTabs
        activeId={view}
        onChange={(id) => onView(id === "graph" ? "graph" : "structure")}
        tabs={[
          { id: "structure", label: "Structure", icon: <List size={12} /> },
          { id: "graph", label: "Graph", icon: <Network size={12} /> },
        ]}
      />
      <div className="ml-auto flex items-center gap-3 text-xs text-text-muted">
        <span>{agents.length} agents</span>
        {working > 0 ? <span className="text-accent">{working} working</span> : null}
        {waiting > 0 ? (
          <span
            className="rounded px-1.5 py-0.5 font-medium"
            style={{ color: "var(--color-progress)", background: "var(--color-progress-bg)" }}
          >
            {waiting} waiting
          </span>
        ) : null}
        <span>{features.length} features</span>
        {unassigned > 0 ? <span title="agents with no feature">{unassigned} unassigned</span> : null}
        <button
          type="button"
          onClick={toggleTheme}
          className="rounded px-2 py-0.5 hover:bg-surface-hover"
          title="Toggle theme"
        >
          {light ? "Dark" : "Light"}
        </button>
      </div>
    </header>
  );
}
