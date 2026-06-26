export const DAYS = [
  "MAY 11",
  "MAY 12",
  "MAY 13",
  "MAY 14",
  "MAY 15",
  "MAY 16",
  "MAY 17",
  "MAY 18",
]

export type TreeNode = {
  id: string
  name: string
  type: "folder" | "file"
  depth: number
  // heat values per day, 0..1 (files only)
  heat?: number[]
}

// The tree is pre-flattened in display order. `heat` arrays roughly follow
// the "magma" hotspot centered on context.go around May 14-15.
export const TREE: TreeNode[] = [
  { id: "root", name: "omp-squad/", type: "folder", depth: 0 },
  { id: "cmd", name: "cmd/", type: "folder", depth: 1 },
  {
    id: "cmd/root.go",
    name: "root.go",
    type: "file",
    depth: 2,
    heat: [0.28, 0.3, 0.34, 0.4, 0.42, 0.38, 0.34, 0.3],
  },
  {
    id: "cmd/run.go",
    name: "run.go",
    type: "file",
    depth: 2,
    heat: [0.42, 0.48, 0.56, 0.64, 0.66, 0.6, 0.54, 0.5],
  },
  {
    id: "cmd/watch.go",
    name: "watch.go",
    type: "file",
    depth: 2,
    heat: [0.3, 0.34, 0.4, 0.46, 0.48, 0.44, 0.4, 0.36],
  },
  {
    id: "cmd/config.go",
    name: "config.go",
    type: "file",
    depth: 2,
    heat: [0.26, 0.3, 0.36, 0.42, 0.44, 0.4, 0.36, 0.32],
  },
  { id: "internal", name: "internal/", type: "folder", depth: 1 },
  { id: "engine", name: "engine/", type: "folder", depth: 2 },
  {
    id: "engine/planner.go",
    name: "planner.go",
    type: "file",
    depth: 3,
    heat: [0.4, 0.5, 0.62, 0.74, 0.78, 0.7, 0.6, 0.52],
  },
  {
    id: "engine/executor.go",
    name: "executor.go",
    type: "file",
    depth: 3,
    heat: [0.5, 0.62, 0.76, 0.88, 0.9, 0.82, 0.72, 0.62],
  },
  {
    id: "engine/context.go",
    name: "context.go",
    type: "file",
    depth: 3,
    heat: [0.55, 0.7, 0.86, 0.98, 1.0, 0.92, 0.8, 0.68],
  },
  { id: "scout", name: "scout/", type: "folder", depth: 2 },
  {
    id: "scout/scout.go",
    name: "scout.go",
    type: "file",
    depth: 3,
    heat: [0.42, 0.5, 0.6, 0.7, 0.72, 0.66, 0.58, 0.5],
  },
  {
    id: "scout/analyzer.go",
    name: "analyzer.go",
    type: "file",
    depth: 3,
    heat: [0.46, 0.56, 0.68, 0.8, 0.84, 0.78, 0.7, 0.62],
  },
  {
    id: "scout/pattern_finder.go",
    name: "pattern_finder.go",
    type: "file",
    depth: 3,
    heat: [0.4, 0.48, 0.58, 0.68, 0.72, 0.68, 0.62, 0.56],
  },
  { id: "store", name: "store/", type: "folder", depth: 2 },
  {
    id: "store/store.go",
    name: "store.go",
    type: "file",
    depth: 3,
    heat: [0.34, 0.4, 0.48, 0.56, 0.58, 0.52, 0.46, 0.4],
  },
  {
    id: "store/sqlite.go",
    name: "sqlite.go",
    type: "file",
    depth: 3,
    heat: [0.3, 0.36, 0.44, 0.52, 0.54, 0.48, 0.42, 0.36],
  },
  {
    id: "store/models.go",
    name: "models.go",
    type: "file",
    depth: 3,
    heat: [0.32, 0.38, 0.46, 0.54, 0.56, 0.5, 0.44, 0.38],
  },
  { id: "pkg", name: "pkg/", type: "folder", depth: 1 },
  { id: "ui", name: "ui/", type: "folder", depth: 1 },
  { id: "web", name: "web/", type: "folder", depth: 1 },
  {
    id: "go.mod",
    name: "go.mod",
    type: "file",
    depth: 1,
    heat: [0.18, 0.2, 0.22, 0.24, 0.24, 0.22, 0.2, 0.18],
  },
  {
    id: "README.md",
    name: "README.md",
    type: "file",
    depth: 1,
    heat: [0.16, 0.18, 0.2, 0.22, 0.22, 0.2, 0.18, 0.16],
  },
]

export type HotArea = {
  rank: number
  path: string
  score: number
  description: string
  tag: "CORE HOTSPOT" | "GROWING" | "STEADY"
}

export const HOT_AREAS: HotArea[] = [
  {
    rank: 1,
    path: "internal/engine/context.go",
    score: 98,
    description:
      "High context churn and central to execution flow. Frequent updates across runs.",
    tag: "CORE HOTSPOT",
  },
  {
    rank: 2,
    path: "internal/engine/executor.go",
    score: 87,
    description:
      "Closely tied to planning and action execution. High impact surface.",
    tag: "CORE HOTSPOT",
  },
  {
    rank: 3,
    path: "internal/scout/analyzer.go",
    score: 76,
    description:
      "Active exploration and analysis logic. Evolving with new patterns.",
    tag: "GROWING",
  },
  {
    rank: 4,
    path: "cmd/run.go",
    score: 61,
    description: "Entry point for runs. Steady changes, moderate context.",
    tag: "STEADY",
  },
  {
    rank: 5,
    path: "internal/scout/pattern_finder.go",
    score: 58,
    description: "Pattern detection logic seeing increased refinement.",
    tag: "GROWING",
  },
]

export type Insight = {
  icon: "modularize" | "extract" | "tests"
  title: string
  detail: string
}

export const INSIGHTS: Insight[] = [
  {
    icon: "modularize",
    title: "Consider modularizing executor.go",
    detail: "High complexity & high churn.",
  },
  {
    icon: "extract",
    title: "Extract interface from context.go",
    detail: "to reduce coupling.",
  },
  {
    icon: "tests",
    title: "analyzer.go is growing rapidly",
    detail: "Add tests to protect behavior.",
  },
]

// "magma"-style colormap. t in [0,1] -> rgb string.
const MAGMA: [number, number, number][] = [
  [12, 8, 38], // deep indigo
  [54, 18, 88], // purple
  [114, 31, 109], // magenta
  [183, 55, 95], // pink-red
  [229, 92, 72], // orange-red
  [248, 148, 65], // orange
  [252, 200, 90], // amber/yellow
]

export function magma(t: number): string {
  const v = Math.max(0, Math.min(1, t))
  const scaled = v * (MAGMA.length - 1)
  const i = Math.floor(scaled)
  const f = scaled - i
  const a = MAGMA[i]
  const b = MAGMA[Math.min(i + 1, MAGMA.length - 1)]
  const r = Math.round(a[0] + (b[0] - a[0]) * f)
  const g = Math.round(a[1] + (b[1] - a[1]) * f)
  const bl = Math.round(a[2] + (b[2] - a[2]) * f)
  return `rgb(${r}, ${g}, ${bl})`
}
