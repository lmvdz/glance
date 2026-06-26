"use client"

import { useState } from "react"
import { Calendar, LineChart, Layers, ChevronDown, HelpCircle } from "lucide-react"
import { cn } from "@/lib/utils"

function Field({
  label,
  icon: Icon,
  value,
}: {
  label: string
  icon: React.ElementType
  value: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <button
        type="button"
        className="flex min-w-44 items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-foreground transition-colors hover:border-ring/50"
      >
        <span className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" />
          {value}
        </span>
        <ChevronDown className="size-4 text-muted-foreground" />
      </button>
    </div>
  )
}

export function HeatControls({
  showPatterns,
  onShowPatternsChange,
}: {
  showPatterns: boolean
  onShowPatternsChange: (v: boolean) => void
}) {
  return (
    <div className="flex flex-wrap items-end gap-5 rounded-xl border border-border bg-card/50 p-4">
      <Field label="Time Range" icon={Calendar} value="May 11 – May 18, 2025" />
      <Field label="Decay Half-Life" icon={LineChart} value="3 days" />
      <Field label="Aggregation" icon={Layers} value="File" />

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">Show Patterns</span>
        <button
          type="button"
          role="switch"
          aria-checked={showPatterns}
          aria-label="Show patterns"
          onClick={() => onShowPatternsChange(!showPatterns)}
          className={cn(
            "relative h-7 w-12 rounded-full border border-border transition-colors",
            showPatterns ? "bg-primary" : "bg-secondary",
          )}
        >
          <span
            className={cn(
              "absolute top-1/2 size-5 -translate-y-1/2 rounded-full bg-background transition-all",
              showPatterns ? "left-[26px]" : "left-0.5",
            )}
          />
        </button>
      </div>
    </div>
  )
}

export function HeatLegend() {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card/50 px-4 py-3">
      <div className="flex flex-1 items-center gap-3">
        <span className="text-sm text-muted-foreground">Cold</span>
        <div
          className="h-2.5 flex-1 rounded-full"
          style={{
            background:
              "linear-gradient(90deg, rgb(40,52,140) 0%, rgb(80,40,130) 25%, rgb(150,45,110) 50%, rgb(225,90,75) 72%, rgb(248,160,70) 88%, rgb(252,205,95) 100%)",
          }}
        />
        <span className="text-sm text-muted-foreground">Hot</span>
      </div>
      <button
        type="button"
        className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground transition-colors hover:border-ring/50"
      >
        <HelpCircle className="size-4 text-muted-foreground" />
        How it works
      </button>
    </div>
  )
}
