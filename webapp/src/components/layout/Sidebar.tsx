import type { ReactNode } from "react";
import { Bot, FolderGit2, Inbox, Layers, MessageSquare, Network, ScrollText, Share2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Project } from "@/lib/projects";

export type View = "inbox" | "agents" | "features" | "graph" | "audit" | "network" | "project" | "console";

const ITEMS: { id: View; label: string; icon: ReactNode }[] = [
  { id: "inbox", label: "Inbox", icon: <Inbox size={16} /> },
  { id: "agents", label: "Agents", icon: <Bot size={16} /> },
  { id: "features", label: "Features", icon: <Layers size={16} /> },
  { id: "graph", label: "Graph", icon: <Network size={16} /> },
  { id: "audit", label: "Audit", icon: <ScrollText size={16} /> },
  { id: "network", label: "Network", icon: <Share2 size={16} /> },
  { id: "console", label: "Console", icon: <MessageSquare size={16} /> },
];

interface SidebarProps {
  view: View;
  onView: (v: View) => void;
  counts: { inbox: number; agents: number; features: number };
  projects: Project[];
  activeRepo: string | null;
  onProject: (repo: string) => void;
}

const rowCls = (active: boolean): string =>
  cn(
    "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
    active ? "bg-surface-hover text-text-primary" : "text-text-secondary hover:bg-surface-hover hover:text-text-primary",
  );

export function Sidebar({ view, onView, counts, projects, activeRepo, onProject }: SidebarProps) {
  return (
    <nav
      className="flex shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-surface/40 p-2 max-md:hidden"
      style={{ width: "var(--sidebar-w)" }}
      aria-label="Primary"
    >
      {projects.length > 0 ? (
        <>
          <div className="px-2.5 pb-1 pt-1 text-[0.65rem] font-medium uppercase tracking-wide text-text-muted">Projects</div>
          {projects.map((p) => {
            const active = view === "project" && activeRepo === p.repo;
            return (
              <button key={p.repo} type="button" onClick={() => onProject(p.repo)} aria-current={active ? "page" : undefined} title={p.repo} className={rowCls(active)}>
                <span className={cn(active && "text-accent")}>
                  <FolderGit2 size={16} />
                </span>
                <span className="min-w-0 flex-1 truncate text-left">{p.name}</span>
                {p.waiting > 0 ? <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--color-progress)" }} title={`${p.waiting} waiting`} /> : null}
                {p.featureCount > 0 ? <span className="text-xs tabular-nums text-text-muted">{p.featureCount}</span> : null}
              </button>
            );
          })}
          <div className="my-1.5 border-t border-border" />
        </>
      ) : null}
      {ITEMS.map((it) => {
        const count = it.id === "inbox" ? counts.inbox : it.id === "agents" ? counts.agents : it.id === "features" ? counts.features : 0;
        const active = view === it.id;
        const attention = it.id === "inbox" && counts.inbox > 0;
        return (
          <button key={it.id} type="button" onClick={() => onView(it.id)} aria-current={active ? "page" : undefined} className={rowCls(active)}>
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
