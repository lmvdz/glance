"use client"

import { useState } from "react"
import { Info } from "lucide-react"
import { AppSidebar } from "@/components/app-sidebar"
import { HeatControls, HeatLegend } from "@/components/heat-controls"
import { HeatMap } from "@/components/heat-map"
import { InsightsPanel } from "@/components/insights-panel"

export default function Page() {
  const [showPatterns, setShowPatterns] = useState(true)

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <AppSidebar />

      <main className="flex flex-1 flex-col overflow-y-auto">
        <header className="px-8 pb-2 pt-6">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            Context Heat Graph
            <Info className="size-4 text-muted-foreground" />
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Codebase context &ldquo;heat&rdquo; across runs (decaying over time)
          </p>
        </header>

        <div className="flex flex-col gap-4 px-8 pb-8 pt-4">
          <HeatControls
            showPatterns={showPatterns}
            onShowPatternsChange={setShowPatterns}
          />
          <HeatLegend />
          <HeatMap showPatterns={showPatterns} />
        </div>
      </main>

      <InsightsPanel />
    </div>
  )
}
