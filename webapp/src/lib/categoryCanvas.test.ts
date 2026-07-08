import { expect, test } from "bun:test";
import {
  angleForIndex,
  categoryLabel,
  categoryRimColor,
  groupTasksByCategory,
  isNeedsYou,
  layoutCanvas,
  layoutCategoryRing,
  layoutSatellites,
  overflowChipPosition,
  polarToXY,
  CATEGORY_ORDER,
} from "./categoryCanvas";
import type { Task } from "../types";

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    category: overrides.category ?? "frontend",
    duration: "1a",
    status: overrides.status ?? "active",
    description: "",
    acceptanceCriteria: overrides.acceptanceCriteria ?? [],
    contextBundle: { spec: "plans/x", criteria: "", prerequisites: "", decisions: "", downstream: "" },
    decisions: [],
    relationships: [],
    properties: { status: "In Progress", priority: null, assignee: null, project: { id: "p", name: "p", shortCode: "P", colorClass: "" }, estimate: null },
    tags: overrides.tags ?? [],
    proofProvenance: { source: { type: "manual", label: "manual" }, worktrees: [], candidates: [] },
    ...overrides,
  };
}

// ── grouping ──────────────────────────────────────────────────────────────────

test("groupTasksByCategory always renders every canonical category, even with zero tasks", () => {
  const buckets = groupTasksByCategory([]);
  expect(buckets.map((b) => b.id)).toEqual([...CATEGORY_ORDER]);
  expect(buckets.every((b) => b.totalCount === 0 && b.openCount === 0)).toBe(true);
});

test("groupTasksByCategory reads task.category — it does not re-derive it", () => {
  const tasks = [task({ id: "a", category: "backend" }), task({ id: "b", category: "backend" }), task({ id: "c", category: "database" })];
  const buckets = groupTasksByCategory(tasks);
  const backend = buckets.find((b) => b.id === "backend")!;
  const database = buckets.find((b) => b.id === "database")!;
  expect(backend.totalCount).toBe(2);
  expect(database.totalCount).toBe(1);
});

test("groupTasksByCategory appends an unrecognized category id alphabetically after the canonical order", () => {
  const tasks = [task({ id: "a", category: "zzz-future" as Task["category"] })];
  const buckets = groupTasksByCategory(tasks);
  expect(buckets.at(-1)!.id).toBe("zzz-future");
});

test("openCount excludes done tasks; needsYouCount counts blocked/input tags", () => {
  const tasks = [
    task({ id: "a", category: "backend", status: "done" }),
    task({ id: "b", category: "backend", status: "active", tags: ["blocked"] }),
    task({ id: "c", category: "backend", status: "active", tags: ["input"] }),
    task({ id: "d", category: "backend", status: "active" }),
  ];
  const backend = groupTasksByCategory(tasks).find((b) => b.id === "backend")!;
  expect(backend.totalCount).toBe(4);
  expect(backend.openCount).toBe(3); // excludes the done one
  expect(backend.needsYouCount).toBe(2);
});

test("isNeedsYou is true for blocked or input tags, false otherwise", () => {
  expect(isNeedsYou(task({ id: "a", tags: ["blocked"] }))).toBe(true);
  expect(isNeedsYou(task({ id: "b", tags: ["input"] }))).toBe(true);
  expect(isNeedsYou(task({ id: "c", tags: ["done"] }))).toBe(false);
  expect(isNeedsYou(task({ id: "d", tags: [] }))).toBe(false);
});

test("categoryLabel/categoryRimColor fall back gracefully for an unknown id", () => {
  expect(categoryLabel("weird")).toBe("Weird");
  expect(categoryRimColor("weird")).toBe(categoryRimColor("other"));
});

// ── angle math ────────────────────────────────────────────────────────────────

test("angleForIndex: two categories form a horizontal centered pair (left/right), not top/bottom", () => {
  expect(angleForIndex(0, 2)).toBe(270); // left
  expect(angleForIndex(1, 2)).toBe(90); // right
});

test("angleForIndex: n>=3 is evenly spaced starting at 12 o'clock, clockwise", () => {
  expect(angleForIndex(0, 4)).toBe(0);
  expect(angleForIndex(1, 4)).toBe(90);
  expect(angleForIndex(2, 4)).toBe(180);
  expect(angleForIndex(3, 4)).toBe(270);
});

test("angleForIndex: single node sits at top; count<=0 is defined (0)", () => {
  expect(angleForIndex(0, 1)).toBe(0);
  expect(angleForIndex(0, 0)).toBe(0);
});

test("polarToXY: top/right/bottom/left land exactly where clock convention says", () => {
  const cx = 100, cy = 100, r = 50;
  expect(polarToXY(cx, cy, r, 0)).toEqual({ x: 100, y: 50 }); // top
  const right = polarToXY(cx, cy, r, 90);
  expect(right.x).toBeCloseTo(150, 6);
  expect(right.y).toBeCloseTo(100, 6);
  const bottom = polarToXY(cx, cy, r, 180);
  expect(bottom.x).toBeCloseTo(100, 6);
  expect(bottom.y).toBeCloseTo(150, 6);
  const left = polarToXY(cx, cy, r, 270);
  expect(left.x).toBeCloseTo(50, 6);
  expect(left.y).toBeCloseTo(100, 6);
});

// ── ring layout: determinism, sizing, wrap ──────────────────────────────────────

const CONFIG = { width: 800, height: 600 };

test("layoutCategoryRing is deterministic: same buckets + config → identical output", () => {
  const tasks = [task({ id: "a", category: "backend" }), task({ id: "b", category: "frontend" })];
  const a = layoutCategoryRing(groupTasksByCategory(tasks), CONFIG);
  const b = layoutCategoryRing(groupTasksByCategory(tasks), CONFIG);
  expect(a).toEqual(b);
});

test("sizing is area-proportional (sqrt of open count) and clamped to [minNodeRadius, maxNodeRadius]", () => {
  const tasks = [
    ...Array.from({ length: 8 }, (_, i) => task({ id: `f${i}`, category: "frontend" })),
    task({ id: "b0", category: "backend" }),
  ];
  const nodes = layoutCategoryRing(groupTasksByCategory(tasks), { ...CONFIG, minNodeRadius: 20, maxNodeRadius: 60 });
  const frontend = nodes.find((n) => n.id === "frontend")!; // 8 open — the max
  const backend = nodes.find((n) => n.id === "backend")!; // 1 open
  const database = nodes.find((n) => n.id === "database")!; // 0 open

  expect(frontend.r).toBe(60); // sqrt(8/8) = 1 → maxNodeRadius exactly
  expect(backend.r).toBeCloseTo(20 + (60 - 20) * Math.sqrt(1 / 8), 6);
  expect(backend.r).toBeGreaterThan(20);
  expect(backend.r).toBeLessThan(frontend.r);
  expect(database.r).toBe(20); // empty → minNodeRadius
  expect(database.dimmed).toBe(true);
  expect(frontend.dimmed).toBe(false);
});

test("all-empty buckets: every node sizes to minNodeRadius, no NaN/divide-by-zero", () => {
  const nodes = layoutCategoryRing(groupTasksByCategory([]), { ...CONFIG, minNodeRadius: 22, maxNodeRadius: 60 });
  expect(nodes.every((n) => n.r === 22 && n.dimmed)).toBe(true);
  expect(nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
});

test("dense wrap: categories beyond wrapThreshold spill onto a second, larger-radius ring", () => {
  const buckets = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, label: `c${i}`, tasks: [], openCount: 1, totalCount: 1, needsYouCount: 0 }));
  const nodes = layoutCategoryRing(buckets, { ...CONFIG, wrapThreshold: 8, ringRadius: 100 });
  const ring0 = nodes.filter((n) => n.ring === 0);
  const ring1 = nodes.filter((n) => n.ring === 1);
  expect(ring0.length).toBe(8);
  expect(ring1.length).toBe(2);
  // the outer ring sits strictly farther from center than the inner one
  const dist = (n: (typeof nodes)[number]) => Math.hypot(n.x - CONFIG.width / 2, n.y - CONFIG.height / 2);
  expect(Math.min(...ring1.map(dist))).toBeGreaterThan(Math.max(...ring0.map(dist)));
});

test("a single ring (count <= wrapThreshold) never wraps", () => {
  const buckets = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, label: `c${i}`, tasks: [], openCount: 0, totalCount: 0, needsYouCount: 0 }));
  const nodes = layoutCategoryRing(buckets, CONFIG);
  expect(nodes.every((n) => n.ring === 0)).toBe(true);
});

// ── selection transition ────────────────────────────────────────────────────────

test("layoutCanvas: with no selection, target === idle position for every node (no transform needed at rest)", () => {
  const tasks = [task({ id: "a", category: "backend" }), task({ id: "b", category: "frontend" })];
  const nodes = layoutCanvas(groupTasksByCategory(tasks), null, CONFIG);
  for (const n of nodes) {
    expect(n.targetX).toBe(n.x);
    expect(n.targetY).toBe(n.y);
    expect(n.targetR).toBe(n.r);
    expect(n.faded).toBe(false);
    expect(n.selected).toBe(false);
  }
});

test("layoutCanvas: the selected node's target is exact canvas center and larger; siblings recede faded to a wider perimeter", () => {
  const tasks = [task({ id: "a", category: "backend" }), task({ id: "b", category: "frontend" }), task({ id: "c", category: "devops" })];
  const nodes = layoutCanvas(groupTasksByCategory(tasks), "backend", CONFIG);
  const selected = nodes.find((n) => n.id === "backend")!;
  const sibling = nodes.find((n) => n.id === "frontend")!;

  expect(selected.targetX).toBe(CONFIG.width / 2);
  expect(selected.targetY).toBe(CONFIG.height / 2);
  expect(selected.selected).toBe(true);
  expect(selected.faded).toBe(false);
  expect(selected.targetR).toBeGreaterThan(selected.r);

  expect(sibling.faded).toBe(true);
  expect(sibling.selected).toBe(false);
  const siblingDistFromCenter = Math.hypot(sibling.targetX - CONFIG.width / 2, sibling.targetY - CONFIG.height / 2);
  const idleDistFromCenter = Math.hypot(sibling.x - CONFIG.width / 2, sibling.y - CONFIG.height / 2);
  expect(siblingDistFromCenter).toBeGreaterThan(idleDistFromCenter); // recede outward
  expect(sibling.targetR).toBeLessThan(sibling.r); // shrink
});

test("layoutCanvas is deterministic for a fixed selection", () => {
  const tasks = [task({ id: "a", category: "backend" }), task({ id: "b", category: "frontend" })];
  const buckets = groupTasksByCategory(tasks);
  expect(layoutCanvas(buckets, "backend", CONFIG)).toEqual(layoutCanvas(buckets, "backend", CONFIG));
});

// ── satellites: dense wrap + overflow ────────────────────────────────────────────

const SAT_CONFIG = { centerX: 400, centerY: 300, radius: 150 };

test("layoutSatellites: fewer than the cap → everyone visible, no overflow", () => {
  const tasks = Array.from({ length: 5 }, (_, i) => task({ id: `t${i}`, title: `Task ${i}` }));
  const { satellites, overflow } = layoutSatellites(tasks, SAT_CONFIG);
  expect(satellites.length).toBe(5);
  expect(overflow.length).toBe(0);
});

test("layoutSatellites: exactly maxVisible → still no overflow chip needed", () => {
  const tasks = Array.from({ length: 24 }, (_, i) => task({ id: `t${i}`, title: `Task ${i}` }));
  const { satellites, overflow } = layoutSatellites(tasks, SAT_CONFIG);
  expect(satellites.length).toBe(24);
  expect(overflow.length).toBe(0);
});

test("layoutSatellites: dense (>24) folds the excess behind a virtual +N more slot", () => {
  const tasks = Array.from({ length: 30 }, (_, i) => task({ id: `t${i}`, title: `Task ${String(i).padStart(2, "0")}` }));
  const { satellites, overflow } = layoutSatellites(tasks, SAT_CONFIG);
  expect(satellites.length).toBe(23); // maxVisible - 1, room left for the chip
  expect(overflow.length).toBe(7); // 30 - 23
  expect(satellites.length + overflow.length).toBe(30);
});

test("layoutSatellites: needs-you satellites survive the fold ahead of everything else", () => {
  const tasks = [
    ...Array.from({ length: 23 }, (_, i) => task({ id: `t${i}`, title: `zzz${i}` })), // sorts after "blocked"
    task({ id: "urgent", title: "aaa-urgent", tags: ["blocked"] }),
  ];
  const { satellites, overflow } = layoutSatellites(tasks, { ...SAT_CONFIG, maxVisible: 10 });
  expect(satellites.some((s) => s.id === "urgent")).toBe(true);
  expect(overflow.some((t) => t.id === "urgent")).toBe(false);
});

test("layoutSatellites is deterministic and positions land on the given radius from center", () => {
  const tasks = Array.from({ length: 4 }, (_, i) => task({ id: `t${i}`, title: `Task ${i}` }));
  const a = layoutSatellites(tasks, SAT_CONFIG);
  const b = layoutSatellites(tasks, SAT_CONFIG);
  expect(a).toEqual(b);
  for (const s of a.satellites) {
    const dist = Math.hypot(s.x - SAT_CONFIG.centerX, s.y - SAT_CONFIG.centerY);
    expect(dist).toBeCloseTo(SAT_CONFIG.radius, 6);
  }
});

test("layoutSatellites: pct reads acceptance-criteria completion; null when there are no criteria", () => {
  const withCriteria = task({ id: "a", acceptanceCriteria: [{ id: "1", text: "x", completed: true }, { id: "2", text: "y", completed: false }] });
  const withoutCriteria = task({ id: "b" });
  const { satellites } = layoutSatellites([withCriteria, withoutCriteria], SAT_CONFIG);
  expect(satellites.find((s) => s.id === "a")!.pct).toBe(50);
  expect(satellites.find((s) => s.id === "b")!.pct).toBeNull();
});

test("overflowChipPosition: null when nothing overflowed; otherwise sits in the trailing ring slot", () => {
  expect(overflowChipPosition(5, false, SAT_CONFIG)).toBeNull();
  const pos = overflowChipPosition(5, true, SAT_CONFIG);
  expect(pos).not.toBeNull();
  const dist = Math.hypot(pos!.x - SAT_CONFIG.centerX, pos!.y - SAT_CONFIG.centerY);
  expect(dist).toBeCloseTo(SAT_CONFIG.radius, 6);
});
