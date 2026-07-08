/**
 * CategoryCanvas — the Category Canvas (plans/orchestration/CANVAS-AND-PAGE-CHAT.md Feature 1,
 * D2/D3/D6/D7). Constellations, not a force-graph: categories sit on a deterministic radial ring
 * sized by open work; selecting one is a GPU-transform "shared-element move" to center while
 * siblings recede to a faded perimeter — ONE canvas element throughout, no page swap. Plans
 * materialize as staggered DOM-overlay satellite chips (title + StatusChip + an acceptance-
 * criteria % ring). All the geometry is `../lib/categoryCanvas.ts` — pure and unit-tested; this
 * file only renders it and wires interaction.
 *
 * Pure of routing decisions: it takes tasks + callbacks as props (no TaskContext import), so
 * whoever wires the LIST|CANVAS toggle (sibling unit C3) can drop it in without this file knowing
 * anything about `view`/`setView`. Plan click just calls the `onSelectTask` prop straight through
 * to TaskContext's `selectTask` — the same one TaskListView's rows call today.
 *
 * `CategoryCanvasView` is the stateless render — selection is a controlled prop — so tests can
 * assert the idle/selected/dense/empty markup directly via `renderToStaticMarkup` without
 * simulating clicks. `CategoryCanvas` (default export) is the stateful wrapper the app mounts:
 * it owns selectedCategoryId/focus state, the Esc/perimeter/breadcrumb back-out, and the
 * reduced-motion check.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "../types";
import { StatusChip, Kbd, MonoLabel } from "./kit";
import {
  categoryRimColor,
  groupTasksByCategory,
  isNeedsYou,
  layoutCanvas,
  layoutSatellites,
  overflowChipPosition,
  type CanvasNode,
  type SatelliteNode,
} from "../lib/categoryCanvas";

const VIEWPORT = { width: 800, height: 560 };
const SATELLITE_RADIUS = 160;
const MAX_SATELLITES = 24;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

/** A tiny inline progress ring — the acceptance-criteria % math the list view's `%` column
 *  already computes (done/total), drawn as a ring instead of a bar for the satellite chip. */
const ProgressRing: React.FC<{ pct: number | null; size?: number }> = ({ pct, size = 20 }) => {
  const r = size / 2 - 2;
  const c = 2 * Math.PI * r;
  const dash = pct === null ? 0 : (pct / 100) * c;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="flex-shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.15} strokeWidth={2} />
      {pct !== null && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={pct >= 100 ? "#4ADE80" : "var(--wf-accent)"}
          strokeWidth={2}
          strokeDasharray={`${dash} ${c - dash}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
    </svg>
  );
};

/** Percent position, expressed against the fixed VIEWPORT, so the DOM overlay lines up with the
 *  SVG regardless of the container's actual rendered size (the wrapper is kept at the same aspect
 *  ratio as VIEWPORT, so no letterboxing skew is possible). */
function pct(value: number, total: number): string {
  return `${(value / total) * 100}%`;
}

interface CategoryNodeViewProps {
  node: CanvasNode;
  focused: boolean;
  tabIndex: number;
  reducedMotion: boolean;
  onSelect: () => void;
  onFocus: () => void;
  onArrow: (dir: -1 | 1) => void;
  registerRef: (el: HTMLButtonElement | null) => void;
}

/** The decorative rim + count — MUST live inside the `<svg>` (an SVG `<g>` rendered under a
 *  plain `<div>` is invalid markup and silently fails to position: the browser drops it out of
 *  the SVG coordinate system entirely, so every node's circle/text collapses to one spot). */
const CategoryNodeSvg: React.FC<{ node: CanvasNode; reducedMotion: boolean }> = ({ node, reducedMotion }) => {
  const rim = categoryRimColor(node.id);
  return (
    <g
      aria-hidden="true"
      style={{
        transform: `translate(${node.targetX}px, ${node.targetY}px)`,
        transition: reducedMotion ? "none" : "transform 0.5s cubic-bezier(0.22, 1, 0.36, 1)",
      }}
    >
      <circle
        r={node.targetR}
        fill="var(--wf-surface)"
        stroke={rim}
        strokeWidth={node.selected ? 2.5 : 1.5}
        vectorEffect="non-scaling-stroke"
        opacity={node.faded ? 0.35 : 1}
      />
      {node.needsYouCount > 0 && (
        <circle cx={node.targetR * 0.68} cy={-node.targetR * 0.68} r={5} fill="var(--wf-accent)" opacity={node.faded ? 0.5 : 1} />
      )}
      <text textAnchor="middle" dominantBaseline="central" y={-2} fontSize={node.selected ? 15 : 12} fontFamily="JetBrains Mono, ui-monospace" fill="var(--wf-text)" opacity={node.faded ? 0.5 : node.dimmed ? 0.45 : 1}>
        {node.openCount}
      </text>
    </g>
  );
};

/** The real, focusable, ≥44px hit target — a DOM overlay sibling of the `<svg>`, positioned by
 *  percentage against the same fixed VIEWPORT so it lines up with the decorative circle above it. */
const CategoryNodeButton: React.FC<CategoryNodeViewProps> = ({ node, focused, tabIndex, reducedMotion, onSelect, onFocus, onArrow, registerRef }) => {
  const rim = categoryRimColor(node.id);
  return (
    <button
      ref={registerRef}
      type="button"
      tabIndex={tabIndex}
      onFocus={onFocus}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); onArrow(1); }
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); onArrow(-1); }
      }}
      aria-label={`${node.label}: ${node.openCount} open${node.needsYouCount > 0 ? `, ${node.needsYouCount} needs you` : ""}`}
      aria-current={node.selected ? "true" : undefined}
      className="absolute flex flex-col items-center justify-center gap-0.5 rounded-full outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-[color:var(--wf-accent)] focus-visible:ring-offset-2"
      style={{
        left: pct(node.targetX, VIEWPORT.width),
        top: pct(node.targetY, VIEWPORT.height),
        width: Math.max(44, node.targetR * 2),
        height: Math.max(44, node.targetR * 2),
        transform: "translate(-50%, -50%)",
        transition: reducedMotion ? "none" : "left 0.5s cubic-bezier(0.22, 1, 0.36, 1), top 0.5s cubic-bezier(0.22, 1, 0.36, 1), width 0.5s, height 0.5s",
      }}
    >
      <span className="pointer-events-none translate-y-[calc(50%+6px)] whitespace-nowrap rounded-sm border px-1 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide" style={{ borderColor: rim, color: rim, opacity: node.faded ? 0.55 : 1, backgroundColor: "var(--wf-surface)" }}>
        {node.label}
      </span>
      {focused && <span className="sr-only">(focused)</span>}
    </button>
  );
};

const SatelliteChip: React.FC<{ sat: SatelliteNode; index: number; reducedMotion: boolean; onSelect: () => void }> = ({ sat, index, reducedMotion, onSelect }) => (
  <button
    type="button"
    onClick={(e) => { e.stopPropagation(); onSelect(); }}
    className="absolute flex min-h-[44px] min-w-[44px] max-w-[168px] flex-col items-start gap-1 rounded-md border border-[color:var(--wf-border,#2A2A2E)] bg-[color:var(--wf-surface)] px-2 py-1.5 text-left shadow-sm outline-none transition-transform hover:border-[color:var(--wf-accent)] focus-visible:ring-2 focus-visible:ring-[color:var(--wf-accent)] focus-visible:ring-offset-2"
    style={{
      left: pct(sat.x, VIEWPORT.width),
      top: pct(sat.y, VIEWPORT.height),
      transform: "translate(-50%, -50%)",
      animation: reducedMotion ? undefined : `cc-satellite-rise 0.4s cubic-bezier(0.22, 1, 0.36, 1) both`,
      animationDelay: reducedMotion ? undefined : `${Math.min(index * 30, 360)}ms`,
    }}
    title={sat.title}
  >
    <div className="flex w-full items-center gap-1.5">
      <ProgressRing pct={sat.pct} size={16} />
      <span className="truncate text-[11px] font-medium text-[color:var(--wf-text)]">{sat.title}</span>
    </div>
    {sat.needsYou && <StatusChip status="input" className="scale-90 origin-left" />}
  </button>
);

export interface CategoryCanvasViewProps {
  tasks: Task[];
  selectedCategoryId: string | null;
  onSelectCategory: (id: string) => void;
  onSelectTask: (taskId: string) => void;
  onBack: () => void;
  onShowMore?: (categoryId: string, taskIds: string[]) => void;
  reducedMotion?: boolean;
  focusedCategoryId?: string | null;
  onFocusCategory?: (id: string) => void;
  className?: string;
}

/** Stateless render — selection is a controlled prop, so this is fully deterministic and
 *  screenshot/test-stable for a given (tasks, selectedCategoryId) pair. */
export const CategoryCanvasView: React.FC<CategoryCanvasViewProps> = ({
  tasks,
  selectedCategoryId,
  onSelectCategory,
  onSelectTask,
  onBack,
  onShowMore,
  reducedMotion = false,
  focusedCategoryId,
  onFocusCategory,
  className,
}) => {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const buckets = useMemo(() => groupTasksByCategory(tasks), [tasks]);
  const totalOpen = useMemo(() => buckets.reduce((sum, b) => sum + b.openCount, 0), [buckets]);
  const nodes = useMemo(() => layoutCanvas(buckets, selectedCategoryId, VIEWPORT), [buckets, selectedCategoryId]);
  const selectedBucket = selectedCategoryId ? buckets.find((b) => b.id === selectedCategoryId) : undefined;
  // Denser categories get a wider satellite ring so chips have room to breathe — capped by the
  // viewport so it never pushes satellites past the visible canvas.
  const satRadius = selectedBucket
    ? Math.min(SATELLITE_RADIUS + Math.max(0, Math.min(selectedBucket.tasks.length, MAX_SATELLITES) - 6) * 6, VIEWPORT.height / 2 - 40)
    : SATELLITE_RADIUS;
  const satelliteLayout = useMemo(
    () => (selectedBucket ? layoutSatellites(selectedBucket.tasks, { centerX: VIEWPORT.width / 2, centerY: VIEWPORT.height / 2, radius: satRadius, maxVisible: MAX_SATELLITES }) : null),
    [selectedBucket, satRadius],
  );
  const overflowPos = satelliteLayout && selectedBucket
    ? overflowChipPosition(satelliteLayout.satellites.length, satelliteLayout.overflow.length > 0, { centerX: VIEWPORT.width / 2, centerY: VIEWPORT.height / 2, radius: satRadius })
    : null;

  const focusIndex = focusedCategoryId ? buckets.findIndex((b) => b.id === focusedCategoryId) : -1;
  const moveFocus = (dir: -1 | 1): void => {
    const from = focusIndex >= 0 ? focusIndex : 0;
    const next = (from + dir + buckets.length) % buckets.length;
    buttonRefs.current[next]?.focus();
  };

  if (totalOpen === 0) {
    // D6: "Zero open → calm one-liner (existing empty-state voice)" — the same restrained
    // register TaskListView's own empty state uses, not a broken-looking dimmed ring.
    return (
      <div className={`flex h-full flex-1 flex-col items-center justify-center gap-2 py-24 text-center text-gray-500 dark:text-gray-400 ${className ?? ""}`}>
        <div className="text-sm font-medium">Nothing open, in any category.</div>
        <div className="text-xs">Plans and features will concentrate here as the fleet picks up work.</div>
      </div>
    );
  }

  return (
    <div
      className={`relative flex h-full flex-1 flex-col overflow-hidden bg-white dark:bg-gray-950 ${className ?? ""}`}
      data-testid="category-canvas"
    >
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-gray-200 px-5 py-3 dark:border-gray-800">
        <MonoLabel>Categories</MonoLabel>
        {selectedBucket ? (
          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs">
            <button type="button" onClick={onBack} className="rounded px-1 py-0.5 font-medium text-[color:var(--wf-accent)] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[color:var(--wf-accent)]">
              All categories
            </button>
            <span className="text-gray-400">/</span>
            <span className="text-gray-700 dark:text-gray-300">{selectedBucket.label}</span>
          </nav>
        ) : (
          <span className="text-[11px] text-gray-400">select a category to see its plans</span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <Kbd keys="←→" label="cycle" />
          <Kbd keys="↵" label="select" />
          <Kbd keys="Esc" label="back" />
        </span>
      </div>

      <div
        className="relative flex-1"
        style={{ aspectRatio: `${VIEWPORT.width} / ${VIEWPORT.height}`, maxHeight: "100%", margin: "0 auto" }}
        onClick={(e) => {
          if (selectedCategoryId && !(e.target as HTMLElement).closest("button")) onBack();
        }}
      >
        <svg viewBox={`0 0 ${VIEWPORT.width} ${VIEWPORT.height}`} className="absolute inset-0 h-full w-full" role="img" aria-label="Category constellation">
          {/* Edges: a thin hairline from each satellite back to its selected category's center — "edges", per D7. */}
          {selectedBucket && satelliteLayout && satelliteLayout.satellites.map((s) => (
            <line key={`edge-${s.id}`} x1={VIEWPORT.width / 2} y1={VIEWPORT.height / 2} x2={s.x} y2={s.y} stroke="var(--wf-border, #2A2A2E)" strokeWidth={1} opacity={0.5} />
          ))}
          {nodes.map((node) => <CategoryNodeSvg key={node.id} node={node} reducedMotion={reducedMotion} />)}
        </svg>

        <div className="absolute inset-0">
          {nodes.map((node, i) => (
            <CategoryNodeButton
              key={node.id}
              node={node}
              focused={node.id === focusedCategoryId}
              tabIndex={buckets.length > 0 && (focusedCategoryId ? node.id === focusedCategoryId : i === 0) ? 0 : -1}
              reducedMotion={reducedMotion}
              onSelect={() => onSelectCategory(node.id)}
              onFocus={() => onFocusCategory?.(node.id)}
              onArrow={moveFocus}
              registerRef={(el) => { buttonRefs.current[i] = el; }}
            />
          ))}
        </div>

        {selectedBucket && selectedBucket.tasks.length === 0 && (
          <div className="absolute left-1/2 top-[78%] w-64 -translate-x-1/2 text-center text-xs text-gray-400" style={{ top: `${((VIEWPORT.height / 2 + 90) / VIEWPORT.height) * 100}%` }}>
            No plans yet in {selectedBucket.label}.
          </div>
        )}

        {satelliteLayout && satelliteLayout.satellites.map((sat, i) => (
          <SatelliteChip key={sat.id} sat={sat} index={i} reducedMotion={reducedMotion} onSelect={() => onSelectTask(sat.id)} />
        ))}

        {overflowPos && selectedBucket && satelliteLayout && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onShowMore?.(selectedBucket.id, satelliteLayout.overflow.map((t) => t.id));
            }}
            className="absolute flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full border border-dashed border-gray-400 bg-[color:var(--wf-surface)] px-2 text-[11px] font-medium text-gray-500 outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--wf-accent)]"
            style={{ left: pct(overflowPos.x, VIEWPORT.width), top: pct(overflowPos.y, VIEWPORT.height), transform: "translate(-50%, -50%)" }}
          >
            +{satelliteLayout.overflow.length} more
          </button>
        )}
      </div>

      <style>{`@keyframes cc-satellite-rise { from { opacity: 0; transform: translate(-50%, calc(-50% + 6px)); } to { opacity: 1; transform: translate(-50%, -50%); } }`}</style>
    </div>
  );
};

export interface CategoryCanvasProps {
  /** Live features, already resolved to Tasks (TaskContext's shape) — no new endpoint, per D5. */
  tasks: Task[];
  /** Plan click → selectTask → TaskDetail. The caller passes TaskContext's `selectTask` straight through. */
  onSelectTask: (taskId: string) => void;
  /** D6: >~24 satellites virtualize behind a "+N more" chip that routes to a filtered list —
   *  the routing decision belongs to whoever mounts this (e.g. switch to LIST + apply a category
   *  filter). Optional: omitting it still renders the chip, it simply has nowhere to send the click. */
  onShowMore?: (categoryId: string, taskIds: string[]) => void;
  className?: string;
}

/** The stateful entry point the app mounts. Owns selection/focus/back-out + the reduced-motion
 *  check; delegates all geometry + rendering to `CategoryCanvasView`. */
export const CategoryCanvas: React.FC<CategoryCanvasProps> = ({ tasks, onSelectTask, onShowMore, className }) => {
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [focusedCategoryId, setFocusedCategoryId] = useState<string | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "Escape" && selectedCategoryId) { e.preventDefault(); setSelectedCategoryId(null); }
      }}
      className="flex h-full flex-1 flex-col"
    >
      <CategoryCanvasView
        tasks={tasks}
        selectedCategoryId={selectedCategoryId}
        onSelectCategory={setSelectedCategoryId}
        onSelectTask={onSelectTask}
        onBack={() => setSelectedCategoryId(null)}
        onShowMore={onShowMore}
        reducedMotion={reducedMotion}
        focusedCategoryId={focusedCategoryId}
        onFocusCategory={setFocusedCategoryId}
        className={className}
      />
    </div>
  );
};

export default CategoryCanvas;
