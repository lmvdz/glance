import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Bot,
  BrainCircuit,
  ChevronRight,
  FolderGit2,
  Hexagon,
  Inbox,
  Layers,
  MessageSquare,
  Radar,
  ScrollText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentDTO } from "@/lib/dto";
import type { Project } from "@/lib/projects";
import type { AppView } from "@/lib/routes";

export type View = AppView;

const ITEMS: { id: View; label: string; icon: ReactNode; section?: string }[] = [
  { id: "console", label: "Control Tower", icon: <MessageSquare size={17} />, section: "Operate" },
  { id: "agents", label: "Glance", icon: <Radar size={17} />, section: "Core" },
  { id: "features", label: "Work", icon: <Layers size={17} /> },
  { id: "inbox", label: "Needs Input", icon: <Inbox size={17} /> },
  { id: "audit", label: "Audit", icon: <ScrollText size={17} /> },
];

interface SidebarProps {
  view: View;
  selectedId: string | null;
  onView: (v: View) => void;
  counts: { inbox: number; agents: number; features: number };
  projects: Project[];
  agents: AgentDTO[];
  activeRepo: string | null;
  onProject: (repo: string) => void;
  onAgent: (id: string) => void;
}

const rowCls = (active: boolean, nested = false): string =>
  cn(
    "group flex min-h-8 items-center gap-2 rounded-md text-[13px] transition-[background-color,border-color,color,transform] duration-150 active:translate-y-px",
    nested ? "px-2 py-1" : "px-2.5",
    active
      ? "border border-accent/40 bg-accent/15 text-text-primary shadow-[var(--shadow-glow-accent)]"
      : "border border-transparent text-text-secondary hover:border-border-strong hover:bg-surface-hover hover:text-text-primary",
  );

export function Sidebar({ view, selectedId, onView, counts, projects, agents, activeRepo, onProject, onAgent }: SidebarProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (activeRepo) setExpanded((current) => ({ ...current, [activeRepo]: true }));
  }, [activeRepo]);

  const agentsByRepo = useMemo(() => {
    const grouped: Record<string, AgentDTO[]> = {};
    for (const agent of agents) (grouped[agent.repo] ??= []).push(agent);
    for (const list of Object.values(grouped)) list.sort((a, b) => a.name.localeCompare(b.name));
    return grouped;
  }, [agents]);


  if (collapsed) {
    return (
      <nav className="flex w-[4.25rem] shrink-0 flex-col items-center gap-1.5 overflow-y-auto border-r border-border bg-base-2/95 p-2 max-md:hidden" aria-label="Primary">
        <button type="button" onClick={() => setCollapsed(false)} className="mb-1 flex size-8 items-center justify-center rounded-md bg-accent text-primary-foreground" aria-label="Expand sidebar" title="Expand sidebar">
          <Hexagon size={16} strokeWidth={2.4} aria-hidden="true" />
        </button>
        {projects.slice(0, 8).map((project) => {
          const active = view === "project" && activeRepo === project.repo;
          return (
            <button key={project.repo} type="button" onClick={() => onProject(project.repo)} aria-current={active ? "page" : undefined} title={project.name} className={cn(rowCls(active), "relative min-w-10 justify-center px-0")}>
              <FolderGit2 size={16} aria-hidden="true" />
              {project.waiting > 0 ? <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-warning" /> : null}
            </button>
          );
        })}
        <div className="my-1 h-px w-full bg-border" />
        {ITEMS.map((it) => {
          const count = it.id === "inbox" ? counts.inbox : it.id === "agents" ? counts.agents : it.id === "features" ? counts.features : 0;
          const active = view === it.id;
          return (
            <button key={it.id} type="button" onClick={() => onView(it.id)} aria-current={active ? "page" : undefined} title={it.label} className={cn(rowCls(active), "relative min-w-10 justify-center px-0")}>
              <span className={cn("text-text-muted", active && "text-accent-light")}>{it.icon}</span>
              {count > 0 ? <span className="absolute right-0.5 top-0.5 rounded-full bg-surface-raised px-1 text-[10px] tabular-nums text-text-muted">{Math.min(count, 99)}</span> : null}
            </button>
          );
        })}
        <button type="button" onClick={() => setCollapsed(false)} className="mt-auto flex min-h-8 min-w-8 items-center justify-center rounded-md border border-border text-text-muted hover:bg-surface-hover hover:text-text-primary" aria-label="Expand sidebar" title="Expand">
          <ChevronRight className="size-3.5" aria-hidden="true" />
        </button>
      </nav>
    );
  }
  return (
    <nav
      className={cn("flex shrink-0 flex-col gap-1.5 overflow-y-auto border-r border-border bg-base-2/95 p-2 transition-[width] max-md:hidden", collapsed && "items-center")}
      style={{ width: collapsed ? "4.25rem" : "var(--sidebar-w)" }}
      aria-label="Primary"
    >
      <div className={cn("mb-1 flex items-center gap-2 px-1.5 py-1.5", collapsed && "justify-center px-0")}>
        <span className="flex size-7 items-center justify-center rounded-md bg-accent text-primary-foreground">
          <Hexagon size={16} strokeWidth={2.4} aria-hidden="true" />
        </span>
        {collapsed ? null : (
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold tracking-[0.12em] text-text-primary">OMP·SQUAD</div>
            <div className="text-[10px] text-text-muted">Meta-harness</div>
          </div>
        )}
        <button type="button" onClick={() => setCollapsed((value) => !value)} className={cn("ml-auto flex min-h-7 min-w-7 items-center justify-center rounded-md border border-border text-text-muted hover:bg-surface-hover hover:text-text-primary", collapsed && "ml-0")} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand" : "Collapse"}>
          <ChevronRight className={cn("size-3.5 transition-transform", !collapsed && "rotate-180")} aria-hidden="true" />
        </button>
      </div>

      {projects.length > 0 ? (
        <>
          <div className="px-2 pb-0.5 pt-1 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-text-muted">Projects</div>
          {projects.map((p) => {
            const active = view === "project" && activeRepo === p.repo;
            const repoAgents = agentsByRepo[p.repo] ?? [];
            const isExpanded = expanded[p.repo] ?? active;
            return (
              <div key={p.repo}>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setExpanded((current) => ({ ...current, [p.repo]: !isExpanded }))}
                    className="flex min-h-8 min-w-6 items-center justify-center rounded-md text-text-muted hover:bg-surface-hover hover:text-text-primary"
                    aria-label={`${isExpanded ? "Collapse" : "Expand"} ${p.name}`}
                  >
                    <ChevronRight className={cn("size-3.5 transition-transform", isExpanded && "rotate-90")} aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => onProject(p.repo)} aria-current={active ? "page" : undefined} title={p.repo} className={cn(rowCls(active), "min-w-0 flex-1")}>
                    <span className={cn("text-text-muted", active && "text-accent-light")}>
                      <FolderGit2 size={16} aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-left">{p.name}</span>
                    {p.waiting > 0 ? <span className="h-2 w-2 rounded-full bg-warning shadow-[0_0_8px_var(--color-progress)]" title={`${p.waiting} waiting`} /> : null}
                    {p.featureCount > 0 ? <span className="rounded-md bg-surface-raised px-1.5 text-xs tabular-nums text-text-muted">{p.featureCount}</span> : null}
                  </button>
                </div>
                {isExpanded && repoAgents.length > 0 ? (
                  <div className="ml-7 mt-1 space-y-1 border-l border-border pl-2">
                    {repoAgents.map((agent) => {
                      const activeAgent = view === "agents" && selectedId === agent.id;
                      return (
                        <button key={agent.id} type="button" onClick={() => onAgent(agent.id)} className={cn(rowCls(activeAgent, true), "w-full")} aria-current={activeAgent ? "page" : undefined}>
                          <Bot size={14} aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate text-left">{agent.name}</span>
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: agent.status === "working" ? "var(--color-done)" : agent.status === "input" || agent.status === "error" ? "var(--color-progress)" : "var(--color-text-muted)" }} />
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
          <div className="my-2 border-t border-border" />
        </>
      ) : null}

      <div className="flex flex-col gap-1">
        {ITEMS.map((it) => {
          const count = it.id === "inbox" ? counts.inbox : it.id === "agents" ? counts.agents : it.id === "features" ? counts.features : 0;
          const active = view === it.id;
          const attention = it.id === "inbox" && counts.inbox > 0;
          return (
            <div key={it.id} className="contents">
              {it.section ? <div className="px-2 pb-0.5 pt-2 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-text-muted">{it.section}</div> : null}
              <button type="button" onClick={() => onView(it.id)} aria-current={active ? "page" : undefined} className={rowCls(active)}>
                <span className={cn("text-text-muted transition-colors group-hover:text-accent-light", active && "text-accent-light")}>{it.icon}</span>
                <span className="flex-1 text-left">{it.label}</span>
                {count > 0 ? (
                  <span
                    className="rounded-md px-1.5 py-0.5 text-xs tabular-nums"
                    style={attention ? { color: "var(--color-progress)", background: "var(--color-progress-bg)" } : { color: "var(--color-text-muted)", background: "var(--color-todo-bg)" }}
                  >
                    {count}
                  </span>
                ) : null}
              </button>
            </div>
          );
        })}
      </div>

      <div className="mt-auto rounded-md border border-border bg-surface/70 p-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-text-primary">
          <BrainCircuit size={14} className="text-accent-light" aria-hidden="true" />
          Protocol layer
        </div>
        <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-text-muted">Verifiable agent work across runtimes and land gates.</p>
      </div>
    </nav>
  );
}
