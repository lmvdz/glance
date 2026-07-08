/**
 * categoryCanvas.ts — pure, DOM-free layout math for the Category Canvas
 * (plans/orchestration/CANVAS-AND-PAGE-CHAT.md Feature 1, D2/D3/D5/D6).
 *
 * Deterministic radial layout, NOT a force-graph: categories sit on a calm ring sized by open
 * work; the selected category's plans orbit it as satellites. Same input → same output, always —
 * that's what makes the canvas screenshot-stable and testable (D2's explicit rejection of
 * force-graph physics: "non-deterministic, noisy").
 *
 * Grouping reads the `category` field the Task already carries (computed by task-model.ts's
 * `taskCategory`, override-or-derived) rather than re-deriving it — sibling C1's 'other' bucket
 * + stored override flow through automatically because we never fork that logic here.
 */

import type { Task } from "../types";

// ── category vocabulary ──────────────────────────────────────────────────────

/** Canonical display order — categories with no live task still render (dimmed) in this order;
 *  anything unrecognized (future taxonomy) is appended alphabetically so nothing is ever dropped. */
export const CATEGORY_ORDER = ["frontend", "backend", "database", "devops", "mcp", "other"] as const;

export const CATEGORY_LABELS: Record<string, string> = {
  frontend: "Frontend",
  backend: "Backend",
  database: "Database",
  devops: "DevOps",
  mcp: "MCP",
  other: "Other",
};

export function categoryLabel(id: string): string {
  return CATEGORY_LABELS[id] ?? (id.charAt(0).toUpperCase() + id.slice(1));
}

/** SVG rim-stroke hex per category — the same hue family as `utils.ts`'s `getCategoryBadge` text
 *  color (kept in sync deliberately: the list-row chip and the canvas rim should read as the same
 *  category identity), never used as a fill wash per brand.md's "one warm ember accent" rule. */
export const CATEGORY_RIM_COLOR: Record<string, string> = {
  frontend: "#b91c1c",
  devops: "#c2410c",
  backend: "#4338ca",
  mcp: "#6d28d9",
  database: "#15803d",
  other: "#6b7280",
};

export function categoryRimColor(id: string): string {
  return CATEGORY_RIM_COLOR[id] ?? CATEGORY_RIM_COLOR.other;
}

/** A feature is "needs-you" when it's blocked on a human — reads tags task-model.ts already
 *  populates (feature.blocked → 'blocked'; an active agent's `input` status), never reaching past
 *  the Task the caller already has. */
export function isNeedsYou(task: Pick<Task, "tags">): boolean {
  return task.tags.includes("blocked") || task.tags.includes("input");
}

function acceptancePct(task: Pick<Task, "acceptanceCriteria">): number | null {
  const total = task.acceptanceCriteria.length;
  if (total === 0) return null;
  const done = task.acceptanceCriteria.filter((c) => c.completed).length;
  return Math.round((done / total) * 100);
}

// ── grouping ──────────────────────────────────────────────────────────────────

export interface CategoryBucket {
  id: string;
  label: string;
  tasks: Task[];
  openCount: number;
  totalCount: number;
  needsYouCount: number;
}

/** groupBy(features, taskCategory) — but reading the already-computed `task.category` field so
 *  C1's override/'other' work flows through without a second derivation. Deterministic order:
 *  CATEGORY_ORDER first (present or not — an empty category still renders, dimmed), then any
 *  unrecognized category id alphabetically. */
export function groupTasksByCategory(tasks: Task[]): CategoryBucket[] {
  const byId = new Map<string, Task[]>();
  for (const task of tasks) {
    const list = byId.get(task.category);
    if (list) list.push(task);
    else byId.set(task.category, [task]);
  }
  const known = new Set<string>(CATEGORY_ORDER);
  const extra = [...byId.keys()].filter((id) => !known.has(id)).sort((a, b) => a.localeCompare(b));
  const ids = [...CATEGORY_ORDER, ...extra];
  return ids.map((id) => {
    const bucketTasks = byId.get(id) ?? [];
    return {
      id,
      label: categoryLabel(id),
      tasks: bucketTasks,
      openCount: bucketTasks.filter((t) => t.status !== "done").length,
      totalCount: bucketTasks.length,
      needsYouCount: bucketTasks.filter(isNeedsYou).length,
    };
  });
}

// ── shared angle math ─────────────────────────────────────────────────────────

/** Degrees, clockwise from 12 o'clock (0 = top, 90 = right, 180 = bottom, 270 = left).
 *  count === 2 is special-cased to a horizontal centered pair (D6: "Two categories → centered
 *  pair") rather than the top/bottom split plain even-spacing would produce. */
export function angleForIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 0;
  if (count === 2) return index === 0 ? 270 : 90;
  return (360 / count) * index;
}

export function polarToXY(centerX: number, centerY: number, radius: number, angleDeg: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: centerX + radius * Math.sin(rad), y: centerY - radius * Math.cos(rad) };
}

// ── category ring layout ───────────────────────────────────────────────────────

export interface RingLayoutConfig {
  width: number;
  height: number;
  /** Distance from center to a ring's node centers. Default: 38% of the smaller viewport dimension. */
  ringRadius?: number;
  minNodeRadius?: number;
  maxNodeRadius?: number;
  /** Categories beyond this count per ring wrap onto an additional, larger-radius ring (D6:
   *  "ring wraps, min node size"). Fixed category vocabulary rarely exceeds this; exists for the
   *  case a future taxonomy grows past a legible single ring. */
  wrapThreshold?: number;
}

export interface RingNode {
  id: string;
  label: string;
  angle: number;
  x: number;
  y: number;
  r: number;
  ring: number; // 0 = innermost
  openCount: number;
  totalCount: number;
  needsYouCount: number;
  /** No open work — rendered dimmed, per D2/D6. */
  dimmed: boolean;
}

const DEFAULTS = { minNodeRadius: 28, maxNodeRadius: 60, wrapThreshold: 8 };

/** Deterministic radial placement for the category ring. Sizing is area-proportional
 *  (sqrt of open count) so a category with 4x the open work doesn't look 4x as tall — it looks
 *  4x the area, which reads correctly at a glance. */
export function layoutCategoryRing(buckets: CategoryBucket[], config: RingLayoutConfig): RingNode[] {
  const minR = config.minNodeRadius ?? DEFAULTS.minNodeRadius;
  const maxR = config.maxNodeRadius ?? DEFAULTS.maxNodeRadius;
  const wrapThreshold = config.wrapThreshold ?? DEFAULTS.wrapThreshold;
  const baseRadius = config.ringRadius ?? Math.min(config.width, config.height) * 0.38;
  const centerX = config.width / 2;
  const centerY = config.height / 2;
  const maxOpen = Math.max(0, ...buckets.map((b) => b.openCount));

  const sizeFor = (openCount: number): number => {
    if (maxOpen <= 0 || openCount <= 0) return minR;
    const t = Math.sqrt(openCount / maxOpen);
    return minR + (maxR - minR) * t;
  };

  const rings: CategoryBucket[][] = [];
  for (let i = 0; i < buckets.length; i += wrapThreshold) rings.push(buckets.slice(i, i + wrapThreshold));

  const nodes: RingNode[] = [];
  rings.forEach((ringBuckets, ringIndex) => {
    const radius = baseRadius * (1 + ringIndex * 0.55);
    ringBuckets.forEach((bucket, i) => {
      const angle = angleForIndex(i, ringBuckets.length);
      const { x, y } = polarToXY(centerX, centerY, radius, angle);
      nodes.push({
        id: bucket.id,
        label: bucket.label,
        angle,
        x,
        y,
        r: sizeFor(bucket.openCount),
        ring: ringIndex,
        openCount: bucket.openCount,
        totalCount: bucket.totalCount,
        needsYouCount: bucket.needsYouCount,
        dimmed: bucket.openCount === 0,
      });
    });
  });
  return nodes;
}

// ── selection transition layout ────────────────────────────────────────────────

export interface CanvasNode extends RingNode {
  /** Where this node sits once a category is selected: the selected node's center position, or a
   *  faded perimeter slot for every sibling. Equal to the idle {x,y,r} when nothing is selected. */
  targetX: number;
  targetY: number;
  targetR: number;
  faded: boolean;
  selected: boolean;
}

export interface CanvasLayoutConfig extends RingLayoutConfig {
  /** Radius of the selected node once centered. */
  selectedRadius?: number;
  /** Radius siblings recede to once something is selected (bigger ring = "same canvas space"). */
  perimeterRadius?: number;
  /** Node radius siblings shrink to once faded. */
  perimeterNodeRadius?: number;
}

/**
 * The idle ring PLUS each node's selection target — the two endpoints a GPU transform
 * (translate+scale) animates between. `selectedId === null` collapses target === idle, i.e. no
 * transform is needed at rest.
 */
export function layoutCanvas(buckets: CategoryBucket[], selectedId: string | null, config: CanvasLayoutConfig): CanvasNode[] {
  const idle = layoutCategoryRing(buckets, config);
  const centerX = config.width / 2;
  const centerY = config.height / 2;
  const selectedR = config.selectedRadius ?? (config.maxNodeRadius ?? DEFAULTS.maxNodeRadius) * 1.4;
  const perimeterRadius = config.perimeterRadius ?? (config.ringRadius ?? Math.min(config.width, config.height) * 0.38) * 1.3;
  const perimeterNodeR = config.perimeterNodeRadius ?? (config.minNodeRadius ?? DEFAULTS.minNodeRadius) * 0.75;

  return idle.map((node) => {
    if (selectedId === null) {
      return { ...node, targetX: node.x, targetY: node.y, targetR: node.r, faded: false, selected: false };
    }
    if (node.id === selectedId) {
      return { ...node, targetX: centerX, targetY: centerY, targetR: selectedR, faded: false, selected: true };
    }
    const { x, y } = polarToXY(centerX, centerY, perimeterRadius, node.angle);
    return { ...node, targetX: x, targetY: y, targetR: perimeterNodeR, faded: true, selected: false };
  });
}

// ── satellite (plan) layout ────────────────────────────────────────────────────

export interface SatelliteNode {
  id: string;
  title: string;
  angle: number;
  x: number;
  y: number;
  pct: number | null;
  needsYou: boolean;
  staggerIndex: number;
}

export interface SatelliteLayoutResult {
  satellites: SatelliteNode[];
  /** Tasks folded behind the "+N more" chip (D6: >~24 satellites virtualize). Empty when everything fit. */
  overflow: Task[];
}

export interface SatelliteLayoutConfig {
  centerX: number;
  centerY: number;
  radius: number;
  /** Hard cap on rendered nodes (real satellites + the overflow chip, if any). D6 says "~24". */
  maxVisible?: number;
}

/** needs-you first, then title — so when a category is dense, the blocked work is what survives
 *  into the visible set rather than being the first thing folded behind "+N more". */
function satelliteOrder(a: Task, b: Task): number {
  const an = isNeedsYou(a), bn = isNeedsYou(b);
  if (an !== bn) return an ? -1 : 1;
  return a.title.localeCompare(b.title);
}

export function layoutSatellites(tasks: Task[], config: SatelliteLayoutConfig): SatelliteLayoutResult {
  const maxVisible = config.maxVisible ?? 24;
  const sorted = [...tasks].sort(satelliteOrder);
  const overflow = sorted.length > maxVisible ? sorted.slice(maxVisible - 1) : [];
  const visible = overflow.length > 0 ? sorted.slice(0, maxVisible - 1) : sorted;
  // the overflow chip occupies one more ring slot alongside the visible satellites
  const slotCount = visible.length + (overflow.length > 0 ? 1 : 0);

  const satellites: SatelliteNode[] = visible.map((task, i) => {
    const angle = angleForIndex(i, slotCount);
    const { x, y } = polarToXY(config.centerX, config.centerY, config.radius, angle);
    return { id: task.id, title: task.title, angle, x, y, pct: acceptancePct(task), needsYou: isNeedsYou(task), staggerIndex: i };
  });

  return { satellites, overflow };
}

/** Angle + position of the trailing "+N more" chip, when there is overflow — placed in the same
 *  ring slot sequence the visible satellites use (last slot), so it reads as "one more of these". */
export function overflowChipPosition(visibleCount: number, hasOverflow: boolean, config: SatelliteLayoutConfig): { x: number; y: number; angle: number } | null {
  if (!hasOverflow) return null;
  const slotCount = visibleCount + 1;
  const angle = angleForIndex(visibleCount, slotCount);
  const { x, y } = polarToXY(config.centerX, config.centerY, config.radius, angle);
  return { x, y, angle };
}
