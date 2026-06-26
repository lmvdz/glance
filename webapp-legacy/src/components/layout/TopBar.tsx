import { Bell, Moon, Search, Sparkles, Sun, TerminalSquare } from "lucide-react";
import type { AgentDTO, FeatureDTO } from "@/lib/dto";
import { NewWork } from "@/components/spawn/NewWork";
import { PushToggle } from "@/components/layout/PushToggle";
import { inboxActionCount } from "@/lib/inbox";

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
  const waiting = inboxActionCount(agents);
  return (
    <header
      className="flex items-center gap-2 border-b border-border bg-base/95 px-3 backdrop-blur"
      style={{ height: "var(--topbar-h)" }}
    >
      <div className="flex items-center gap-2">
        <span
          className="h-2 w-2 rounded-full"
          style={{ color: connected ? "var(--color-done)" : "var(--color-cancelled)", background: "currentColor" }}
          title={connected ? "connected" : "reconnecting"}
        />
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-text-primary">Fleet Board</div>
          <div className="hidden text-[10px] text-text-muted lg:block">{connected ? "daemon connected" : "reconnecting"}</div>
        </div>
      </div>
      <button
        type="button"
        onClick={onOpenPalette}
        className="ml-2 hidden min-h-8 w-[min(28rem,34vw)] items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-left text-[13px] text-text-muted shadow-[var(--shadow-card)] transition-colors hover:border-border-strong hover:text-text-primary md:flex"
        title="Command palette"
      >
        <Search size={16} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">Search agents, tasks, traces...</span>
        <kbd className="rounded-md bg-surface-raised px-1.5 py-0.5 font-mono text-[11px] text-text-muted">⌘ K</kbd>
      </button>
      <div className="ml-auto flex items-center gap-2 text-xs text-text-muted">
        <span className="hidden rounded-md border border-border bg-surface px-2 py-1 text-text-secondary lg:inline-flex">
          {agents.length} agents · {features.length} missions
        </span>
        {working > 0 ? <span className="rounded-md bg-success-subtle px-2 py-1 font-medium text-success">{working} working</span> : null}
        {waiting > 0 ? (
          <a
            href="#/inbox"
            className="min-h-8 rounded-md bg-warning-subtle px-2 py-1 font-medium text-warning transition-colors hover:bg-warning/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`${waiting} needs input, open inbox`}
          >
            {waiting} needs input
          </a>
        ) : null}
        <NewWork />
        <PushToggle />
        <button type="button" onClick={onOpenPalette} className="flex min-h-8 min-w-8 items-center justify-center rounded-md border border-border bg-surface hover:border-border-strong md:hidden" aria-label="Open command palette">
          <TerminalSquare size={15} aria-hidden="true" />
        </button>
        <button type="button" className="flex min-h-8 min-w-8 items-center justify-center rounded-md border border-border bg-surface hover:border-border-strong" aria-label="Notifications">
          <Bell size={15} aria-hidden="true" />
        </button>
        <button type="button" onClick={onToggleTheme} className="flex min-h-8 min-w-8 items-center justify-center rounded-md border border-border bg-surface hover:border-border-strong" title="Toggle theme" aria-label="Toggle theme">
          {light ? <Moon size={15} aria-hidden="true" /> : <Sun size={15} aria-hidden="true" />}
        </button>
        <span className="flex min-h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-text-primary">
          <Sparkles size={15} className="text-accent-light" aria-hidden="true" />
          OM
        </span>
      </div>
    </header>
  );
}
