/**
 * GraphCanvas — the interactive omp-graph renderer, in the Felton "One Week" idiom.
 *
 * The graph lives in a FIXED-HEIGHT viewport: taller content scrolls inside it via
 * drag (drag pans time on x AND scrolls tracks on y), wheel zooms time. Day-column
 * headers stay pinned at the top and the hours ruler at the bottom while the tracks
 * scroll between them (clipped). One shared time axis; each track renders by its
 * primitive type. d3-scale/shape for scales + line/area paths.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { scaleLinear, scaleSqrt, scaleSymlog, scaleTime } from 'd3-scale';
import { area, curveMonotoneX, line } from 'd3-shape';
import { magma } from '../lib/heatmap';
import { useGraphView } from './useGraphView';
import { kindColor, statusColor, type EventMark, type GraphDatum, type GraphDoc, type GraphTrack, type Scale, type Span } from './types';

const LABEL_W = 118;
const PAD_R = 34; // right margin holds the value-scale labels
const AXIS_H = 28;
const HEADER_H = 44;
const GROUP_H = 28;
const TRACK_GAP = 14;
const MAX_BAR = 18; // cap bar width so a day-wide bin isn't a giant block

const fmtV = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k` : `${Math.round(v)}`);
const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const short = (s: string, n = 24): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const cat = (c: string): string => (c === 'active' ? '#3d7dff' : c === 'busy' ? '#2fb6d6' : '#7b4bd0');

/** Sparse event tracks don't deserve the full milestones height. */
const eventsHeight = (n: number): number => (n <= 2 ? 60 : n <= 6 ? 100 : n <= 14 ? 148 : 200);
const trackHeight = (t: GraphTrack): number =>
  t.type === 'events' ? eventsHeight(t.marks.length) : t.type === 'series' ? 88 : t.type === 'bars' ? 88 : t.type === 'spans' ? 132 : 28;

/** Second-line descriptor under each track name (the poster's structured labels). */
const SUBLABEL: Record<string, string> = {
  'git.milestones': 'commits · Δchurn',
  'git.commits': '+ churn ridge',
  'receipts.cost': 'usd · receipts',
  'receipts.sessions': 'agent runs',
  'receipts.state': 'active / idle',
  'automation.loops': 'scout · dispatch',
  'automation.llm': 'calls / hr',
  'plane.closed': 'issues closed',
  'plane.closedPerDay': 'per day',
  'plane.issues': 'in flight',
  'gcal.meetings': 'events',
  'gcal.perDay': 'per day',
  'gcal.busy': 'busy / free',
  'crm.touches': 'per day',
  'crm.events': 'in / out',
  'crm.contacts': 'conversations',
  'derived.costPerCommit': 'usd ÷ commits',
  'derived.idleBurn': '0-output spend',
};

/** A bars track that renders another (churn) as a ridge BEHIND it, fused into one lane. */
const RIDGE_OVERLAY: Record<string, string> = { 'git.commits': 'git.churn' };
const overlayIds = new Set(Object.values(RIDGE_OVERLAY));

// ── blend: fuse semantically-related tracks into one richer lane ──────────────

/** Merge same-type EVENTS tracks into one annotated rail ("everything that shipped"). */
const MERGE_EVENTS = [{ id: 'shipped', label: 'SHIPPED', sublabel: 'commits · tickets', group: 'fleet', sources: ['git.milestones', 'plane.closed'] }];

/** A composite "instrument" lane that layers several tracks into one blend. */
type PulseRole = 'band' | 'line' | 'lineDim' | 'ticks';
const PULSE = {
  id: 'pulse',
  label: 'FLEET PULSE',
  sublabel: 'cost · runs · llm · state',
  group: 'fleet',
  height: 118,
  layers: [
    { id: 'receipts.state', role: 'band' as PulseRole }, // power: was the fleet on
    { id: 'receipts.cost', role: 'line' as PulseRole }, // amplitude: $ heartbeat
    { id: 'automation.llm', role: 'lineDim' as PulseRole }, // automation shadow
    { id: 'receipts.sessions', role: 'ticks' as PulseRole }, // individual beats
  ],
};

/** Right-edge value-scale labels (max + ~40%) for a bars/series track. */
function valueTicks(mx: number, s: (v: number) => number, y: number, plotX1: number, money: boolean): React.ReactNode {
  const fmt = (v: number): string => (money ? `$${Math.round(v)}` : fmtV(v));
  return (
    <g pointerEvents="none">
      {[mx, mx * 0.4].map((v, i) => (
        <text key={`vt${i}`} x={plotX1 + 3} y={y + s(v) + 3} fontSize={7} fill="#3f4653" className="tabular-nums">{fmt(v)}</text>
      ))}
    </g>
  );
}

function valueScale(vals: number[], h: number, scale: Scale | undefined) {
  const mx = Math.max(1, ...vals);
  const s = scale === 'sqrt' ? scaleSqrt() : scale === 'log' ? scaleSymlog().constant(8) : scaleLinear();
  return { s: s.domain([0, mx]).range([h - 2, 2]), mx };
}

interface Row {
  kind: 'group' | 'track' | 'pulse';
  label: string;
  sublabel?: string;
  groupId: string;
  y: number;
  h: number;
  track?: GraphTrack;
  pulseLayers?: { role: PulseRole; track: GraphTrack }[];
}

export const GraphCanvas: React.FC<{ doc: GraphDoc; blend?: boolean; onSelect?: (d: GraphDatum) => void; selected?: GraphDatum | null }> = ({ doc, blend = true, onSelect, selected }) => {
  const [userCollapsed, setUserCollapsed] = useState<Record<string, boolean>>({});
  const [hoverDatum, setHoverDatum] = useState<{ d: GraphDatum; px: number; py: number } | null>(null);

  // Groups whose data is thin OR time-clustered collapse by default, so the graph
  // leads with the dense, meaningful lanes and tucks sparse ones into a header you
  // can expand — no more empty sections dangling at the bottom.
  const autoCollapsed = useMemo(() => {
    const set = new Set<string>();
    const span = Math.max(1, doc.range.end - doc.range.start);
    for (const g of doc.groups) {
      let count = 0;
      let minT = Infinity;
      let maxT = -Infinity;
      const note = (t: number): void => { if (t < minT) minT = t; if (t > maxT) maxT = t; };
      for (const t of doc.tracks.filter((z) => z.group === g.id)) {
        if (t.type === 'events') for (const m of t.marks) { count++; note(m.t); }
        else if (t.type === 'bars') for (const b of t.bins) { if (b.v > 0) { count++; note(b.t); } }
        else if (t.type === 'series') for (const p of t.points) { if (p.v > 0) { count++; note(p.t); } }
        else if (t.type === 'spans') for (const s of t.spans) { count++; note(s.t0); note(s.t1); }
        else for (const s of t.segments) { count++; note(s.t0); note(s.t1); }
      }
      const coverage = maxT > minT ? (maxT - minT) / span : 0;
      if (count < 6 || coverage < 0.25) set.add(g.id);
    }
    return set;
  }, [doc]);
  const isCol = useCallback((id: string): boolean => (id in userCollapsed ? userCollapsed[id] : autoCollapsed.has(id)), [userCollapsed, autoCollapsed]);
  const toggleGroup = useCallback((id: string): void => setUserCollapsed((u) => ({ ...u, [id]: !(id in u ? u[id] : autoCollapsed.has(id)) })), [autoCollapsed]);

  // Vertical layout as a function of a lane-height scale, so we can lay out once at
  // 1×, measure, then re-lay-out scaled UP to fill the viewport when the content is
  // shorter than the available height. That's the anti-squish: lanes breathe into
  // the space instead of sitting short with dead space below. Group headers keep a
  // fixed height; only the data lanes (and the gaps between them) scale.
  const layoutOf = useCallback(
    (laneScale: number): { rows: Row[]; totalH: number; groupExtents: { id: string; label: string; y0: number; y1: number }[] } => {
      const out: Row[] = [];
      const extents: { id: string; label: string; y0: number; y1: number }[] = [];
      const gap = TRACK_GAP * laneScale;
      const laneH = (h: number): number => Math.round(h * laneScale);

      // blend preprocessing: which tracks fuse, and into what.
      const consumed = new Set<string>(overlayIds); // churn always folds into commits
      const mergedByGroup = new Map<string, GraphTrack[]>();
      const subById = new Map<string, string>();
      let pulseLayers: { role: PulseRole; track: GraphTrack }[] = [];
      if (blend) {
        for (const m of MERGE_EVENTS) {
          const marks: EventMark[] = [];
          for (const id of m.sources) {
            const t = doc.tracks.find((z) => z.id === id);
            if (t && t.type === 'events') { marks.push(...t.marks); consumed.add(id); }
          }
          if (!marks.length) continue;
          marks.sort((a, b) => a.t - b.t);
          const synth: GraphTrack = { id: m.id, label: m.label, group: m.group, source: 'merged', type: 'events', marks };
          const arr = mergedByGroup.get(m.group) ?? [];
          arr.push(synth);
          mergedByGroup.set(m.group, arr);
          subById.set(m.id, m.sublabel);
        }
        const layers = PULSE.layers.map((l) => ({ role: l.role, track: doc.tracks.find((z) => z.id === l.id) })).filter((l): l is { role: PulseRole; track: GraphTrack } => !!l.track);
        if (layers.length) { pulseLayers = layers; for (const l of PULSE.layers) consumed.add(l.id); }
      }

      let y = HEADER_H;
      for (const g of doc.groups) {
        const merged = mergedByGroup.get(g.id) ?? [];
        const remaining = doc.tracks.filter((t) => t.group === g.id && !consumed.has(t.id));
        const hasPulse = blend && PULSE.group === g.id && pulseLayers.length > 0;
        if (!merged.length && !remaining.length && !hasPulse) continue;
        const y0 = y;
        out.push({ kind: 'group', label: g.label, groupId: g.id, y, h: GROUP_H });
        y += GROUP_H;
        if (!isCol(g.id)) {
          // merged rails first, then remaining tracks, then the pulse instrument
          for (const s of merged) {
            const h = laneH(trackHeight(s));
            out.push({ kind: 'track', label: s.label, sublabel: subById.get(s.id), groupId: g.id, y, h, track: s });
            y += h + gap;
          }
          for (const t of remaining) {
            const h = laneH(trackHeight(t));
            out.push({ kind: 'track', label: t.label, sublabel: SUBLABEL[t.id], groupId: g.id, y, h, track: t });
            y += h + gap;
          }
          if (hasPulse) {
            const h = laneH(PULSE.height);
            out.push({ kind: 'pulse', label: PULSE.label, sublabel: PULSE.sublabel, groupId: g.id, y, h, pulseLayers });
            y += h + gap;
          }
        }
        extents.push({ id: g.id, label: g.label, y0, y1: y - gap });
      }
      return { rows: out, totalH: y + AXIS_H, groupExtents: extents };
    },
    [doc, isCol, blend],
  );

  const base = useMemo(() => layoutOf(1), [layoutOf]);
  const view = useGraphView(doc.range, LABEL_W, PAD_R, base.totalH);
  const viewportH = Math.max(120, view.viewportH); // fills its container

  // Grow-to-fill: solve for the lane scale that makes the 1× layout exactly fill the
  // track area (group headers are fixed overhead; lanes + gaps scale). Clamp to
  // [1, 2.4] — never shrink (tall content just scrolls), never balloon a lone lane.
  const laneScale = useMemo(() => {
    const groupHeaders = base.rows.reduce((a, r) => a + (r.kind === 'group' ? GROUP_H : 0), 0);
    const scalable = base.totalH - HEADER_H - AXIS_H - groupHeaders; // lanes + gaps at 1×
    const avail = viewportH - HEADER_H - AXIS_H;
    if (scalable <= 0 || avail < 80) return 1;
    return Math.max(1, Math.min(2.4, (avail - groupHeaders) / scalable));
  }, [base, viewportH]);

  const { rows, groupExtents } = useMemo(() => (laneScale <= 1.001 ? base : layoutOf(laneScale)), [base, laneScale, layoutOf]);

  // ── interaction: every discrete datum is hoverable + clickable ───────────────
  // px/py are container-relative screen coords: canvasY minus the vertical scroll
  // offset, so the tooltip/detail line up with where the mark actually sits.
  // t alone collides — commits share per-second timestamps, spans can share t0 — so
  // also disambiguate on end-time + title, else selecting one rings its twin too.
  const sameDatum = (a: GraphDatum | null | undefined, b: GraphDatum): boolean =>
    !!a && a.trackId === b.trackId && a.variant === b.variant && a.t === b.t && a.t1 === b.t1 && a.title === b.title;
  const eventDatum = (tr: GraphTrack, m: EventMark): GraphDatum => ({ variant: 'event', trackId: tr.id, trackLabel: tr.label, source: tr.source, t: m.t, title: m.label, kind: m.kind, value: m.value, meta: m.meta });
  const spanDatum = (tr: GraphTrack, sp: Span): GraphDatum => ({ variant: 'span', trackId: tr.id, trackLabel: tr.label, source: tr.source, t: sp.t0, t1: sp.t1, title: sp.label, status: sp.status, value: sp.value, meta: sp.meta });
  const barDatum = (tr: GraphTrack, b: { t: number; v: number }, binMs: number): GraphDatum => ({ variant: 'bar', trackId: tr.id, trackLabel: tr.label, source: tr.source, t: b.t, t1: b.t + binMs, title: tr.label, value: b.v, unit: tr.unit });
  const seriesDatum = (tr: GraphTrack, p: { t: number; v: number }): GraphDatum => ({ variant: 'series', trackId: tr.id, trackLabel: tr.label, source: tr.source, t: p.t, title: tr.label, value: p.v, unit: tr.unit });
  const POINTER = { cursor: 'pointer' as const };
  const markHandlers = (d: GraphDatum, px: number, py: number) => ({
    onMouseEnter: () => setHoverDatum({ d, px, py }),
    onMouseLeave: () => setHoverDatum(null),
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(), // click a mark, don't start a pan
    onClick: (e: React.MouseEvent) => { e.stopPropagation(); onSelect?.(d); },
  });

  const x = scaleTime().domain([new Date(view.domain[0]), new Date(view.domain[1])]).range([view.plotX0, view.plotX1]);
  const inView = (t: number): boolean => t >= view.domain[0] - 1 && t <= view.domain[1] + 1;
  const axisY = viewportH - AXIS_H; // fixed bottom axis line
  const tracksBottom = axisY;
  const tracksTop = HEADER_H;

  const dayTicks = useMemo(() => {
    const ticks: { t: number; weekdayLong: string; date: string }[] = [];
    const start = new Date(view.domain[0]);
    start.setHours(0, 0, 0, 0);
    for (let cur = start.getTime(); cur <= view.domain[1]; cur += 86_400_000) {
      const dd = new Date(cur);
      ticks.push({ t: cur, weekdayLong: dd.toLocaleDateString(undefined, { weekday: 'long' }), date: dd.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }) });
    }
    return ticks;
  }, [view.domain]);

  const spanDays = (view.domain[1] - view.domain[0]) / 86_400_000;

  // ── FLEET PULSE composite: state (power) + cost (amplitude) + llm (shadow) + sessions (beats) ──
  function renderPulse(layers: { role: PulseRole; track: GraphTrack }[], y: number, h: number): React.ReactNode {
    const els: React.ReactNode[] = [];
    const bandT = layers.find((l) => l.role === 'band')?.track;
    const lineT = layers.find((l) => l.role === 'line')?.track;
    const dimT = layers.find((l) => l.role === 'lineDim')?.track;
    const ticksT = layers.find((l) => l.role === 'ticks')?.track;
    const tickStrip = 13;
    const waveBottom = y + h - tickStrip - 2;
    const waveTop = y + 12;

    // power: active/idle band as a faint wash behind everything
    if (bandT?.type === 'bands') {
      bandT.segments.forEach((sg, i) => {
        if (sg.t1 < view.domain[0] || sg.t0 > view.domain[1]) return;
        const sx = Math.max(view.plotX0, x(new Date(sg.t0)));
        els.push(<rect key={`pb${i}`} x={sx} y={y + 2} width={Math.max(1, x(new Date(sg.t1)) - sx)} height={h - 4} fill="#3d7dff" fillOpacity={0.05} />);
      });
    }
    // automation shadow: llm bars → a dim magenta line
    if (dimT?.type === 'bars') {
      const mx = Math.max(1, ...dimT.bins.map((b) => b.v));
      const s = scaleSqrt().domain([0, mx]).range([waveBottom, waveTop]);
      const ln = line<{ t: number; v: number }>().x((b) => x(new Date(b.t + dimT.binMs / 2))).y((b) => s(b.v)).curve(curveMonotoneX);
      els.push(<path key="pllm" d={ln(dimT.bins.filter((b) => inView(b.t))) ?? undefined} fill="none" stroke="#b5307a" strokeOpacity={0.5} strokeWidth={0.9} />);
    }
    // amplitude: cost/hr as the hero waveform
    if (lineT?.type === 'series') {
      const mx = Math.max(1, ...lineT.points.map((p) => p.v));
      const s = scaleSqrt().domain([0, mx]).range([waveBottom, waveTop]);
      const ar = area<{ t: number; v: number }>().x((p) => x(new Date(p.t))).y0(waveBottom).y1((p) => s(p.v)).curve(curveMonotoneX);
      const ln = line<{ t: number; v: number }>().x((p) => x(new Date(p.t))).y((p) => s(p.v)).curve(curveMonotoneX);
      els.push(<path key="pca" d={ar(lineT.points) ?? undefined} fill="#f2913d" fillOpacity={0.13} />);
      els.push(<path key="pcl" d={ln(lineT.points) ?? undefined} fill="none" stroke="#f2913d" strokeWidth={1.3} style={{ filter: 'drop-shadow(0 0 2px #f2913d55)' }} />);
      const peak = lineT.points.reduce((m, p) => (p.v > m.v ? p : m), { t: 0, v: 0 });
      if (peak.v > 0 && inView(peak.t)) {
        els.push(<circle key="pcp" cx={x(new Date(peak.t))} cy={s(peak.v)} r={2.5} fill="#fbe9a0" />);
        els.push(<text key="pct" x={x(new Date(peak.t))} y={s(peak.v) - 5} fontSize={8.5} fontWeight={700} textAnchor="middle" fill="#f2c46b" className="tabular-nums">{`$${peak.v.toFixed(1)}/hr`}</text>);
      }
      els.push(<text key="pv1" x={view.plotX1 + 3} y={s(mx) + 3} fontSize={7} fill="#3f4653" className="tabular-nums">{`$${Math.round(mx)}`}</text>);
      els.push(<text key="pv2" x={view.plotX1 + 3} y={s(mx * 0.4) + 3} fontSize={7} fill="#3f4653" className="tabular-nums">{`$${Math.round(mx * 0.4)}`}</text>);
    }
    // baseline + beats: each agent run as a tick along the bottom strip
    els.push(<line key="pbase" x1={view.plotX0} y1={waveBottom} x2={view.plotX1} y2={waveBottom} stroke="#1b2130" strokeWidth={0.8} />);
    if (ticksT?.type === 'spans') {
      ticksT.spans.forEach((sp, i) => {
        if (sp.t1 < view.domain[0] || sp.t0 > view.domain[1]) return;
        const tx = x(new Date(sp.t0));
        if (tx < view.plotX0 || tx > view.plotX1) return;
        els.push(<line key={`pt${i}`} x1={tx} y1={y + h - tickStrip} x2={tx} y2={y + h - 3} stroke={statusColor(sp.status)} strokeOpacity={0.8} strokeWidth={1} />);
      });
    }
    // legend
    let lx = view.plotX1;
    for (const it of [{ c: '#3d7dff', t: 'runs' }, { c: '#b5307a', t: 'llm' }, { c: '#f2913d', t: 'cost' }]) {
      lx -= it.t.length * 4.6 + 14;
      els.push(<g key={`plg${it.t}`} pointerEvents="none"><rect x={lx} y={y + 1} width={7} height={7} rx={1} fill={it.c} /><text x={lx + 10} y={y + 8} fontSize={7.5} fill="#7a8390">{it.t}</text></g>);
    }
    return els;
  }

  // ── per-track renderers (drawn inside the translated tracks group) ──────────
  function renderTrack(t: GraphTrack, y: number, h: number): React.ReactNode {
    if (t.type === 'bars') {
      const { s, mx } = valueScale(t.bins.map((b) => b.v), h, t.scale);
      const peak = t.bins.reduce((m, b) => (b.v > m.v ? b : m), { t: 0, v: 0 });
      const els: React.ReactNode[] = [];

      // churn ridge fused BEHIND the commit bars — the poster's "COMMITS + churn ridge".
      const ridge = RIDGE_OVERLAY[t.id] ? doc.tracks.find((z) => z.id === RIDGE_OVERLAY[t.id]) : undefined;
      if (ridge && ridge.type === 'bars') {
        const { s: rs } = valueScale(ridge.bins.map((b) => b.v), h, ridge.scale);
        const pts = ridge.bins.filter((b) => inView(b.t));
        const ar = area<{ t: number; v: number }>().x((b) => x(new Date(b.t + ridge.binMs / 2))).y0(y + h).y1((b) => y + rs(b.v)).curve(curveMonotoneX);
        const ln = line<{ t: number; v: number }>().x((b) => x(new Date(b.t + ridge.binMs / 2))).y((b) => y + rs(b.v)).curve(curveMonotoneX);
        els.push(<path key="rgA" d={ar(pts) ?? undefined} fill="#7b1f6f" fillOpacity={0.26} />);
        els.push(<path key="rgL" d={ln(pts) ?? undefined} fill="none" stroke="#b5307a" strokeOpacity={0.6} strokeWidth={0.9} />);
        const rp = ridge.bins.reduce((m, b) => (b.v > m.v ? b : m), { t: 0, v: 0 });
        if (rp.v > 0 && inView(rp.t)) els.push(<text key="rgP" x={x(new Date(rp.t))} y={y + 8} fontSize={8} fontWeight={600} textAnchor="middle" fill="#b5307a" className="tabular-nums">{`Δ${fmtV(rp.v)} churn`}</text>);
      }

      for (const b of t.bins.filter((z) => z.v > 0 && inView(z.t))) {
        const bl = x(new Date(b.t));
        const binW = x(new Date(b.t + t.binMs)) - bl;
        const bw = Math.max(1, Math.min(binW - 0.6, MAX_BAR));
        const by = y + s(b.v);
        const d = barDatum(t, b, t.binMs);
        const sel = sameDatum(selected, d);
        els.push(<rect key={`b${b.t}`} x={bl + (binW - bw) / 2} y={by} width={bw} height={y + h - by} fill={magma(mx > 0 ? b.v / mx : 0)} stroke={sel ? '#fbe9a0' : undefined} strokeWidth={sel ? 1 : undefined} style={{ cursor: 'pointer', ...(b.t === peak.t ? { filter: 'drop-shadow(0 0 4px #fbe9a0aa)' } : {}) }} {...markHandlers(d, bl + binW / 2, by - view.offsetY)} />);
      }
      // peak label top-LEFT (header strip), not over the data on the right
      if (peak.v > 0) els.push(<text key="pk" x={view.plotX0 + 2} y={y + 8} fontSize={8} fontWeight={600} fill="#8a92a0" className="tabular-nums">{`peak ${fmtV(peak.v)}${t.unit ? ' ' + t.unit : ''}`}</text>);
      els.push(<React.Fragment key="vt">{valueTicks(mx, s, y, view.plotX1, false)}</React.Fragment>);
      return <>{els}</>;
    }
    if (t.type === 'series') {
      const { s, mx } = valueScale(t.points.map((p) => p.v), h, t.scale);
      const peak = t.points.reduce((m, p) => (p.v > m.v ? p : m), { t: 0, v: 0 });
      const ln = line<{ t: number; v: number }>().x((p) => x(new Date(p.t))).y((p) => y + s(p.v)).curve(curveMonotoneX);
      const ar = area<{ t: number; v: number }>().x((p) => x(new Date(p.t))).y0(y + h).y1((p) => y + s(p.v)).curve(curveMonotoneX);
      const money = t.unit === '$';
      return (
        <>
          <path d={ar(t.points) ?? undefined} fill="#f2913d" fillOpacity={0.14} />
          <path d={ln(t.points) ?? undefined} fill="none" stroke="#f2913d" strokeWidth={1.3} style={{ filter: 'drop-shadow(0 0 2px #f2913d55)' }} />
          {peak.v > 0 && inView(peak.t) && (
            <g pointerEvents="none">
              <circle cx={x(new Date(peak.t))} cy={y + s(peak.v)} r={2.5} fill="#fbe9a0" />
              <text x={x(new Date(peak.t))} y={y + s(peak.v) - 5} fontSize={8.5} fontWeight={700} textAnchor="middle" fill="#f2c46b" className="tabular-nums">{money ? `$${peak.v.toFixed(1)}/hr` : `${fmtV(peak.v)}${t.unit ? ' ' + t.unit : ''}`}</text>
            </g>
          )}
          {t.points.filter((p) => inView(p.t) && p.v > 0).map((p, i) => {
            const cx = x(new Date(p.t));
            const cy = y + s(p.v);
            const d = seriesDatum(t, p);
            const sel = sameDatum(selected, d);
            return (
              <g key={`sp${i}`} style={POINTER} {...markHandlers(d, cx, cy - view.offsetY)}>
                {sel && <circle cx={cx} cy={cy} r={4} fill="none" stroke="#fbe9a0" strokeWidth={1.2} />}
                <circle cx={cx} cy={cy} r={6} fill="transparent" />
              </g>
            );
          })}
          {valueTicks(mx, s, y, view.plotX1, money)}
        </>
      );
    }
    if (t.type === 'events') {
      const marks = t.marks.filter((m) => inView(m.t)).sort((a, b) => a.t - b.t);
      const railY = y + 18; // leave a top strip for the legend so it never overlaps annotations
      const lineH = 11;
      const CHAR = 4.5;
      const top0 = railY + 10;
      const bottomLimit = y + h - 2;

      const clusters: { marks: EventMark[]; x: number }[] = [];
      for (const m of marks) {
        const last = clusters[clusters.length - 1];
        if (last && x(new Date(m.t)) - x(new Date(last.marks[last.marks.length - 1].t)) <= 11) last.marks.push(m);
        else clusters.push({ marks: [m], x: x(new Date(m.t)) });
      }

      const els: React.ReactNode[] = [];
      // index keys, NOT timestamps — commits share per-second dates, and duplicate
      // keys leave "ghost" dots that React can't reconcile away when the view changes.
      marks.forEach((m, i) => {
        const cx = x(new Date(m.t));
        const d = eventDatum(t, m);
        const sel = sameDatum(selected, d);
        els.push(
          <g key={`d${i}`} style={POINTER} {...markHandlers(d, cx, railY - view.offsetY)}>
            {sel && <circle cx={cx} cy={railY} r={5.5} fill="none" stroke="#fbe9a0" strokeWidth={1.3} />}
            <circle cx={cx} cy={railY} r={sel ? 3.4 : 2.2} fill={kindColor(m.kind)} />
            <circle cx={cx} cy={railY} r={7} fill="transparent" />
          </g>,
        );
      });

      type L = { kind?: string; text: string; delta?: string; color: string };
      const blocks = clusters.map((cl) => {
        const lines: L[] = [];
        if (cl.marks.length > 1) lines.push({ text: `${cl.marks.length}× ${hhmm(new Date(cl.marks[0].t))}–${hhmm(new Date(cl.marks[cl.marks.length - 1].t))}`, color: '#6d7480' });
        for (const m of cl.marks.slice(0, 5)) lines.push({ kind: (m.kind ?? '').toUpperCase(), text: short(m.label.replace(/^[✓→←·]\s*/, ''), 24), delta: m.value ? `Δ${fmtV(m.value)}` : undefined, color: kindColor(m.kind) });
        if (cl.marks.length > 5) lines.push({ text: `+${cl.marks.length - 5}`, color: '#5a6270' });
        const w = 10 + Math.max(...lines.map((l) => ((l.kind ? l.kind.length + 1 : 0) + l.text.length + (l.delta ? l.delta.length + 1 : 0)) * CHAR));
        const important = cl.marks.some((m) => m.kind === 'land' || m.kind === 'feat' || m.kind === 'done');
        return { cl, lines, w, bh: lines.length * lineH, priority: cl.marks.length + (important ? 6 : 0) };
      });

      const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
      const hits = (a: { x0: number; x1: number; y0: number; y1: number }, b: { x0: number; x1: number; y0: number; y1: number }) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
      // Place right-to-left (most-recent on top): a block's connector then always
      // sits LEFT of the text above it, so the vertical line never crosses a label.
      [...blocks].sort((a, b) => b.cl.x - a.cl.x).forEach((blk, bi) => {
        const xc = blk.cl.x;
        const rightAlign = xc + blk.w > view.plotX1 - 4;
        const rx0 = rightAlign ? xc - blk.w : xc - 1;
        const rx1 = rightAlign ? xc + 1 : xc + blk.w;
        let top: number | null = null;
        for (let cand = top0; cand + blk.bh <= bottomLimit; cand += lineH) {
          const rect = { x0: rx0, x1: rx1, y0: cand, y1: cand + blk.bh };
          if (!placed.some((p) => hits(rect, p))) { top = cand; placed.push(rect); break; }
        }
        if (top === null) return;
        els.push(<line key={`c${bi}`} x1={xc} y1={railY + 2} x2={xc} y2={top - 1} stroke={kindColor(blk.cl.marks[0].kind)} strokeOpacity={0.22} strokeWidth={0.6} />);
        blk.lines.forEach((l, li) => {
          const ly = top! + li * lineH + 8;
          els.push(
            <text key={`l${bi}-${li}`} x={rightAlign ? xc - 4 : xc + 4} y={ly} textAnchor={rightAlign ? 'end' : 'start'} fontSize={8} className="tabular-nums">
              {l.kind && <tspan fontWeight={700} fill={l.color}>{l.kind} </tspan>}
              <tspan fill={l.kind ? '#9aa1ad' : l.color} fontWeight={l.kind ? 400 : 600}>{l.text}</tspan>
              {l.delta && <tspan fill="#5a6270"> {l.delta}</tspan>}
            </text>,
          );
        });
      });

      const kinds = [...new Set(marks.map((m) => m.kind ?? 'other'))].slice(0, 6);
      let lx = view.plotX1;
      for (const k of [...kinds].reverse()) {
        lx -= k.length * 4.6 + 14;
        els.push(
          <g key={`lg${k}`} pointerEvents="none">
            <rect x={lx} y={y + 1} width={7} height={7} rx={1} fill={kindColor(k)} />
            <text x={lx + 10} y={y + 8} fontSize={7.5} fill="#7a8390">{k}</text>
          </g>,
        );
      }
      return els;
    }
    if (t.type === 'spans') {
      const strip = 12; // top strip for the status legend
      const laneH = 8;
      const gap = 2;
      const maxLanes = Math.max(1, Math.floor((h - strip) / (laneH + gap)));
      const laneEnds: number[] = [];
      const out: React.ReactNode[] = [];
      [...t.spans]
        .sort((a, b) => a.t0 - b.t0)
        .forEach((sp, i) => {
          if (sp.t1 < view.domain[0] || sp.t0 > view.domain[1]) return;
          let lane = laneEnds.findIndex((e) => e <= sp.t0);
          if (lane === -1) { lane = laneEnds.length; laneEnds.push(sp.t1); } else laneEnds[lane] = sp.t1;
          if (lane >= maxLanes) lane = maxLanes - 1;
          const sx = Math.max(view.plotX0, x(new Date(sp.t0)));
          const sw = Math.max(1, x(new Date(sp.t1)) - sx);
          const d = spanDatum(t, sp);
          const sel = sameDatum(selected, d);
          const ry = y + strip + lane * (laneH + gap);
          out.push(<rect key={i} x={sx} y={ry} width={sw} height={laneH} rx={1.5} fill={statusColor(sp.status)} fillOpacity={sel ? 1 : 0.85} stroke={sel ? '#fbe9a0' : undefined} strokeWidth={sel ? 1 : undefined} style={POINTER} {...markHandlers(d, sx + Math.min(sw / 2, 40), ry - view.offsetY)} />);
        });
      // status legend, top-right strip (above the lanes)
      const statuses = [...new Set(t.spans.map((sp) => sp.status ?? 'idle'))].slice(0, 5);
      let lx = view.plotX1;
      for (const st of [...statuses].reverse()) {
        lx -= st.length * 4.6 + 14;
        out.push(
          <g key={`sl${st}`} pointerEvents="none">
            <rect x={lx} y={y + 1} width={7} height={7} rx={1} fill={statusColor(st)} />
            <text x={lx + 10} y={y + 8} fontSize={7.5} fill="#7a8390">{st}</text>
          </g>,
        );
      }
      return out;
    }
    // bands
    return t.segments
      .filter((sg) => sg.t1 >= view.domain[0] && sg.t0 <= view.domain[1])
      .map((sg, i) => {
        const sx = Math.max(view.plotX0, x(new Date(sg.t0)));
        const sw = Math.max(1, x(new Date(sg.t1)) - sx);
        return <rect key={i} x={sx} y={y + 2} width={sw} height={h - 4} rx={2} fill={sg.color ?? cat(sg.category)} fillOpacity={0.5} />;
      });
  }

  const nowX = doc.generatedAt > view.domain[0] && doc.generatedAt < view.domain[1] ? x(new Date(doc.generatedAt)) : null;

  return (
    <div
      ref={view.containerRef}
      className="relative h-full w-full select-none overflow-hidden bg-[#05060a]"
      style={{ cursor: 'grab', touchAction: 'none' }}
      onWheel={view.onWheel}
      onPointerDown={view.onPanStart}
      onMouseLeave={() => setHoverDatum(null)}
    >
      <svg width={view.width} height={viewportH} className="block">
        <defs>
          <clipPath id="omp-graph-tracks">
            <rect x={0} y={tracksTop} width={view.width} height={Math.max(0, tracksBottom - tracksTop)} />
          </clipPath>
        </defs>

        {/* fixed: day separators (full height) */}
        {dayTicks.map((d, i) => (
          <line key={`d${i}`} x1={x(new Date(d.t))} y1={HEADER_H - 26} x2={x(new Date(d.t))} y2={axisY} stroke="#131820" strokeWidth={1} />
        ))}

        {/* scrollable tracks (clipped between the pinned header + axis) */}
        <g clipPath="url(#omp-graph-tracks)">
          <g transform={`translate(0, ${-view.offsetY})`}>
            {/* rotated group labels on the far left — only when the group is tall enough
                to hold the vertical text, so collapsed groups don't overlap each other */}
            {groupExtents.map((g) =>
              g.y1 - g.y0 < g.label.length * 8 + 16 ? null : (
                <text key={`rl${g.id}`} transform={`translate(13, ${(g.y0 + g.y1) / 2}) rotate(-90)`} textAnchor="middle" fontSize={8.5} fontWeight={700} letterSpacing="0.18em" fill="#3f4653">
                  {g.label}
                </text>
              ),
            )}
            {rows.map((r, i) => {
              if (r.kind === 'group') {
                const collapsedNow = isCol(r.groupId);
                return (
                  <g key={`g${i}`} style={{ cursor: 'pointer' }} onPointerDown={(e) => e.stopPropagation()} onClick={() => toggleGroup(r.groupId)}>
                    <text x={26} y={r.y + 16} fontSize={10} fontWeight={700} letterSpacing="0.1em" fill="#c4c9d2">
                      {collapsedNow ? '▸ ' : '▾ '}
                      {r.label}
                    </text>
                  </g>
                );
              }
              return (
                <g key={`t${i}`}>
                  <text x={LABEL_W - 8} y={r.y + 12} textAnchor="end" fontSize={9} fontWeight={600} letterSpacing="0.06em" fill="#8a92a0">{r.label}</text>
                  {r.sublabel && (
                    <text x={LABEL_W - 8} y={r.y + 22} textAnchor="end" fontSize={7} letterSpacing="0.02em" fill="#4a515e">{r.sublabel}</text>
                  )}
                  {r.kind === 'pulse' && r.pulseLayers ? renderPulse(r.pulseLayers, r.y, r.h) : r.track ? renderTrack(r.track, r.y, r.h) : null}
                </g>
              );
            })}
          </g>
        </g>

        {/* fixed: big day-column headers (top band) */}
        <rect x={0} y={0} width={view.width} height={HEADER_H} fill="#05060a" />
        {dayTicks.map((d, i) => (
          <g key={`hd${i}`} pointerEvents="none">
            <text x={x(new Date(d.t)) + 7} y={HEADER_H - 18} fontSize={12.5} fontWeight={700} letterSpacing="0.08em" fill="#c4c9d2">{d.weekdayLong.toUpperCase()}</text>
            <text x={x(new Date(d.t)) + 7} y={HEADER_H - 6} fontSize={9} letterSpacing="0.04em" fill="#6d7480" className="tabular-nums">{d.date}</text>
          </g>
        ))}

        {/* fixed: hours ruler axis (bottom band) */}
        <rect x={0} y={axisY} width={view.width} height={AXIS_H} fill="#05060a" />
        <line x1={view.plotX0} y1={axisY} x2={view.plotX1} y2={axisY} stroke="#1e2430" />
        {spanDays <= 12 &&
          dayTicks.flatMap((d, i) =>
            [0, 6, 12, 18].map((hr) => {
              const tt = d.t + hr * 3_600_000;
              if (tt < view.domain[0] || tt > view.domain[1]) return null;
              return (
                <text key={`hr${i}-${hr}`} x={x(new Date(tt))} y={axisY + 12} fontSize={7} textAnchor="middle" fill="#4a515e" className="tabular-nums">
                  {String(hr).padStart(2, '0')}
                </text>
              );
            }),
          )}

        {/* fixed: now marker + hover cursor */}
        {nowX !== null && (
          <g pointerEvents="none">
            <rect x={nowX} y={HEADER_H} width={Math.max(0, view.plotX1 - nowX)} height={Math.max(0, axisY - HEADER_H)} fill="#0a1420" fillOpacity={0.35} />
            <line x1={nowX} y1={0} x2={nowX} y2={axisY} stroke="#2fb6d6" strokeWidth={1} strokeDasharray="3 3" />
            <text x={nowX + 3} y={HEADER_H - 30} fontSize={8} fontWeight={600} fill="#2fb6d6">now</text>
          </g>
        )}
        {hoverDatum && <line x1={hoverDatum.px} y1={HEADER_H} x2={hoverDatum.px} y2={axisY} stroke="#f2913d" strokeOpacity={0.4} strokeWidth={1} pointerEvents="none" />}
      </svg>

      {/* vertical scroll hint */}
      {view.maxOffsetY > 0 && (
        <div className="pointer-events-none absolute right-1.5 rounded-full bg-[#2a3240]" style={{ top: HEADER_H + 4 + (view.offsetY / view.maxOffsetY) * (axisY - HEADER_H - 40), width: 3, height: 36 }} />
      )}

      {/* per-datum tooltip — describes exactly the mark under the cursor */}
      {hoverDatum && (
        <div
          className="pointer-events-none absolute z-10 max-w-[260px] rounded-md border border-[#232b38] bg-[#0b0e14]/95 px-2.5 py-2 text-[10px] shadow-xl"
          style={{ left: Math.min(hoverDatum.px + 12, view.width - 250), top: Math.max(HEADER_H + 4, Math.min(hoverDatum.py - 6, viewportH - 96)) }}
        >
          <div className="mb-1 flex items-center gap-1.5">
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: hoverDatum.d.kind ? kindColor(hoverDatum.d.kind) : hoverDatum.d.status ? statusColor(hoverDatum.d.status) : '#f2913d' }} />
            <span className="font-semibold uppercase tracking-wider text-[#7a8390]">{hoverDatum.d.trackLabel}</span>
            {hoverDatum.d.value != null && <span className="ml-auto tabular-nums text-[#c4c9d2]">{fmtV(hoverDatum.d.value)}{hoverDatum.d.unit ? ` ${hoverDatum.d.unit}` : ''}</span>}
          </div>
          <div className="mb-1 font-medium leading-snug text-[#e5e8ee]">{short(hoverDatum.d.title, 64)}</div>
          <div className="tabular-nums text-[#6d7480]">
            {new Date(hoverDatum.d.t).toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' })} · {new Date(hoverDatum.d.t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </div>
          <div className="mt-1 text-[9px] text-[#5a6270]">{hoverDatum.d.meta?.sha ? 'click for the diff →' : 'click to inspect →'}</div>
        </div>
      )}
    </div>
  );
};
