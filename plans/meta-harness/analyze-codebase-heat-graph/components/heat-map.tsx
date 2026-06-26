"use client"

import { useState } from "react"
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FileCode2,
  FileText,
  Info,
} from "lucide-react"
import { TREE, DAYS, magma, type TreeNode } from "@/lib/heat-data"
import { cn } from "@/lib/utils"

const ROW_H = "h-[34px]"

// faint baseline heat for folder rows so the grid stays continuous
const FOLDER_HEAT = [0.24, 0.28, 0.33, 0.38, 0.39, 0.35, 0.31, 0.27]

function RowIcon({ node }: { node: TreeNode }) {
  if (node.type === "folder") {
    return (
      <>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        <Folder className="size-4 shrink-0 text-muted-foreground" />
      </>
    )
  }
  const isMd = node.name.endsWith(".md")
  const Icon = isMd ? FileText : FileCode2
  return <Icon className="ml-[18px] size-4 shrink-0 text-muted-foreground" />
}

export function HeatMap({ showPatterns }: { showPatterns: boolean }) {
  const [selected, setSelected] = useState("engine/context.go")
  const [hover, setHover] = useState<{
    node: string
    day: string
    value: number
  } | null>(null)

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card/50">
      <div className="grid grid-cols-[300px_1fr]">
        {/* Header */}
        <div className="border-b border-r border-border px-4 py-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          File / Module
        </div>
        <div className="flex items-center gap-1.5 border-b border-border px-4 py-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Heat over time
          <Info className="size-3.5" />
        </div>

        {/* Tree column */}
        <div className="border-r border-border">
          {/* spacer aligning with day labels */}
          <div className="h-9 border-b border-border" />
          {TREE.map((node) => {
            const isSelected = node.id === selected
            return (
              <button
                key={node.id}
                type="button"
                onClick={() => node.type === "file" && setSelected(node.id)}
                className={cn(
                  "flex w-full items-center gap-2 px-4 text-left text-sm",
                  ROW_H,
                  isSelected
                    ? "bg-secondary text-foreground"
                    : "text-foreground/90 hover:bg-secondary/50",
                )}
                style={{ paddingLeft: `${16 + node.depth * 18}px` }}
              >
                <RowIcon node={node} />
                <span
                  className={cn(
                    "truncate",
                    node.type === "folder" && "text-foreground",
                  )}
                >
                  {node.name}
                </span>
              </button>
            )
          })}
        </div>

        {/* Heat grid */}
        <div>
          {/* Day labels */}
          <div className="grid h-9 grid-cols-8 border-b border-border">
            {DAYS.map((d) => (
              <div
                key={d}
                className="flex items-center justify-center text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
              >
                {d}
              </div>
            ))}
          </div>

          {TREE.map((node) => {
            const heat = node.heat ?? FOLDER_HEAT
            const isSelected = node.id === selected
            const peak = heat.indexOf(Math.max(...heat))
            return (
              <div
                key={node.id}
                className={cn(
                  "grid grid-cols-8",
                  ROW_H,
                  isSelected && "ring-1 ring-inset ring-ring/60",
                )}
              >
                {heat.map((v, i) => {
                  const isHot = node.type === "file" && v > 0.45
                  return (
                    <div
                      key={i}
                      onMouseEnter={() =>
                        setHover({ node: node.name, day: DAYS[i], value: v })
                      }
                      onMouseLeave={() => setHover(null)}
                      className="relative border-b border-r border-black/20 transition-[filter] hover:brightness-125"
                      style={{
                        backgroundColor: magma(
                          node.type === "folder" ? v * 0.85 : v,
                        ),
                      }}
                    >
                      {showPatterns && isHot && i === peak && (
                        <span className="absolute inset-0 m-auto size-1.5 rounded-full bg-white/85 shadow-[0_0_6px_rgba(255,255,255,0.6)]" />
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>

      {/* Footer / hover readout */}
      <div className="flex items-center justify-between gap-4 border-t border-border px-4 py-3 text-xs text-muted-foreground">
        <span>
          Heat is calculated based on token &amp; file references across runs,
          decayed by half-life.
        </span>
        {hover && (
          <span className="shrink-0 font-mono text-foreground">
            {hover.node} · {hover.day} ·{" "}
            <span className="text-primary">
              {Math.round(hover.value * 100)}
            </span>
          </span>
        )}
      </div>
    </section>
  )
}
