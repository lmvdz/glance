import type { ReactNode } from "react";
import { Bot, Inbox, Layers, Network, ScrollText, Share2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type View = "inbox" | "agents" | "features" | "graph" | "audit" | "network";

const ITEMS: { id: View; label: string; icon: ReactNode }[] = [
  { id: "inbox", label: "Inbox", icon: <Inbox size={16} /> },
  { id: "agents", label: "Agents", icon: <Bot size={16} /> },
  { id: "features", label: "Features", icon: <Layers size={16} /> },
  { id: "graph", label: "Graph", icon: <Network size={16} /> },
  { id: "audit", label: "Audit", icon: <ScrollText size={16} /> },
  { id: "network", label: "Network", icon: <Share2 size={16} /> },
];

interface SidebarProps {
  view: View;
  onView: (v: View) => void;
  counts: { inbox: number; agents: number; features: number };
}

export function Sidebar({ view, onView, counts }: SidebarProps) {
  return (
    <nav
      className="flex shrink-0 flex-col gap-0.5 border-r border-border bg-surface/40 p-2 max-md:hidden"
      style={{ width: "var(--sidebar-w)" }}
      aria-label="Primary"
    >
      {ITEMS.map((it) => {
        const count =
          it.id === "inbox" ? counts.inbox : it.id === "agents" ? counts.agents : it.id === "features" ? counts.features : 0;
        const active = view === it.id;
        const attention = it.id === "inbox" && counts.inbox > 0;
        return (
          <button
            key={it.id}
            type="button"
            onClick={() => onView(it.id)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
              active ? "bg-surface-hover text-text-primary" : "text-text-secondary hover:bg-surface-hover hover:text-text-primary",
            )}
          >
            <span className={cn(active && "text-accent")}>{it.icon}</span>
            <span className="flex-1 text-left">{it.label}</span>
            {count > 0 ? (
              <span
                className="rounded px-1.5 text-xs tabular-nums"
                style={attention ? { color: "var(--color-progress)", background: "var(--color-progress-bg)" } : { color: "var(--color-text-muted)" }}
              >
                {count}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
