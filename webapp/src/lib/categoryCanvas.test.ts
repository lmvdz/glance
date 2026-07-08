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
  maxSafeSatelliteRadius,
  overflowChipPosition,
  polarToXY,
  SATELLITE_CHIP_HALF_DIAGONAL,
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

// ── satellites: two-ring density + overflow (taste-review nit 1) ────────────────

const SAT_CONFIG = { centerX: 400, centerY: 300, radius: 150, outerRadius: 210, ringCapacity: 6 };

test("layoutSatellites: fewer than ringCapacity → everyone on ring 0, no overflow", () => {
  const tasks = Array.from({ length: 5 }, (_, i) => task({ id: `t${i}`, title: `Task ${i}` }));
  const { satellites, overflow } = layoutSatellites(tasks, SAT_CONFIG);
  expect(satellites.length).toBe(5);
  expect(satellites.every((s) => s.ring === 0)).toBe(true);
  expect(overflow.length).toBe(0);
});

test("layoutSatellites: more than ringCapacity but within maxVisible spills onto ring 1, at the outer radius", () => {
  const tasks = Array.from({ length: 10 }, (_, i) => task({ id: `t${i}`, title: `Task ${i}` }));
  const { satellites, overflow } = layoutSatellites(tasks, { ...SAT_CONFIG, maxVisible: 12 });
  expect(overflow.length).toBe(0);
  const ring0 = satellites.filter((s) => s.ring === 0);
  const ring1 = satellites.filter((s) => s.ring === 1);
  expect(ring0.length).toBe(6); // ringCapacity
  expect(ring1.length).toBe(4); // the remaining 10 - 6
  for (const s of ring0) expect(Math.hypot(s.x - SAT_CONFIG.centerX, s.y - SAT_CONFIG.centerY)).toBeCloseTo(SAT_CONFIG.radius, 6);
  for (const s of ring1) expect(Math.hypot(s.x - SAT_CONFIG.centerX, s.y - SAT_CONFIG.centerY)).toBeCloseTo(SAT_CONFIG.outerRadius, 6);
});

test("layoutSatellites: exactly maxVisible → still no overflow chip needed", () => {
  const tasks = Array.from({ length: 12 }, (_, i) => task({ id: `t${i}`, title: `Task ${i}` }));
  const { satellites, overflow } = layoutSatellites(tasks, { ...SAT_CONFIG, maxVisible: 12 });
  expect(satellites.length).toBe(12);
  expect(overflow.length).toBe(0);
});

test("layoutSatellites: dense (beyond maxVisible) folds the excess behind a virtual +N more slot on ring 1", () => {
  const tasks = Array.from({ length: 23 }, (_, i) => task({ id: `t${i}`, title: `Task ${String(i).padStart(2, "0")}` }));
  const { satellites, overflow, overflowChip } = layoutSatellites(tasks, { ...SAT_CONFIG, maxVisible: 12 });
  expect(satellites.length).toBe(11); // maxVisible - 1, room left for the chip
  expect(overflow.length).toBe(12); // 23 - 11
  expect(satellites.length + overflow.length).toBe(23);
  expect(overflowChip).not.toBeNull();
  expect(overflowChip!.ring).toBe(1);
  // the chip sits on the outer ring, same as every ring-1 satellite
  expect(Math.hypot(overflowChip!.x - SAT_CONFIG.centerX, overflowChip!.y - SAT_CONFIG.centerY)).toBeCloseTo(SAT_CONFIG.outerRadius, 6);
});

test("layoutSatellites: needs-you satellites survive the fold ahead of everything else", () => {
  const tasks = [
    ...Array.from({ length: 9 }, (_, i) => task({ id: `t${i}`, title: `zzz${i}` })), // sorts after "blocked"
    task({ id: "urgent", title: "aaa-urgent", tags: ["blocked"] }),
  ];
  const { satellites, overflow } = layoutSatellites(tasks, { ...SAT_CONFIG, maxVisible: 5 });
  expect(satellites.some((s) => s.id === "urgent")).toBe(true);
  expect(overflow.some((t) => t.id === "urgent")).toBe(false);
});

test("layoutSatellites is deterministic across both rings", () => {
  const tasks = Array.from({ length: 10 }, (_, i) => task({ id: `t${i}`, title: `Task ${i}` }));
  const a = layoutSatellites(tasks, { ...SAT_CONFIG, maxVisible: 12 });
  const b = layoutSatellites(tasks, { ...SAT_CONFIG, maxVisible: 12 });
  expect(a).toEqual(b);
});

test("layoutSatellites: no ring-capacity override falls back to a single ring at `radius` for a small set", () => {
  const tasks = Array.from({ length: 4 }, (_, i) => task({ id: `t${i}`, title: `Task ${i}` }));
  const { satellites } = layoutSatellites(tasks, { centerX: 400, centerY: 300, radius: 150 });
  expect(satellites.every((s) => s.ring === 0)).toBe(true);
  for (const s of satellites) expect(Math.hypot(s.x - 400, s.y - 300)).toBeCloseTo(150, 6);
});

test("layoutSatellites: pct reads acceptance-criteria completion; null when there are no criteria", () => {
  const withCriteria = task({ id: "a", acceptanceCriteria: [{ id: "1", text: "x", completed: true }, { id: "2", text: "y", completed: false }] });
  const withoutCriteria = task({ id: "b" });
  const { satellites } = layoutSatellites([withCriteria, withoutCriteria], SAT_CONFIG);
  expect(satellites.find((s) => s.id === "a")!.pct).toBe(50);
  expect(satellites.find((s) => s.id === "b")!.pct).toBeNull();
});

test("overflowChipPosition: null when nothing overflowed; otherwise sits on the outer ring, in the trailing slot", () => {
  expect(overflowChipPosition(5, false, SAT_CONFIG)).toBeNull();
  const pos = overflowChipPosition(5, true, SAT_CONFIG);
  expect(pos).not.toBeNull();
  expect(pos!.ring).toBe(1);
  const dist = Math.hypot(pos!.x - SAT_CONFIG.centerX, pos!.y - SAT_CONFIG.centerY);
  expect(dist).toBeCloseTo(SAT_CONFIG.outerRadius, 6);
});

// ── collision safety: satellites vs. the receded perimeter category nodes (nit 1) ──────────────

test("maxSafeSatelliteRadius: for the canvas's real viewport, the safe radius leaves the perimeter zone entirely clear", () => {
  const config = { width: 800, height: 560 };
  const safe = maxSafeSatelliteRadius(config);
  const perimeterRadius = Math.min(config.width, config.height) * 0.38 * 1.3;
  const perimeterNodeR = 28 * 0.75;
  // even a satellite chip centered exactly at `safe` radius, extended by its full footprint,
  // never reaches the near edge of the perimeter node band
  expect(safe + SATELLITE_CHIP_HALF_DIAGONAL).toBeLessThanOrEqual(perimeterRadius - perimeterNodeR);
});

test("maxSafeSatelliteRadius grows with a larger viewport and never goes negative for a tiny one", () => {
  expect(maxSafeSatelliteRadius({ width: 1600, height: 1200 })).toBeGreaterThan(maxSafeSatelliteRadius({ width: 800, height: 560 }));
  expect(maxSafeSatelliteRadius({ width: 40, height: 40 })).toBeGreaterThanOrEqual(0);
});

test("a dense (23-satellite) category, laid out at the collision-safe radii, never overlaps the receded perimeter nodes", () => {
  // Mirrors CategoryCanvas.tsx's real geometry: VIEWPORT 800x560, the same config layoutCanvas uses
  // for perimeter placement, and the component's RING_GAP/RING_CAPACITY/MAX_SATELLITES constants.
  const canvasConfig = { width: 800, height: 560 };
  const safeRadius = maxSafeSatelliteRadius(canvasConfig);
  const RING_GAP = 46;
  const innerRadius = Math.min(160, safeRadius - RING_GAP);
  const outerRadius = Math.min(innerRadius + RING_GAP, safeRadius);

  const buckets = groupTasksByCategory([
    task({ id: "frontend-bucket", category: "frontend" }),
    ...Array.from({ length: 23 }, (_, i) => task({ id: `dense${i}`, category: "backend", title: `Dense ${i}` })),
  ]);
  const nodes = layoutCanvas(buckets, "backend", canvasConfig);
  const perimeterNodes = nodes.filter((n) => n.id !== "backend"); // every receded sibling

  const backendBucket = buckets.find((b) => b.id === "backend")!;
  const { satellites, overflowChip } = layoutSatellites(backendBucket.tasks, {
    centerX: canvasConfig.width / 2,
    centerY: canvasConfig.height / 2,
    radius: innerRadius,
    outerRadius,
    ringCapacity: 6,
    maxVisible: 12,
  });

  const centerX = canvasConfig.width / 2, centerY = canvasConfig.height / 2;
  for (const perimeterNode of perimeterNodes) {
    const perimeterDist = Math.hypot(perimeterNode.targetX - centerX, perimeterNode.targetY - centerY);
    for (const sat of satellites) {
      const satDist = Math.hypot(sat.x - centerX, sat.y - centerY);
      // every satellite's full chip footprint stays strictly inside the perimeter node's near edge
      expect(satDist + SATELLITE_CHIP_HALF_DIAGONAL).toBeLessThan(perimeterDist - perimeterNode.targetR);
    }
    if (overflowChip) {
      const chipDist = Math.hypot(overflowChip.x - centerX, overflowChip.y - centerY);
      expect(chipDist + SATELLITE_CHIP_HALF_DIAGONAL).toBeLessThan(perimeterDist - perimeterNode.targetR);
    }
  }
});
