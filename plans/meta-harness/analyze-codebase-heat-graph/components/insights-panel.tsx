import {
  Flame,
  Sparkles,
  ArrowRight,
  Boxes,
  Unplug,
  ShieldCheck,
} from "lucide-react"
import { HOT_AREAS, INSIGHTS, type HotArea, type Insight } from "@/lib/heat-data"
import { cn } from "@/lib/utils"

function splitPath(path: string) {
  const idx = path.lastIndexOf("/")
  if (idx === -1) return { dir: "", file: path }
  return { dir: path.slice(0, idx + 1), file: path.slice(idx + 1) }
}

const TAG_STYLES: Record<HotArea["tag"], string> = {
  "CORE HOTSPOT": "bg-primary/15 text-primary",
  GROWING: "bg-emerald-500/15 text-emerald-400",
  STEADY: "bg-sky-500/15 text-sky-400",
}

function HotAreaCard({ area }: { area: HotArea }) {
  const { dir, file } = splitPath(area.path)
  return (
    <div className="rounded-lg border border-border bg-card/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 text-sm font-semibold tabular-nums text-muted-foreground">
            {area.rank}
          </span>
          <p className="text-sm font-medium leading-snug">
            <span className="text-muted-foreground">{dir}</span>
            <span className="text-primary">{file}</span>
          </p>
        </div>
        <span className="text-base font-semibold tabular-nums text-foreground">
          {area.score}
        </span>
      </div>
      <p className="mt-2 pl-6 text-xs leading-relaxed text-muted-foreground">
        {area.description}
      </p>
      <span
        className={cn(
          "ml-6 mt-2 inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide",
          TAG_STYLES[area.tag],
        )}
      >
        {area.tag}
      </span>
    </div>
  )
}

const INSIGHT_ICONS: Record<Insight["icon"], React.ElementType> = {
  modularize: Boxes,
  extract: Unplug,
  tests: ShieldCheck,
}

function InsightRow({ insight }: { insight: Insight }) {
  const Icon = INSIGHT_ICONS[insight.icon]
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-card/60 p-3">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
        <Icon className="size-3.5" />
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">{insight.title}</span>{" "}
        {insight.detail}
      </p>
    </div>
  )
}

export function InsightsPanel() {
  return (
    <aside className="flex w-80 shrink-0 flex-col gap-6 overflow-y-auto border-l border-border bg-card/30 p-5">
      <div>
        <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Flame className="size-4 text-primary" />
          Top Hot Areas
        </h2>
        <div className="flex flex-col gap-2.5">
          {HOT_AREAS.map((a) => (
            <HotAreaCard key={a.rank} area={a} />
          ))}
        </div>
      </div>

      <div>
        <h2 className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Sparkles className="size-4 text-primary" />
          Scout Insights
        </h2>
        <p className="mb-3 text-sm font-medium text-foreground">
          Suggested Opportunities
        </p>
        <div className="flex flex-col gap-2.5">
          {INSIGHTS.map((i) => (
            <InsightRow key={i.title} insight={i} />
          ))}
        </div>
        <button
          type="button"
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-ring/50"
        >
          View All Opportunities
          <ArrowRight className="size-4" />
        </button>
      </div>
    </aside>
  )
}
