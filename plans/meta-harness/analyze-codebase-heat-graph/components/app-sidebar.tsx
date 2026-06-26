"use client"

import {
  LayoutGrid,
  PlayCircle,
  Flame,
  Workflow,
  Lightbulb,
  FileText,
  Settings,
  Hexagon,
  ChevronsUpDown,
  Radar,
} from "lucide-react"
import { cn } from "@/lib/utils"

const NAV = [
  { label: "Overview", icon: LayoutGrid },
  { label: "Runs", icon: PlayCircle },
  { label: "Context Heat", icon: Flame, active: true },
  { label: "Patterns", icon: Workflow },
  { label: "Opportunities", icon: Lightbulb },
  { label: "Reports", icon: FileText },
  { label: "Settings", icon: Settings },
]

export function AppSidebar() {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
      <div className="flex items-center gap-2 px-5 py-5">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Hexagon className="size-4" strokeWidth={2.5} />
        </div>
        <span className="text-sm font-semibold tracking-widest text-sidebar-foreground">
          OMP·SQUAD
        </span>
      </div>

      <nav className="mt-2 flex flex-1 flex-col gap-1 px-3">
        {NAV.map(({ label, icon: Icon, active }) => (
          <button
            key={label}
            type="button"
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
              active
                ? "bg-sidebar-accent font-medium text-sidebar-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
            )}
          >
            <Icon
              className={cn("size-4", active && "text-primary")}
              strokeWidth={2}
            />
            {label}
          </button>
        ))}
      </nav>

      <div className="space-y-3 px-3 pb-3">
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-lg border border-sidebar-border bg-card/40 px-3 py-2 text-left"
        >
          <span className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Active Project
            </span>
            <span className="text-sm font-medium text-sidebar-foreground">
              omp-squad/omp-squad
            </span>
          </span>
          <ChevronsUpDown className="size-4 text-muted-foreground" />
        </button>

        <div className="flex items-center gap-3 rounded-lg border border-sidebar-border bg-card/40 px-3 py-2">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary/15 text-primary">
            <Radar className="size-4" />
          </div>
          <span className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Scout Mode
            </span>
            <span className="flex items-center gap-1.5 text-sm font-medium text-sidebar-foreground">
              Observing
              <span className="size-1.5 rounded-full bg-emerald-400" />
            </span>
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-sidebar-border px-4 py-3">
        <img
          src="/avatar-kai.png"
          alt="Kai Chen"
          className="size-8 rounded-full object-cover"
        />
        <span className="flex flex-1 flex-col leading-tight">
          <span className="text-sm font-medium text-sidebar-foreground">
            Kai Chen
          </span>
          <span className="text-xs text-muted-foreground">maintainer</span>
        </span>
        <ChevronsUpDown className="size-4 text-muted-foreground" />
      </div>
    </aside>
  )
}
