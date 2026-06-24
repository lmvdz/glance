import type { AgentDTO, FeatureDTO } from "@/lib/dto";
import { NewWork } from "@/components/spawn/NewWork";

interface TopBarProps {
  agents: AgentDTO[];
  features: FeatureDTO[];
  connected: boolean;
  light: boolean;
  onToggleTheme: () => void;
  onOpenPalette: () => void;
}

export function TopBar({ agents, features, connected, light, onToggleTheme, onOpenPalette }: TopBarProps) {
  const working = agents.filter((a) => a.status === "working").length;
  const waiting = agents.filter((a) => a.status === "input" || a.status === "error").length;
  return (
    <header
      className="flex items-center gap-3 border-b border-border bg-surface px-4"
      style={{ height: "var(--topbar-h)" }}
    >
      <span
        className="h-2 w-2 rounded-full"
        style={{ background: connected ? "var(--color-done)" : "var(--color-cancelled)" }}
        title={connected ? "connected" : "reconnecting"}
      />
      <span className="text-sm font-semibold text-text-primary">omp-squad</span>
      <button
        type="button"
        onClick={onOpenPalette}
        className="ml-2 rounded border border-border px-2 py-0.5 text-xs text-text-muted hover:border-border-strong hover:text-text-primary"
        title="Command palette"
      >
        Search Cmd-K
      </button>
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
        <NewWork />
        <button type="button" onClick={onToggleTheme} className="rounded px-2 py-0.5 hover:bg-surface-hover" title="Toggle theme">
          {light ? "Dark" : "Light"}
        </button>
      </div>
    </header>
  );
}
