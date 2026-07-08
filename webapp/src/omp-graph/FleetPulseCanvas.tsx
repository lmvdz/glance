/**
 * FleetPulseCanvas — the fleet-pulse renderer (docs/design/fleet-pulse/DESIGN.md)
 * over live GraphDoc data. One composition around a central day spine:
 *
 *   MILESTONES   commit marks hang from a top rail; per-day label stacks
 *   FLEET PULSE  cost heartbeat + magma commit bars on ONE baseline, cumulative
 *                strand, model/harness attribution bands + plan-worth chip
 *   SPINE        fleet state band · day names · adaptive hour ruler
 *   AGENT RUNS   duration pills (live runs grow to NOW) + loop metronome
 *   SHIPPED      tickets/loop-notes/needs-you/meeting ghosts on hanging labels
 *
 * Canvas semantics: wheel zooms (cursor-anchored), drag pans (pointer capture
 * only AFTER movement — captured pointers retarget clicks at the svg and eat
 * them), hover is zone-aware (x = instant, y = layer) via getScreenCTM so
 * letterboxing can't skew it. DEPTH mode renders history weeks as an isometric
 * massif (rates = terrain, cumulative = strands). Always dark — that is the
 * language of this chart, like the activity heatmap.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AttributionDoc, ProvenanceDoc } from './types';
import type { PulseModel, PulseSession } from './pulse-model';
import { HOUR_MS } from './pulse-model';
import type { InspectSel } from './inspect';
import type { Collision } from '../lib/insights';

// ── palette (the locked color grammar) ────────────────────────────────────────
const INK = { hi: '#ECE7DC', mid: '#9BA0AB', low: '#565C68', faint: '#363B46' };
const EMBER = '#F2913D';
const EMBER_DEEP = '#B25E1E';
const CHURN_COL = '#A03A6E';
const COOL = '#4E7FDB';
const GOOD = '#4CAF7A';
const ALERT = '#E5484D';
const HAIRLINE = '#171B23';
const HAIRLINE2 = '#232936';
const GROUND = '#08090C';

const KIND_COL: Record<string, string> = {
  LAND: EMBER, FEAT: '#E8B24A', FIX: '#E0552F', DOCS: '#8A8F9B', OTHER: '#6B7280',
  DONE: GOOD, LOOP: COOL, BLOCKED: ALERT, READY: EMBER, MEETING: '#2FB6D6',
};
const SESS_COL: Record<PulseSession['status'], string> = { working: COOL, stopped: INK.low, error: ALERT, blocked: ALERT };
const MODEL_COL: Record<string, string> = { fable: '#E8B24A', opus: '#D9A441', sonnet: '#7B9FE0', haiku: '#8A8F9B', openai: '#66C7B0', gemini: '#B08BE8', other: '#6B7280', unknown: '#4A505C' };
const HARNESS_COL: Record<string, string> = { omp: EMBER, codex: '#66C7B0', 'claude-code': '#B08BE8', hermes: '#E08A8E', other: '#6B7280' };
export const modelColor = (m: string): string => MODEL_COL[m] ?? '#6B7280';
export const harnessColor = (h: string): string => HARNESS_COL[h] ?? '#6B7280';

// continuous ramps — quantized steps band when they feed gradients
const RAMP_MAGMA: [number, string][] = [[0, '#7A3B12'], [0.35, '#B25E1E'], [0.6, '#F2913D'], [0.8, '#FFC96B'], [1, '#FFE9C4']];
const RAMP_CHURN: [number, string][] = [[0, '#3D1230'], [0.35, '#5A2140'], [0.6, '#A03A6E'], [0.8, '#E86BA8'], [1, '#FFD9EC']];
function rampColor(ramp: [number, string][], tRaw: number): string {
  const t = Math.max(0, Math.min(1, tRaw));
  for (let i = 1; i < ramp.length; i++) {
    if (t <= ramp[i][0]) {
      const [t0, c0] = ramp[i - 1];
      const [t1, c1] = ramp[i];
      const f = (t - t0) / (t1 - t0 || 1);
      const hx = (c: string, j: number) => parseInt(c.slice(1 + j * 2, 3 + j * 2), 16);
      const mix = (j: number) => Math.round(hx(c0, j) + (hx(c1, j) - hx(c0, j)) * f);
      return `rgb(${mix(0)},${mix(1)},${mix(2)})`;
    }
  }
  return ramp[ramp.length - 1][1];
}
export const heatColor = (t: number): string => rampColor(RAMP_MAGMA, t);

// ── vertical anatomy (viewBox coordinates; width adapts) ─────────────────────
const PAD_L = 40;
const PAD_R = 20;
const TOPLINE = 16;
const RAIL = 44;
const PULSE_TOP = 262;
const PULSE_BASE = 478;
const BAR_MAX = 128;
const SPINE = 500;
const SESS_TOP = 552;
const SESS_ROW_H = 9;
const METRO_Y = 664;
const EVT_BASE = 692;
const EVT_ROW_H = 25;
const H = 852;
const MIN_SPAN = 6 * HOUR_MS;

const fmtHm = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const fmtWhen = (ms: number): string => {
  const d = new Date(ms);
  return `${d.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase()} · ${fmtHm(ms)}`;
};
const trim = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${Math.round(n)}`);

// ── depth-mode week row ───────────────────────────────────────────────────────
export interface DepthWeek {
  label: string;
  /** per-hour arrays, 168 long; the LAST row is the live week. */
  commits: number[];
  cost: number[];
  churn: number[];
  /** live-week rows carry the now offset in hours; history rows are complete. */
  nowHour?: number;
}
export type DepthMetric = 'commits' | 'cost' | 'cum' | 'churn';
export const DEPTH_METRICS: { id: DepthMetric; label: string }[] = [
  { id: 'commits', label: 'COMMITS/HR' },
  { id: 'cost', label: '$/HR' },
  { id: 'cum', label: 'CUMULATIVE $' },
  { id: 'churn', label: 'CHURN' },
];

interface Props {
  model: PulseModel;
  attribution: AttributionDoc | null;
  plan: { name: string; monthly: number } | null;
  repoLabel: string;
  onInspect: (sel: InspectSel) => void;
  trace: ProvenanceDoc | null;
  viz: 'flat' | 'depth';
  onViz: (v: 'flat' | 'depth') => void;
  depthWeeks: DepthWeek[] | null;
  depthMetric: DepthMetric;
  onDepthMetric: (m: DepthMetric) => void;
  /** Bumped by the container on a deliberate view change (preset/refresh) to re-center the
   *  viewport. Incidental range growth (poll / lazy history) does NOT bump it, so the user's
   *  pan/zoom survives. */
  resetKey?: number;
  /** Called when a leftward drag reaches the loaded start edge — the container lazily fetches
   *  and stitches an older window so the drag can continue into the past. */
  onReachStart?: () => void;
  /** An older window is currently being fetched (shows a hint; also gates re-triggering). */
  loadingOlder?: boolean;
  /** No more history to load (hit the max lookback) — stop asking. */
  atHistoryLimit?: boolean;
  /** Confirmed (past the min-dwell gate) file collisions — ≥2 LIVE agents on one path. Render-only-
   *  when-present: an empty array (the common case) draws nothing extra on AGENT RUNS. */
  collisions?: Collision[];
}

interface Hover {
  x: number;
  y: number;
  title: string;
  titleColor?: string;
  rows: { k: string; v: string; c?: string }[];
  ring?: { cx: number; cy: number; r: number; color: string } | { rect: [number, number, number, number]; color: string };
}

export const FleetPulseCanvas: React.FC<Props> = ({ model, attribution, plan, repoLabel, onInspect, trace, viz, onViz, depthWeeks, depthMetric, onDepthMetric, resetKey = 0, onReachStart, loadingOlder = false, atHistoryLimit = false, collisions = [] }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(1200);
  const [view, setView] = useState<{ s: number; e: number }>({ s: model.start, e: model.end });
  const [hover, setHover] = useState<Hover | null>(null);
  const [hoveredWeek, setHoveredWeek] = useState<number | null>(null);
  const drag = useRef<{ cx0: number; ux0: number; s0: number; moved: boolean; pid: number } | null>(null);

  // Re-center the viewport ONLY on a deliberate view change (preset switch / refresh), signalled
  // by the container bumping `resetKey`. The 20s poll and lazy history-extend both change
  // model.start/end but must NOT disturb the user's pan/zoom — so they don't bump it.
  const lastReset = useRef(resetKey);
  if (lastReset.current !== resetKey) {
    lastReset.current = resetKey;
    // eslint-disable-next-line react-hooks/rules-of-hooks -- render-time reset of derived state, React-sanctioned pattern
    setView({ s: model.start, e: model.end });
  }

  // When the loaded range grows (poll advances `end`, lazy load lowers `start`), keep the current
  // view but clamp it back into bounds if a preset shrink left it dangling. A still-valid view is
  // returned untouched (same object → no re-render), so panning into freshly-loaded history is smooth.
  useEffect(() => {
    setView((v) => {
      if (v.s >= model.start && v.e <= model.end) return v;
      const sp = Math.min(v.e - v.s, model.end - model.start);
      const s = Math.max(model.start, Math.min(v.s, model.end - sp));
      return { s, e: s + sp };
    });
  }, [model.start, model.end]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(900, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(900, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const W = width;
  const plotW = W - PAD_L - PAD_R;
  const span = view.e - view.s;
  const x = useCallback((t: number) => PAD_L + ((t - view.s) / span) * plotW, [view.s, span, plotW]);

  /** client → viewBox coords through the real CTM (letterbox-proof). */
  const toUser = useCallback((ev: { clientX: number; clientY: number }): { x: number; y: number } => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return { x: 0, y: 0 };
    const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }, []);

  // wheel zoom must preventDefault → non-passive listener via ref
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (ev: WheelEvent): void => {
      if (viz !== 'flat') return;
      ev.preventDefault();
      const px = toUser(ev).x;
      setView((v) => {
        const sp = v.e - v.s;
        const anchor = v.s + ((px - PAD_L) / plotW) * sp;
        const factor = ev.deltaY > 0 ? 1.14 : 1 / 1.14;
        const ns = Math.min(model.end - model.start, Math.max(MIN_SPAN, sp * factor));
        let s = anchor - ((anchor - v.s) / sp) * ns;
        s = Math.max(model.start, Math.min(s, model.end - ns));
        return { s, e: s + ns };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [viz, plotW, toUser, model.start, model.end]);

  const onPointerDown = (ev: React.PointerEvent): void => {
    if (viz !== 'flat') return;
    drag.current = { cx0: ev.clientX, ux0: toUser(ev).x, s0: view.s, moved: false, pid: ev.pointerId };
  };
  const onPointerUp = (): void => {
    drag.current = null;
    svgRef.current?.classList.remove('dragging');
  };
  const suppressClick = useRef(false);

  // ── day boundaries for the visible window (real calendar days) ──────────────
  const days = useMemo(() => {
    const out: { t0: number; t1: number; name: string; date: string }[] = [];
    const d = new Date(model.start);
    d.setHours(0, 0, 0, 0);
    while (d.getTime() < model.end) {
      const t0 = d.getTime();
      const next = new Date(d);
      next.setDate(d.getDate() + 1);
      out.push({
        t0,
        t1: next.getTime(),
        name: d.toLocaleDateString(undefined, { weekday: 'long' }).toUpperCase(),
        date: d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }).toUpperCase(),
      });
      d.setDate(d.getDate() + 1);
    }
    return out;
  }, [model.start, model.end]);

  // Contested-agent-id → its collision, for the AGENT RUNS marker. Empty in the common (calm) case.
  const collisionByAgent = useMemo(() => {
    const m = new Map<string, Collision>();
    for (const c of collisions) for (const a of c.agents) if (!m.has(a.id)) m.set(a.id, c);
    return m;
  }, [collisions]);

  const binAt = (t: number): number => Math.min(model.bins - 1, Math.max(0, Math.floor((t - model.start) / HOUR_MS)));
  const maxCost = useMemo(() => Math.max(0.001, ...model.cost), [model.cost]);
  const maxCommits = useMemo(() => Math.max(1, ...model.commits), [model.commits]);
  const maxChurn = useMemo(() => Math.max(1, ...model.churn), [model.churn]);
  const cumTotal = model.cum[binAt(model.nowMs)] || 1;
  const costY = (v: number): number => PULSE_BASE - (v / maxCost) * (PULSE_BASE - PULSE_TOP);
  const cumY = (v: number): number => PULSE_BASE - (v / cumTotal) * (PULSE_BASE - PULSE_TOP - 34);

  // ── below-events row packing (estimated label extents; direction-aware) ─────
  const packedBelow = useMemo(() => {
    const LABEL_W = 190;
    const needsFirst = [...model.below].sort((a, b) => {
      const ai = a.kind === 'BLOCKED' || a.kind === 'READY' ? 0 : 1;
      const bi = b.kind === 'BLOCKED' || b.kind === 'READY' ? 0 : 1;
      return ai - bi || a.at - b.at;
    });
    const rowEnds: number[] = [];
    return needsFirst.map((e) => {
      const cx = x(e.at);
      const anchorEnd = cx > W - 220;
      const lx0 = anchorEnd ? cx - LABEL_W : cx;
      const lx1 = anchorEnd ? cx : cx + LABEL_W;
      let row = rowEnds.findIndex((end) => end < lx0 - 8);
      if (row === -1) {
        rowEnds.push(lx1);
        row = rowEnds.length - 1;
      } else rowEnds[row] = lx1;
      return { e, cx, anchorEnd, depth: EVT_BASE + row * EVT_ROW_H };
    });
  }, [model.below, x, W]);

  // ── zone-aware hover ─────────────────────────────────────────────────────────
  const onPointerMove = (ev: React.PointerEvent): void => {
    const d = drag.current;
    if (d) {
      if (!d.moved && Math.abs(ev.clientX - d.cx0) > 4) {
        d.moved = true;
        suppressClick.current = true;
        try {
          svgRef.current?.setPointerCapture(d.pid);
        } catch {
          /* pointer gone */
        }
        svgRef.current?.classList.add('dragging');
      }
      if (d.moved) {
        const dux = toUser(ev).x - d.ux0;
        const sp = view.e - view.s;
        let s = d.s0 - (dux / plotW) * sp;
        // Dragging right pans toward the past (s decreases). Hitting the loaded start edge asks
        // the container for an older window; the pan clamps here until that history arrives, then
        // the widened bounds let the next drag continue seamlessly.
        if (s < model.start && !loadingOlder && !atHistoryLimit) onReachStart?.();
        s = Math.max(model.start, Math.min(s, model.end - sp));
        setView({ s, e: s + sp });
        setHover(null);
        return;
      }
    }
    if (viz !== 'flat') return;
    const u = toUser(ev);
    const wrap = wrapRef.current?.getBoundingClientRect();
    const hx = wrap ? ev.clientX - wrap.left : u.x;
    const hy = wrap ? ev.clientY - wrap.top : u.y;
    if (u.x < PAD_L || u.x > W - PAD_R) {
      setHover(null);
      return;
    }
    const t = view.s + ((u.x - PAD_L) / plotW) * span;
    const bin = binAt(t);
    const binT = model.start + bin * HOUR_MS;
    let h: Hover | null = null;
    if (u.y < PULSE_TOP - 24) {
      const near = model.milestones
        .filter((m) => Math.abs(x(m.at) - u.x) < 10)
        .sort((a, b) => Math.abs(x(a.at) - u.x) - Math.abs(x(b.at) - u.x))[0];
      if (near && u.y > RAIL - 14 && u.y < RAIL + 14) {
        h = {
          x: hx, y: hy,
          title: `${near.kind} · ${fmtWhen(near.at)}`,
          titleColor: KIND_COL[near.kind] ?? EMBER,
          rows: [{ k: trim(near.label, 30), v: near.churn ? `Δ${fmtK(near.churn)}` : '' }, { k: 'click to open the diff', v: '' }],
          ring: { cx: x(near.at), cy: RAIL, r: 7, color: KIND_COL[near.kind] ?? EMBER },
        };
      }
    } else if (u.y <= PULSE_BASE + 4) {
      if (binT <= model.nowMs && (model.cost[bin] > 0.005 || model.commits[bin] > 0)) {
        const rows: Hover['rows'] = [{ k: 'cost', v: `$${model.cost[bin].toFixed(2)}/hr`, c: EMBER }];
        if (model.commits[bin] === 0 && model.cost[bin] > 0.4) rows.push({ k: 'idle burn', v: 'zero output', c: ALERT });
        if (attribution) {
          const ai = Math.floor((binT - attribution.range.start) / attribution.binMs);
          const pairs: { hn: string; mn: string; v: number }[] = [];
          for (const hn of attribution.harnesses) {
            for (const mn of attribution.models) {
              // per-bin pair estimate: split the harness bin by the model marginals' share
              const hv = attribution.byHarness[hn]?.[ai] ?? 0;
              const mv = attribution.byModel[mn]?.[ai] ?? 0;
              const tot = attribution.models.reduce((a2, k) => a2 + (attribution.byModel[k]?.[ai] ?? 0), 0);
              const v = tot > 0 ? hv * (mv / tot) : 0;
              if (v > 0.05) pairs.push({ hn, mn, v });
            }
          }
          pairs.sort((a, b) => b.v - a.v);
          for (const p of pairs.slice(0, 3)) rows.push({ k: `· ${p.hn} → ${p.mn}`, v: `$${p.v.toFixed(2)}`, c: modelColor(p.mn) });
        }
        rows.push({ k: 'cumulative', v: `$${Math.round(model.cum[bin])} of $${Math.round(cumTotal)}`, c: '#C9B79A' });
        rows.push({ k: 'commits', v: String(model.commits[bin]), c: heatColor(model.commits[bin] / maxCommits) });
        rows.push({ k: 'churn', v: `${fmtK(model.churn[bin])} lines`, c: CHURN_COL });
        h = { x: hx, y: hy, title: fmtWhen(t), rows, ring: { cx: x(binT + HOUR_MS / 2), cy: costY(model.cost[bin]), r: 4, color: '#FFE9C4' } };
      }
    } else if (u.y <= SPINE + 46) {
      if (binT <= model.nowMs) h = { x: hx, y: hy, title: fmtWhen(t), rows: [{ k: 'fleet', v: model.active[bin] ? 'active' : 'idle', c: model.active[bin] ? EMBER : INK.low }] };
    } else if (u.y < METRO_Y - 4) {
      const row = Math.round((u.y - SESS_TOP - 2.5) / SESS_ROW_H);
      const s = model.sessions.find((z) => z.row === row && t >= z.t0 - HOUR_MS * 0.2 && t <= z.t1 + HOUR_MS * 0.2);
      if (s) {
        h = {
          x: hx, y: hy,
          title: `AGENT RUN · ${s.status}${s.live ? ' · live' : ''}`,
          titleColor: SESS_COL[s.status],
          rows: [
            { k: trim(s.label, 26), v: '' },
            { k: 'started', v: fmtWhen(s.t0) },
            { k: 'duration', v: `${((s.t1 - s.t0) / HOUR_MS).toFixed(1)}h` },
            ...(s.costUsd ? [{ k: 'cost', v: `$${s.costUsd.toFixed(2)}` }] : []),
          ],
          ring: { rect: [x(s.t0) - 1.5, SESS_TOP + s.row * SESS_ROW_H - 1.5, Math.max(2, x(s.t1) - x(s.t0)) + 3, 8], color: SESS_COL[s.status] },
        };
      }
    } else if (u.y < EVT_BASE - 24) {
      const tick = model.loopTicks.filter((lt) => Math.abs(x(lt) - u.x) < 6).sort((a, b) => Math.abs(x(a) - u.x) - Math.abs(x(b) - u.x))[0];
      if (tick !== undefined) h = { x: hx, y: hy, title: `LOOP TICK · ${fmtWhen(tick)}`, titleColor: COOL, rows: [{ k: 'automation heartbeat', v: '' }], ring: { cx: x(tick) + 0.7, cy: METRO_Y + 3.5, r: 6, color: COOL } };
    } else {
      const near = packedBelow
        .filter((z) => (Math.abs(z.cx - u.x) < 12 && Math.abs(z.depth - 14 - u.y) < 14) || (u.x >= (z.anchorEnd ? z.cx - 190 : z.cx - 4) && u.x <= (z.anchorEnd ? z.cx + 4 : z.cx + 190) && u.y >= z.depth - 22 && u.y <= z.depth + 8))
        .sort((a, b) => Math.abs(a.cx - u.x) - Math.abs(b.cx - u.x))[0];
      if (near) {
        h = {
          x: hx, y: hy,
          title: `${near.e.kind === 'LOOP' ? (near.e.sub ?? 'loop').toUpperCase() : near.e.kind} · ${fmtWhen(near.e.at)}`,
          titleColor: KIND_COL[near.e.kind],
          rows: [{ k: trim(near.e.label, 30), v: '' }, { k: near.e.kind === 'DONE' ? 'click to open the pipeline' : 'click to inspect', v: '' }],
          ring: { cx: near.cx, cy: near.depth - 14, r: 7, color: KIND_COL[near.e.kind] },
        };
      }
    }
    setHover(h && { ...h, ruler: u.x } as Hover & { ruler?: number });
  };

  const onSvgClick = (ev: React.MouseEvent): void => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (viz !== 'flat') return;
    if ((ev.target as Element).closest?.('[data-hit]')) return; // element handlers own it
    const u = toUser(ev);
    if (u.x < PAD_L || u.x > W - PAD_R) return;
    if (u.y < PULSE_TOP - 24 || u.y > PULSE_BASE + 6) return;
    const t = view.s + ((u.x - PAD_L) / plotW) * span;
    const bin = binAt(t);
    const binT = model.start + bin * HOUR_MS;
    if (binT <= model.nowMs && (model.cost[bin] > 0.005 || model.commits[bin] > 0)) onInspect({ kind: 'hour', at: binT });
  };

  // ── flat-mode pieces ─────────────────────────────────────────────────────────
  const vis = (t: number, m = 2 * HOUR_MS): boolean => t >= view.s - m && t <= view.e + m;

  const flat = viz === 'flat' && (
    <>
      {/* warm breath behind the pulse */}
      <rect x={PAD_L} y={PULSE_TOP - 38} width={plotW} height={PULSE_BASE - PULSE_TOP + 38} fill="url(#fp-breath)" opacity={0.85} />
      {/* day separators + spine day names */}
      {days.filter((d) => vis(d.t0, 0) || vis(d.t1, 0)).map((d) => {
        const dayW = x(d.t1) - x(d.t0);
        // a clipped partial day (range starts mid-day) must not print a name that
        // runs into its neighbour's — the VISIBLE width decides
        const visW = Math.min(x(d.t1), W - PAD_R) - Math.max(x(d.t0), PAD_L);
        return (
          <g key={d.t0}>
            <line x1={x(d.t0)} y1={RAIL - 10} x2={x(d.t0)} y2={H - 28} stroke={HAIRLINE} strokeWidth={1} />
            {visW > 95 && (
              <text x={Math.max(x(d.t0), PAD_L) + 8} y={SPINE + 25} style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.22em', fill: INK.hi }}>
                {d.name}
                {visW > 150 && <tspan dx={10} style={{ fontSize: 9, fill: INK.low, fontWeight: 400 }}>{d.date}</tspan>}
              </text>
            )}
            {[3, 6, 9, 12, 15, 18, 21].filter((hh) => span < 8.5 * 24 * HOUR_MS || hh % 6 === 0).map((hh) => {
              const tt = d.t0 + hh * HOUR_MS;
              if (tt < view.s || tt > view.e) return null;
              return (
                <g key={hh}>
                  <line x1={x(tt)} y1={SPINE + 9} x2={x(tt)} y2={SPINE + (hh % 6 === 0 ? 14 : 12)} stroke={INK.faint} strokeWidth={0.75} />
                  {hh % 6 === 0 && <text x={x(tt)} y={SPINE + 41} textAnchor="middle" style={{ fontSize: 8, fill: INK.faint }}>{String(hh).padStart(2, '0')}</text>}
                </g>
              );
            })}
          </g>
        );
      })}

      {/* MILESTONES: marks on the rail + width-budgeted per-day label stacks */}
      <line x1={PAD_L} y1={RAIL} x2={W - PAD_R} y2={RAIL} stroke={HAIRLINE2} strokeWidth={1} />
      {days.map((d) => {
        const ms = model.milestones.filter((m) => m.at >= d.t0 && m.at < d.t1 && vis(m.at));
        if (!ms.length) return null;
        const x0 = Math.max(x(d.t0), PAD_L);
        const chars = Math.floor((x(d.t1) - x(d.t0) - 20) / 5.7);
        return (
          <g key={`m${d.t0}`}>
            {ms.map((m, i) => (
              <rect
                key={i}
                data-hit
                x={x(m.at) - (m.big ? 3.5 : 2.5)}
                y={RAIL - (m.big ? 3.5 : 2.5)}
                width={m.big ? 7 : 5}
                height={m.big ? 7 : 5}
                fill={KIND_COL[m.kind] ?? INK.mid}
                filter={m.big ? 'url(#fp-glow)' : undefined}
                cursor="pointer"
                role="button"
                aria-label={`${m.kind}: ${m.label}`}
                onClick={() => m.sha && onInspect({ kind: 'commit', sha: m.sha, label: m.label, at: m.at })}
              />
            ))}
            {chars >= 12 && (
              <>
                <text x={x0 + 8} y={RAIL + 11} style={{ fontSize: 8.5, fill: INK.low }}>
                  {ms.length}× {fmtHm(ms[0].at)}–{fmtHm(ms[ms.length - 1].at)}
                </text>
                {ms.slice(0, Math.max(1, Math.floor((PULSE_TOP - 24 - RAIL - 26) / 13))).map((m, i) => (
                  <text
                    key={i}
                    data-hit
                    x={x0 + 8}
                    y={RAIL + 24 + i * 13}
                    cursor="pointer"
                    style={{ fontSize: 9.5, fill: INK.mid }}
                    onClick={() => m.sha && onInspect({ kind: 'commit', sha: m.sha, label: m.label, at: m.at })}
                  >
                    <tspan style={{ fill: KIND_COL[m.kind] ?? INK.mid, fontWeight: 600 }}>{m.kind} </tspan>
                    {trim(m.label, Math.max(6, chars - m.kind.length - 1))}
                  </text>
                ))}
              </>
            )}
          </g>
        );
      })}

      {/* FLEET PULSE: churn ridge, magma bars, idle scars, cost line, cumulative strand */}
      <PulseZone model={model} x={x} view={view} maxCost={maxCost} maxCommits={maxCommits} maxChurn={maxChurn} cumTotal={cumTotal} costY={costY} cumY={cumY} plotW={plotW} />

      {/* attribution bands + legends + plan chip */}
      {attribution && <AttributionBands attribution={attribution} plan={plan} x={x} W={W} onInspect={onInspect} nowMs={model.nowMs} />}

      {/* SPINE state band */}
      {model.active.map((a, i) => {
        const t0 = model.start + i * HOUR_MS;
        if (t0 > model.nowMs || !vis(t0)) return null;
        return (
          <rect
            key={i}
            x={Math.max(x(t0), PAD_L)}
            y={SPINE - (a ? 5 : 1.5)}
            width={Math.max(0, Math.min(x(t0 + HOUR_MS), W - PAD_R) - Math.max(x(t0), PAD_L))}
            height={a ? 10 : 3}
            rx={1.5}
            fill={a ? EMBER : EMBER_DEEP}
            opacity={a ? 0.9 : 0.5}
          />
        );
      })}
      <line x1={PAD_L} y1={SPINE + 9} x2={W - PAD_R} y2={SPINE + 9} stroke={HAIRLINE2} strokeWidth={1} />

      {/* AGENT RUNS pills + metronome */}
      {model.sessions.filter((s) => s.row <= 10 && vis(s.t1) || vis(s.t0)).map((s, i) => {
        const rx0 = Math.max(x(s.t0), PAD_L);
        const rx1 = Math.min(x(s.t1), W - PAD_R);
        if (rx1 <= rx0) return null;
        // COLLISION marker (GRAPH-FOLD.md §2/§5): only when this pill's agent is one of ≥2 LIVE
        // agents holding the same path AND the overlap has cleared the min-dwell gate upstream
        // (collisions passed in are already confirmed) — so the common case renders nothing here.
        const collision = s.agentId ? collisionByAgent.get(s.agentId) : undefined;
        return (
          <g key={i}>
            <rect
              data-hit
              x={rx0}
              y={SESS_TOP + s.row * SESS_ROW_H}
              width={Math.max(2, rx1 - rx0)}
              height={5}
              rx={2.5}
              fill={SESS_COL[s.status]}
              opacity={s.status === 'working' ? 0.85 : 0.7}
              className={s.status === 'blocked' ? 'fp-pulse' : undefined}
              filter={s.status === 'blocked' ? 'url(#fp-glow)' : undefined}
              cursor="pointer"
              role="button"
              aria-label={`Agent run, ${s.status}`}
              onClick={() => onInspect({ kind: 'run', session: s })}
            />
            {collision && (
              <text
                data-hit
                x={rx1 + 4}
                y={SESS_TOP + s.row * SESS_ROW_H + 7}
                style={{ fontSize: 10, fill: ALERT, fontWeight: 700 }}
                className="fp-pulse"
                cursor="pointer"
                role="button"
                aria-label={`Collision: ${collision.agents.map((a) => a.name).join(' & ')} are both editing ${collision.file}`}
                onClick={() => onInspect({ kind: 'collision', collision, at: model.nowMs })}
              >
                ⚠
              </text>
            )}
          </g>
        );
      })}
      <text x={PAD_L + 6} y={METRO_Y - 8} style={{ fontSize: 9, fill: INK.mid, letterSpacing: '0.06em' }}>{model.sessions.length} runs · packed</text>
      {model.loopTicks.filter((t) => vis(t, 0)).map((t, i) => (
        <rect key={i} x={x(t)} y={METRO_Y} width={1.4} height={7} fill={COOL} opacity={0.55} />
      ))}

      {/* SHIPPED · LOOPS · NEEDS hanging labels */}
      {packedBelow.filter((z) => vis(z.e.at, 4 * HOUR_MS) && z.depth <= H - 36).map((z, i) => {
        const { e, cx, anchorEnd, depth } = z;
        const col = KIND_COL[e.kind];
        const click = (): void => {
          if (e.kind === 'DONE' && e.ticket) onInspect({ kind: 'ticket', ticket: e.ticket, label: e.label, at: e.at });
          else if (e.kind === 'BLOCKED' || e.kind === 'READY') onInspect({ kind: 'needs' });
          else if (e.kind === 'LOOP') onInspect({ kind: 'loop', sub: e.sub ?? 'loop', label: e.label, at: e.at });
          else if (e.kind === 'MEETING') onInspect({ kind: 'meeting', label: e.label, at: e.at });
        };
        return (
          <g key={i} data-hit cursor="pointer" role="button" aria-label={`${e.kind}: ${e.label}`} onClick={click}>
            <line x1={cx} y1={SPINE + 46} x2={cx} y2={depth - 14} stroke={col} strokeWidth={0.6} opacity={0.35} />
            {e.kind === 'DONE' && <rect x={cx - 3} y={depth - 17} width={6} height={6} transform={`rotate(45 ${cx} ${depth - 14})`} fill={col} filter={e.big ? 'url(#fp-glow)' : undefined} />}
            {e.kind === 'READY' && <rect x={cx - 3.5} y={depth - 17.5} width={7} height={7} transform={`rotate(45 ${cx} ${depth - 14})`} fill="none" stroke={col} strokeWidth={1.5} className="fp-pulse" filter="url(#fp-glow)" />}
            {e.kind === 'BLOCKED' && <circle cx={cx} cy={depth - 14} r={3.5} fill="none" stroke={col} strokeWidth={1.5} className="fp-pulse" filter="url(#fp-glow)" />}
            {e.kind === 'MEETING' && <circle cx={cx} cy={depth - 14} r={3.2} fill="none" stroke={col} strokeWidth={1.2} strokeDasharray="2 2" />}
            {e.kind === 'LOOP' && <circle cx={cx} cy={depth - 14} r={e.big ? 3.2 : 2.4} fill={col} />}
            <text x={anchorEnd ? cx - 7 : cx + 7} y={depth - 11} textAnchor={anchorEnd ? 'end' : undefined} style={{ fontSize: 9.5, fill: INK.mid }}>
              <tspan style={{ fill: col, fontWeight: 600 }}>{e.kind === 'LOOP' ? (e.sub ?? 'loop').toUpperCase() : e.kind} · {fmtHm(e.at)} </tspan>
            </text>
            <text x={anchorEnd ? cx - 7 : cx + 7} y={depth + 1} textAnchor={anchorEnd ? 'end' : undefined} style={{ fontSize: 8.5, fill: INK.low }}>
              {trim(e.label, 30)}
            </text>
          </g>
        );
      })}

      {/* NOW — the living edge + the imperative chip */}
      {vis(model.nowMs, 0) && (
        <>
          <rect x={x(model.nowMs)} y={RAIL - 10} width={Math.max(0, W - PAD_R - x(model.nowMs))} height={H - RAIL - 18} fill="rgba(8,9,12,0.62)" pointerEvents="none" />
          <line x1={x(model.nowMs)} y1={RAIL - 10} x2={x(model.nowMs)} y2={H - 28} stroke={EMBER} strokeWidth={1} opacity={0.5} />
          <circle cx={x(model.nowMs)} cy={RAIL - 10} r={3.5} fill={EMBER} className="fp-pulse" />
          <text x={x(model.nowMs) + 8} y={RAIL - 7} style={{ fontSize: 9, fill: EMBER, letterSpacing: '0.2em' }}>NOW</text>
          {model.needsCount > 0 && (
            <g data-hit cursor="pointer" role="button" aria-label={`${model.needsCount} items need you — open the queue`} onClick={() => onInspect({ kind: 'needs' })}>
              <rect x={Math.max(PAD_L + 4, x(model.nowMs) - 98)} y={20} width={92} height={16} rx={8} fill="rgba(229,72,77,0.16)" stroke={ALERT} strokeWidth={1} className="fp-pulse" />
              <text x={Math.max(PAD_L + 14, x(model.nowMs) - 88)} y={31} style={{ fontSize: 9, fill: ALERT, fontWeight: 700, letterSpacing: '0.14em' }}>
                {model.needsCount} NEED YOU
              </text>
            </g>
          )}
        </>
      )}

      {/* provenance thread */}
      {trace && <TraceOverlay trace={trace} model={model} x={x} W={W} packedBelow={packedBelow} />}

      {/* hover ruler */}
      {hover && (hover as Hover & { ruler?: number }).ruler !== undefined && (
        <line x1={(hover as Hover & { ruler?: number }).ruler} x2={(hover as Hover & { ruler?: number }).ruler} y1={RAIL - 6} y2={H - 30} stroke={INK.mid} strokeWidth={1} strokeDasharray="1 3" pointerEvents="none" />
      )}
      {hover?.ring && 'cx' in hover.ring && <circle cx={hover.ring.cx} cy={hover.ring.cy} r={hover.ring.r} fill="none" stroke={hover.ring.color} strokeWidth={1.5} filter="url(#fp-glow)" pointerEvents="none" />}
      {hover?.ring && 'rect' in hover.ring && <rect x={hover.ring.rect[0]} y={hover.ring.rect[1]} width={hover.ring.rect[2]} height={hover.ring.rect[3]} rx={4} fill="none" stroke={hover.ring.color} strokeWidth={1} pointerEvents="none" />}

      {/* zone whispers */}
      {([[150, 'MILESTONES'], [370, 'FLEET PULSE'], [600, 'AGENT RUNS'], [765, 'SHIPPED · LOOPS']] as [number, string][]).map(([yy, s]) => (
        <text key={s} x={12} y={yy} textAnchor="middle" transform={`rotate(-90 12 ${yy})`} style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.24em', fill: INK.faint }}>
          {s}
        </text>
      ))}
    </>
  );

  // ── depth mode ───────────────────────────────────────────────────────────────
  const depth = viz === 'depth' && (
    <DepthMassif
      weeks={depthWeeks}
      metric={depthMetric}
      onMetric={onDepthMetric}
      W={W}
      hovered={hoveredWeek}
      onHover={setHoveredWeek}
      onPick={(i, label) => {
        setHoveredWeek(null);
        onViz('flat');
        onInspect({ kind: 'week', index: i, label });
      }}
    />
  );

  const upto = binAt(model.nowMs) + 1;
  const totCommits = model.commits.slice(0, upto).reduce((a, b) => a + b, 0);
  const totChurn = model.churn.slice(0, upto).reduce((a, b) => a + b, 0);

  return (
    <div ref={wrapRef} className="relative min-w-0 flex-1 overflow-hidden" style={{ background: GROUND }}>
      <style>{`
        @keyframes fp-nowpulse { 0%,100%{opacity:.9} 50%{opacity:.3} }
        .fp-pulse { animation: fp-nowpulse 2.4s cubic-bezier(.4,0,.2,1) infinite; }
        .fp-svg { cursor: grab; touch-action: none; }
        .fp-svg.dragging { cursor: grabbing; }
        .fp-drc { transition: opacity 180ms cubic-bezier(0,0,.2,1), transform 220ms cubic-bezier(0,0,.2,1); transform-box: fill-box; transform-origin: 50% 100%; }
        .fp-drc.dim { opacity: .12; }
        .fp-drc.lift { transform: translateY(-18px) scale(1.06); }
        @media (prefers-reduced-motion: reduce) { .fp-pulse { animation: none; } .fp-drc { transition: none; } }
      `}</style>
      {viz === 'flat' && (loadingOlder || (atHistoryLimit && view.s <= model.start + (view.e - view.s) * 0.04)) && (
        <div className="pointer-events-none absolute left-2 top-2 z-10 flex items-center gap-1.5 rounded-md border border-white/10 bg-black/55 px-2 py-1 text-[10px] font-medium tracking-wide text-white/80 backdrop-blur">
          {loadingOlder && <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-white/30 border-t-white/80" aria-hidden="true" />}
          {loadingOlder ? 'Loading older history…' : 'Start of loaded history'}
        </div>
      )}
      <svg
        ref={svgRef}
        className="fp-svg block h-full w-full"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Fleet pulse: milestones and the cost-and-commits pulse above the day spine; agent runs, shipped tickets and automation below. Scroll zooms; drag pans, and dragging left past the edge loads older history."
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerMove={onPointerMove}
        onPointerLeave={() => {
          setHover(null);
          if (viz === 'depth') setHoveredWeek(null);
        }}
        onClick={onSvgClick}
      >
        <defs>
          <linearGradient id="fp-breath" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#08090C" />
            <stop offset="78%" stopColor="#1C1109" />
            <stop offset="100%" stopColor="#241307" />
          </linearGradient>
          <pattern id="fp-stipple" width="4" height="4" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.6" fill={EMBER} opacity="0.5" />
            <circle cx="3" cy="3" r="0.45" fill={EMBER} opacity="0.28" />
          </pattern>
          <filter id="fp-glow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="2.4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {/* dossier line + FLAT/DEPTH toggle */}
        <text x={PAD_L} y={TOPLINE} style={{ fontSize: 9, letterSpacing: '0.2em', fill: INK.low }}>
          {repoLabel.toUpperCase()} · FLEET ACTIVITY
        </text>
        {/* GRAPH-FOLD.md §1/§5: DEPTH *is* activity-rhythm (8w × 168h) — the standalone Activity
            rhythm page DROPS in the fold, and this toggle affordance takes over its name. Relabel
            only: the massif itself is pixel-unchanged, this is strictly a one-word swap. */}
        {(['flat', 'depth'] as const).map((m, i) => (
          <text
            key={m}
            data-hit
            x={PAD_L + 300 + i * 46}
            y={TOPLINE}
            role="button"
            aria-pressed={viz === m}
            cursor="pointer"
            style={{ fontSize: 9, letterSpacing: '0.2em', fill: viz === m ? EMBER : INK.low, fontWeight: viz === m ? 700 : 400 }}
            onClick={() => {
              setHover(null);
              setHoveredWeek(null);
              onViz(m);
            }}
          >
            {m === 'depth' ? 'RHYTHM' : m.toUpperCase()}
          </text>
        ))}
        <text x={W - PAD_R} y={TOPLINE} textAnchor="end" style={{ fontSize: 9, letterSpacing: '0.2em', fill: INK.low }}>
          {totCommits} COMMITS · {fmtK(totChurn)} CHURNED · ${Math.round(cumTotal)} SPEND · {model.sessions.length} RUNS
        </text>
        {flat}
        {depth}
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded border px-2.5 py-2 font-mono text-[11px]"
          style={{ left: Math.min(hover.x + 18, W - 230), top: Math.min(hover.y + 14, 760), background: 'rgba(10,11,15,0.96)', borderColor: HAIRLINE2, color: INK.mid, minWidth: 150 }}
        >
          <div style={{ color: hover.titleColor ?? INK.hi, fontWeight: 600, marginBottom: 4, letterSpacing: '0.04em' }}>{hover.title}</div>
          {hover.rows.map((r, i) => (
            <div key={i} className="flex justify-between gap-3 tabular-nums">
              <span>
                {r.c && <span className="mr-1.5 inline-block h-[7px] w-[7px] rounded-sm align-baseline" style={{ background: r.c }} />}
                {r.k}
              </span>
              {r.v && <span style={{ color: INK.hi }}>{r.v}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ── the fused pulse zone ───────────────────────────────────────────────────────
const PulseZone: React.FC<{
  model: PulseModel;
  x: (t: number) => number;
  view: { s: number; e: number };
  maxCost: number;
  maxCommits: number;
  maxChurn: number;
  cumTotal: number;
  costY: (v: number) => number;
  cumY: (v: number) => number;
  plotW: number;
}> = ({ model, x, view, maxCost, maxCommits, maxChurn, cumTotal, costY, cumY, plotW }) => {
  const binW = Math.max(1.6, (plotW / (view.e - view.s)) * HOUR_MS - 1.2);
  const i0 = Math.max(0, Math.floor((view.s - model.start) / HOUR_MS) - 1);
  const i1 = Math.min(model.bins, Math.ceil((view.e - model.start) / HOUR_MS) + 1);
  const nowBin = Math.min(model.bins, Math.ceil((model.nowMs - model.start) / HOUR_MS));

  const paths = useMemo(() => {
    let ridge = '';
    let line = '';
    let area = '';
    let cum = '';
    for (let i = i0; i < Math.min(i1, nowBin); i++) {
      const px = x(model.start + (i + 0.5) * HOUR_MS);
      ridge += `${ridge ? ' L' : 'M'} ${px.toFixed(1)} ${(PULSE_BASE - (model.churn[i] / maxChurn) * BAR_MAX * 0.8).toFixed(1)}`;
      const py = costY(model.cost[i]);
      line += `${line ? ' L' : 'M'} ${px.toFixed(1)} ${py.toFixed(1)}`;
      area += `${area ? ' L' : 'M'} ${px.toFixed(1)} ${py.toFixed(1)}`;
      cum += `${cum ? ' L' : 'M'} ${px.toFixed(1)} ${cumY(model.cum[i]).toFixed(1)}`;
    }
    const x0 = x(model.start + i0 * HOUR_MS);
    const x1 = x(model.start + Math.min(i1, nowBin) * HOUR_MS);
    return {
      ridge: ridge ? `${ridge} L ${x1} ${PULSE_BASE} L ${x0} ${PULSE_BASE} Z` : '',
      line,
      area: area ? `M ${x0} ${PULSE_BASE} ${area.slice(1)} L ${x1} ${PULSE_BASE} Z` : '',
      cum,
    };
  }, [model, x, i0, i1, nowBin, maxChurn, costY, cumY]);

  const bars: React.ReactNode[] = [];
  const scars: React.ReactNode[] = [];
  for (let i = i0; i < Math.min(i1, nowBin); i++) {
    const t = model.commits[i] / maxCommits;
    if (model.commits[i] > 0) {
      const bh = 4 + t * (BAR_MAX - 4);
      bars.push(
        <rect key={i} x={x(model.start + i * HOUR_MS) + 0.5} y={PULSE_BASE - bh} width={binW} height={bh} fill={heatColor(t)} opacity={0.92} filter={t > 0.6 ? 'url(#fp-glow)' : undefined} />,
      );
    } else if (model.cost[i] > 0.4) {
      scars.push(<rect key={i} x={x(model.start + i * HOUR_MS)} y={PULSE_BASE + 3} width={binW + 1.2} height={2.5} fill={ALERT} opacity={0.5} />);
    }
  }

  // peak callout in the visible, elapsed window
  let pk = -1;
  for (let i = Math.max(0, Math.floor((view.s - model.start) / HOUR_MS)); i < Math.min(nowBin, Math.ceil((view.e - model.start) / HOUR_MS)); i++) {
    if (pk === -1 || model.cost[i] > model.cost[pk]) pk = i;
  }
  const lastBin = Math.max(i0, Math.min(i1, nowBin) - 1);

  return (
    <g>
      {paths.ridge && <path d={paths.ridge} fill={CHURN_COL} opacity={0.2} />}
      {bars}
      {scars}
      {paths.area && (
        <>
          <clipPath id="fp-costclip">
            <path d={paths.area} />
          </clipPath>
          <rect x={PAD_L} y={PULSE_TOP} width={plotW} height={PULSE_BASE - PULSE_TOP} fill="url(#fp-stipple)" clipPath="url(#fp-costclip)" opacity={0.5} />
        </>
      )}
      {paths.line && <path d={paths.line} fill="none" stroke={EMBER} strokeWidth={1.4} />}
      {pk >= 0 && model.cost[pk] > 0.2 && (
        <g pointerEvents="none">
          <circle cx={x(model.start + (pk + 0.5) * HOUR_MS)} cy={costY(model.cost[pk])} r={3} fill="#FFE9C4" filter="url(#fp-glow)" />
          <text x={x(model.start + (pk + 0.5) * HOUR_MS)} y={costY(model.cost[pk]) - (costY(model.cost[pk]) > PULSE_TOP + 34 ? 16 : -26)} textAnchor="middle" style={{ fontSize: 10, fontWeight: 600, fill: INK.hi }}>
            ${model.cost[pk].toFixed(1)}/hr
          </text>
          <text x={x(model.start + (pk + 0.5) * HOUR_MS)} y={costY(model.cost[pk]) - (costY(model.cost[pk]) > PULSE_TOP + 34 ? 6 : -36)} textAnchor="middle" style={{ fontSize: 8, letterSpacing: '0.18em', fill: INK.low }}>
            PEAK SPEND
          </text>
        </g>
      )}
      {paths.cum && (
        <g pointerEvents="none">
          <path d={paths.cum} fill="none" stroke="#C9B79A" strokeWidth={1} opacity={0.7} />
          <circle cx={x(model.start + (lastBin + 0.5) * HOUR_MS)} cy={cumY(model.cum[lastBin])} r={2.2} fill="#C9B79A" />
          <text
            x={x(model.start + (lastBin + 0.5) * HOUR_MS) + (x(model.start + lastBin * HOUR_MS) + 110 < PAD_L + plotW ? 6 : -6)}
            y={cumY(model.cum[lastBin]) - 5}
            textAnchor={x(model.start + lastBin * HOUR_MS) + 110 < PAD_L + plotW ? undefined : 'end'}
            style={{ fontSize: 9, fill: '#C9B79A', letterSpacing: '0.06em' }}
          >
            ${Math.round(cumTotal)} cumulative
          </text>
        </g>
      )}
    </g>
  );
};

// ── attribution bands + legends + plan chip ───────────────────────────────────
const AttributionBands: React.FC<{
  attribution: AttributionDoc;
  plan: { name: string; monthly: number } | null;
  x: (t: number) => number;
  W: number;
  nowMs: number;
  onInspect: (sel: InspectSel) => void;
}> = ({ attribution, plan, x, W, nowMs, onInspect }) => {
  const bandsOf = (rec: Record<string, number[]>, keys: string[], y: number, colors: (k: string) => string): React.ReactNode[] => {
    const n = rec[keys[0]]?.length ?? 0;
    const out: React.ReactNode[] = [];
    let run = -1;
    let dom = '';
    const flush = (endI: number): void => {
      if (run < 0) return;
      const rx0 = Math.max(x(attribution.range.start + run * attribution.binMs), PAD_L);
      const rx1 = Math.min(x(attribution.range.start + endI * attribution.binMs), W - PAD_R);
      if (rx1 > rx0) out.push(<rect key={`${y}-${run}`} x={rx0} y={y} width={rx1 - rx0} height={4} rx={1} fill={colors(dom)} opacity={0.75} />);
      run = -1;
    };
    for (let i = 0; i <= n; i++) {
      const t = attribution.range.start + i * attribution.binMs;
      const total = i < n ? keys.reduce((a, k) => a + (rec[k]?.[i] ?? 0), 0) : 0;
      const active = i < n && t < nowMs && total > 0.02;
      const d = active ? keys.reduce((best, k) => ((rec[k]?.[i] ?? 0) > (rec[best]?.[i] ?? 0) ? k : best), keys[0]) : '';
      if (!active || d !== dom) {
        flush(i);
        dom = d;
        if (active) run = i;
      }
    }
    flush(n);
    return out;
  };

  const totals = (rec: Record<string, number[]>, k: string): number => rec[k]?.reduce((a, b) => a + b, 0) ?? 0;
  const worth = attribution.plan;

  return (
    <g data-hit cursor="pointer" role="button" aria-label="Open the cost breakdown" onClick={() => onInspect({ kind: 'cost' })}>
      {/* legends */}
      <text x={PAD_L + 6} y={PULSE_TOP - 31} style={{ fontSize: 8, letterSpacing: '0.18em', fill: INK.low }}>BILLED · MODEL</text>
      {attribution.models.slice(0, 5).map((m, i) => (
        <text key={m} x={PAD_L + 106 + i * 92} y={PULSE_TOP - 31} style={{ fontSize: 9, fill: INK.mid }}>
          <tspan style={{ fill: modelColor(m), fontWeight: 700 }}>■ </tspan>
          {m} ${Math.round(totals(attribution.byModel, m))}
        </text>
      ))}
      <text x={PAD_L + 6} y={PULSE_TOP - 19} style={{ fontSize: 8, letterSpacing: '0.18em', fill: INK.low }}>VIA · HARNESS</text>
      {attribution.harnesses.slice(0, 5).map((m, i) => (
        <text key={m} x={PAD_L + 106 + i * 110} y={PULSE_TOP - 19} style={{ fontSize: 9, fill: INK.mid }}>
          <tspan style={{ fill: harnessColor(m), fontWeight: 700 }}>■ </tspan>
          {m} ${Math.round(totals(attribution.byHarness, m))}
        </text>
      ))}
      {worth && (
        <text x={W - PAD_R - 2} y={PULSE_TOP - 19} textAnchor="end" style={{ fontSize: 9, fill: INK.mid }}>
          PLAN {worth.name} · ${Math.round(worth.prorated)} pro-rated → ${Math.round(attribution.totalCost)} api-equiv ·{' '}
          <tspan style={{ fill: worth.worth >= 1.5 ? GOOD : worth.worth >= 0.9 ? '#E8B24A' : ALERT, fontWeight: 700 }}>{worth.worth.toFixed(1)}× worth</tspan>
        </text>
      )}
      {!worth && plan === null && (
        <text x={W - PAD_R - 2} y={PULSE_TOP - 19} textAnchor="end" style={{ fontSize: 9, fill: INK.faint }}>
          set OMP_SQUAD_PLAN_MONTHLY for the plan-worth verdict
        </text>
      )}
      {bandsOf(attribution.byModel, attribution.models, PULSE_TOP - 13, modelColor)}
      {bandsOf(attribution.byHarness, attribution.harnesses, PULSE_TOP - 7, harnessColor)}
    </g>
  );
};

// ── provenance thread overlay ─────────────────────────────────────────────────
const TraceOverlay: React.FC<{
  trace: ProvenanceDoc;
  model: PulseModel;
  x: (t: number) => number;
  W: number;
  packedBelow: { e: PulseModel['below'][number]; cx: number; depth: number }[];
}> = ({ trace, model, x, W, packedBelow }) => {
  const done = packedBelow.find((z) => z.e.ticket === trace.ticket);
  const landMark = trace.land ? model.milestones.find((m) => m.sha && trace.land!.sha.startsWith(m.sha)) : undefined;
  const runs = trace.runs
    .map((r) => model.sessions.find((s) => Math.abs(s.t0 - r.startedAt) < HOUR_MS * 0.5 || s.agentId === r.agentId))
    .filter((s): s is PulseSession => !!s)
    .slice(0, 3);
  const dp = done ? { x: done.cx, y: done.depth - 14 } : { x: x(trace.generatedAt), y: EVT_BASE - 14 };
  return (
    <g pointerEvents="none">
      <rect x={PAD_L} y={RAIL - 10} width={W - PAD_L - PAD_R} height={H - RAIL - 18} fill={GROUND} opacity={0.78} />
      <circle cx={dp.x} cy={dp.y} r={8} fill="none" stroke={GOOD} strokeWidth={1.5} filter="url(#fp-glow)" />
      {runs.map((s, i) => {
        const mx = (x(s.t0) + x(s.t1)) / 2;
        const my = SESS_TOP + s.row * SESS_ROW_H + 2.5;
        return (
          <g key={i}>
            <rect x={x(s.t0) - 2} y={my - 5.5} width={x(s.t1) - x(s.t0) + 4} height={11} rx={5} fill="none" stroke={COOL} strokeWidth={1.5} filter="url(#fp-glow)" />
            <line x1={mx} y1={my + 6} x2={dp.x} y2={dp.y - 9} stroke="#FFE9C4" strokeWidth={1} strokeDasharray="3 3" opacity={0.8} />
            {landMark && <line x1={x(landMark.at)} y1={RAIL + 8} x2={mx} y2={my - 6} stroke="#FFE9C4" strokeWidth={1} strokeDasharray="3 3" opacity={0.8} />}
          </g>
        );
      })}
      {landMark && <circle cx={x(landMark.at)} cy={RAIL} r={7} fill="none" stroke={KIND_COL.LAND} strokeWidth={1.5} filter="url(#fp-glow)" />}
      <text x={dp.x + 12} y={dp.y + 4} style={{ fontSize: 9, fill: '#FFE9C4', letterSpacing: '0.06em' }}>
        provenance thread — plan → run → land → shipped
      </text>
    </g>
  );
};

// ── DEPTH: the isometric massif over real weekly windows ─────────────────────
const DepthMassif: React.FC<{
  weeks: DepthWeek[] | null;
  metric: DepthMetric;
  onMetric: (m: DepthMetric) => void;
  W: number;
  hovered: number | null;
  onHover: (i: number | null) => void;
  onPick: (i: number, label: string) => void;
}> = ({ weeks, metric, onMetric, W, hovered, onHover, onPick }) => {
  if (!weeks) {
    return (
      <text x={W / 2} y={H / 2} textAnchor="middle" style={{ fontSize: 12, fill: INK.low, letterSpacing: '0.2em' }}>
        LOADING EIGHT WEEKS…
      </text>
    );
  }
  const n = weeks.length;
  const hMax = 128;
  const R = { x: 50, y: 33 };
  const riseMax = H - 100 - hMax - (n - 1) * R.y - 40;
  const rowLenX = Math.max(420, Math.min(W - 700, riseMax / 0.3));
  const NB = 168;
  const T = { x: rowLenX / NB, y: -(rowLenX / NB) * 0.3 };
  const OX = Math.max(180, (W - ((n - 1) * R.x + rowLenX)) / 2 + 30);
  const OY = 100 + hMax + rowLenX * 0.3;
  const P = (w: number, k: number): { x: number; y: number } => ({ x: OX + w * R.x + k * T.x, y: OY + w * R.y + k * T.y });
  const angle = (Math.atan2(T.y, T.x) * 180) / Math.PI;
  const isCum = metric === 'cum';
  const ramp = metric === 'churn' ? RAMP_CHURN : RAMP_MAGMA;

  const series = weeks.map((wk) => {
    const v: number[] = [];
    const rate: number[] = [];
    let acc = 0;
    for (let k = 0; k < NB; k++) {
      const r = metric === 'commits' ? wk.commits[k] : metric === 'churn' ? wk.churn[k] : wk.cost[k];
      rate.push(r ?? 0);
      v.push(isCum ? (acc += wk.cost[k] ?? 0) : (r ?? 0));
    }
    return { v, rate };
  });
  const vMax = Math.max(0.001, ...series.flatMap((s) => s.v));
  const tMax = Math.max(0.001, ...series.flatMap((s) => s.rate));

  return (
    <g>
      <text x={PAD_L} y={104} style={{ fontSize: 21, fontWeight: 700, letterSpacing: '0.3em', fill: INK.hi }}>EIGHT WEEKS</text>
      <text x={PAD_L} y={122} style={{ fontSize: 9, fill: INK.mid, letterSpacing: '0.06em' }}>REAL /api/graph WINDOWS · NEWEST IN FRONT · HOVER ISOLATES · CLICK FLATTENS</text>
      {DEPTH_METRICS.map((m, i) => (
        <text
          key={m.id}
          data-hit
          x={PAD_L + i * 110}
          y={146}
          role="button"
          aria-pressed={metric === m.id}
          cursor="pointer"
          style={{ fontSize: 9, fill: metric === m.id ? EMBER : INK.low, fontWeight: metric === m.id ? 700 : 400, letterSpacing: '0.06em' }}
          onClick={() => onMetric(m.id)}
        >
          {m.label}
        </text>
      ))}
      {/* Taste-review nit: this pane is reached by toggling FLAT→RHYTHM (the one-word DEPTH
          relabel above), so its own heading must echo "RHYTHM" rather than the old "TERRAIN" —
          word-level only, the massif geometry below is untouched. */}
      <text x={W - PAD_R} y={44} textAnchor="end" style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', fill: INK.hi }}>
        RHYTHM — {DEPTH_METRICS.find((m) => m.id === metric)?.label}
      </text>
      <text x={W - PAD_R} y={58} textAnchor="end" style={{ fontSize: 9, fill: INK.mid }}>
        {isCum ? 'strands: height cumulative $ · colour $/hr rate' : 'height = colour = intensity'}
      </text>

      {weeks.map((wk, w) => {
        const b0 = P(w, 0);
        const b1 = P(w, NB);
        const live = w === n - 1;
        const gid = `fp-ridge-${w}-${metric}`;
        const stops: React.ReactNode[] = [];
        const STEP = 6;
        for (let k = 0; k < NB; k += STEP) {
          let s = 0;
          let c = 0;
          for (let j = k; j < Math.min(k + STEP, NB); j++) {
            s += series[w].rate[j];
            c++;
          }
          stops.push(<stop key={k} offset={(k / NB).toFixed(3)} stopColor={rampColor(ramp, s / c / tMax)} />);
        }
        let profile = '';
        for (let k = 0; k < NB; k++) {
          const p = P(w, k + 0.5);
          profile += `${profile ? ' L' : 'M'} ${p.x.toFixed(1)} ${(p.y - (series[w].v[k] / vMax) * hMax).toFixed(1)}`;
        }
        const closed = `M ${b0.x.toFixed(1)} ${b0.y.toFixed(1)} ${profile.slice(1)} L ${b1.x.toFixed(1)} ${b1.y.toFixed(1)} Z`;
        const tot = { c: wk.commits.reduce((a, b) => a + b, 0), d: wk.cost.reduce((a, b) => a + b, 0) };
        const cls = `fp-drc${hovered !== null && hovered !== w ? ' dim' : ''}${hovered === w ? ' lift' : ''}`;
        return (
          <g key={w}>
            <g className={cls}>
              <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1={b0.x} y1={b0.y} x2={b1.x} y2={b1.y}>
                {stops}
              </linearGradient>
              <line x1={b0.x - 52} y1={b0.y - 52 * (T.y / T.x)} x2={b1.x + 36} y2={b1.y + 36 * (T.y / T.x)} stroke={INK.faint} strokeWidth={0.8} strokeDasharray="1 5" opacity={0.85} />
              {isCum ? (
                <>
                  <path d={closed} fill={`url(#${gid})`} opacity={0.07} />
                  <path d={profile} fill="none" stroke={`url(#${gid})`} strokeWidth={live ? 2.4 : 1.8} />
                  <circle cx={P(w, (wk.nowHour ?? NB) - 0.5).x} cy={P(w, (wk.nowHour ?? NB) - 0.5).y - (series[w].v[Math.min(NB - 1, (wk.nowHour ?? NB) - 1)] / vMax) * hMax} r={2.4} fill="#FFE9C4" />
                  <text
                    x={P(w, (wk.nowHour ?? NB) - 0.5).x + 7}
                    y={P(w, (wk.nowHour ?? NB) - 0.5).y - (series[w].v[Math.min(NB - 1, (wk.nowHour ?? NB) - 1)] / vMax) * hMax + 3}
                    style={{ fontSize: 9, fill: '#FFE9C4' }}
                  >
                    ${Math.round(series[w].v[Math.min(NB - 1, (wk.nowHour ?? NB) - 1)])}
                  </text>
                </>
              ) : (
                <path d={closed} fill={`url(#${gid})`} />
              )}
              <line x1={b0.x} y1={b0.y} x2={b1.x} y2={b1.y} stroke={live ? EMBER : HAIRLINE2} strokeWidth={live ? 1.2 : 1} opacity={live ? 0.8 : 0.95} />
              <text x={b0.x - 12} y={b0.y + 4} textAnchor="end" style={{ fontSize: live ? 11 : 9, fontWeight: live ? 700 : 400, letterSpacing: live ? '0.14em' : '0.06em', fill: live ? EMBER : INK.mid }}>
                {wk.label}
              </text>
              <text x={b0.x - 12} y={b0.y + 16} textAnchor="end" style={{ fontSize: 8, fill: INK.low }}>
                ${Math.round(tot.d)} · {tot.c}c
              </text>
              {live && wk.nowHour !== undefined && wk.nowHour < NB && (
                <circle cx={P(w, wk.nowHour).x} cy={P(w, wk.nowHour).y - 34} r={2.6} fill={EMBER} className="fp-pulse" />
              )}
            </g>
            <polygon
              data-hit
              points={`${b0.x - 66},${b0.y - hMax - 30} ${b1.x + 24},${b1.y - hMax - 30} ${b1.x + 24},${b1.y + 14} ${b0.x - 66},${b0.y + 20}`}
              fill="transparent"
              cursor="pointer"
              role="button"
              aria-label={`${wk.label}: hover isolates, click opens the flat view`}
              onPointerEnter={() => onHover(w)}
              onClick={() => onPick(w, wk.label)}
            />
          </g>
        );
      })}
      {/* day ticks on the front row */}
      {Array.from({ length: 8 }, (_, dd) => {
        const p = P(n - 1, dd * 24);
        return (
          <g key={dd}>
            <line x1={p.x} y1={p.y + 5} x2={p.x} y2={p.y + 10} stroke={INK.faint} strokeWidth={0.75} />
            {dd < 7 && (
              <text x={p.x + 8} y={p.y + 22} transform={`rotate(${angle.toFixed(1)} ${p.x + 8} ${p.y + 22})`} style={{ fontSize: 8, fill: INK.faint }}>
                D{dd + 1}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
};

export default FleetPulseCanvas;
