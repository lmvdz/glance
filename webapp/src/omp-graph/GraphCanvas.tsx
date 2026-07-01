/**
 * GraphCanvas — the interactive omp-graph renderer.
 *
 * Draws a GraphDoc as stacked, time-aligned tracks (the Felton "One Week"
 * language) in the moodboard's dark idiom. One shared time x-axis; each track
 * renders by its primitive type. Pan/zoom via useGraphView; a shared hover
 * cursor reads every track at the pointer. SVG throughout (crisp text +
 * connectors); d3-scale/shape for scales + line/area paths.
 */

import React, { useMemo, useState } from 'react';
import { scaleLinear, scaleSqrt, scaleSymlog, scaleTime } from 'd3-scale';
import { area, curveMonotoneX, line } from 'd3-shape';
import { magma } from '../lib/heatmap';
import { useGraphView } from './useGraphView';
import { kindColor, statusColor, type EventMark, type GraphDoc, type GraphTrack, type Scale } from './types';

const LABEL_W = 118;
const PAD_R = 18;
const AXIS_H = 26;
const HEADER_H = 44; // top band for big weekday/date column headers
const GROUP_H = 24;
const TRACK_H: Record<GraphTrack['type'], number> = { events: 176, series: 72, bars: 72, spans: 116, bands: 24 };
const TRACK_GAP = 10;

/** Compact churn/Δ formatter (865 → "865", 16400 → "16.4k"). */
const fmtV = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k` : `${Math.round(v)}`);
const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

interface Row {
  kind: 'group' | 'track';
  label: string;
  groupId: string;
  y: number;
  h: number;
  track?: GraphTrack;
}

/** A value-axis scale for a track, honoring its scale hint. */
function valueScale(vals: number[], h: number, scale: Scale | undefined) {
  const mx = Math.max(1, ...vals);
  const s = scale === 'sqrt' ? scaleSqrt() : scale === 'log' ? scaleSymlog().constant(8) : scaleLinear();
  return { s: s.domain([0, mx]).range([h - 2, 2]), mx };
}

const cat = (c: string): string => (c === 'active' ? '#3d7dff' : c === 'busy' ? '#2fb6d6' : '#7b4bd0');
const short = (s: string, n = 44): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const GraphCanvas: React.FC<{ doc: GraphDoc }> = ({ doc }) => {
  const view = useGraphView(doc.range, LABEL_W, PAD_R);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);

  // Vertical layout — independent of the time domain, so it memoizes cleanly.
  const { rows, totalH } = useMemo(() => {
    const out: Row[] = [];
    let y = HEADER_H;
    for (const g of doc.groups) {
      const tracks = doc.tracks.filter((t) => t.group === g.id);
      if (!tracks.length) continue;
      out.push({ kind: 'group', label: g.label, groupId: g.id, y, h: GROUP_H });
      y += GROUP_H;
      if (!collapsed.has(g.id)) {
        for (const t of tracks) {
          const h = TRACK_H[t.type];
          out.push({ kind: 'track', label: t.label, groupId: g.id, y, h, track: t });
          y += h + TRACK_GAP;
        }
      }
    }
    return { rows: out, totalH: y + AXIS_H };
  }, [doc, collapsed]);

  const x = scaleTime()
    .domain([new Date(view.domain[0]), new Date(view.domain[1])])
    .range([view.plotX0, view.plotX1]);
  const inView = (t: number): boolean => t >= view.domain[0] - 1 && t <= view.domain[1] + 1;

  const axisY = totalH - AXIS_H;

  // ── day separators + ticks ────────────────────────────────────────────────
  const dayTicks = useMemo(() => {
    const ticks: { t: number; weekday: string; weekdayLong: string; date: string }[] = [];
    const start = new Date(view.domain[0]);
    start.setHours(0, 0, 0, 0);
    for (let cur = start.getTime(); cur <= view.domain[1]; cur += 86_400_000) {
      const dd = new Date(cur);
      ticks.push({
        t: cur,
        weekday: dd.toLocaleDateString(undefined, { weekday: 'short' }),
        weekdayLong: dd.toLocaleDateString(undefined, { weekday: 'long' }),
        date: dd.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }),
      });
    }
    return ticks;
  }, [view.domain]);

  const spanDays = (view.domain[1] - view.domain[0]) / 86_400_000;
  const hourTicks = useMemo(() => {
    if (spanDays > 3) return [] as number[];
    const out: number[] = [];
    const d = new Date(view.domain[0]);
    d.setMinutes(0, 0, 0);
    for (let cur = d.getTime(); cur <= view.domain[1]; cur += 3_600_000) if (cur >= view.domain[0]) out.push(cur);
    return out;
  }, [view.domain, spanDays]);

  // ── per-track renderers ───────────────────────────────────────────────────
  function renderTrack(t: GraphTrack, y: number, h: number): React.ReactNode {
    if (t.type === 'bars') {
      const { s, mx } = valueScale(t.bins.map((b) => b.v), h, t.scale);
      const peak = t.bins.reduce((m, b) => (b.v > m.v ? b : m), { t: 0, v: 0 });
      return (
        <>
          {t.bins
            .filter((b) => b.v > 0 && inView(b.t))
            .map((b, i) => {
              const bx = x(new Date(b.t));
              const bw = Math.max(1, x(new Date(b.t + t.binMs)) - bx - 0.6);
              const by = y + s(b.v);
              const isPeak = b.t === peak.t;
              // crisp: glow ONLY on the single peak bar, not every hot one
              return <rect key={i} x={bx} y={by} width={bw} height={y + h - by} fill={magma(mx > 0 ? b.v / mx : 0)} style={isPeak ? { filter: 'drop-shadow(0 0 4px #fbe9a0aa)' } : undefined} />;
            })}
          {peak.v > 0 && inView(peak.t) && (
            <text x={x(new Date(peak.t))} y={y - 3} fontSize={8} fontWeight={600} textAnchor="middle" fill="#8a92a0" className="tabular-nums">
              {`peak ${fmtV(peak.v)}${t.unit ? ' ' + t.unit : ''}`}
            </text>
          )}
        </>
      );
    }
    if (t.type === 'series') {
      const { s } = valueScale(t.points.map((p) => p.v), h, t.scale);
      const pts = t.points;
      const peak = pts.reduce((m, p) => (p.v > m.v ? p : m), { t: 0, v: 0 });
      const ln = line<{ t: number; v: number }>().x((p) => x(new Date(p.t))).y((p) => y + s(p.v)).curve(curveMonotoneX);
      const ar = area<{ t: number; v: number }>().x((p) => x(new Date(p.t))).y0(y + h).y1((p) => y + s(p.v)).curve(curveMonotoneX);
      const money = t.unit === '$';
      return (
        <>
          <path d={ar(pts) ?? undefined} fill="#f2913d" fillOpacity={0.14} />
          <path d={ln(pts) ?? undefined} fill="none" stroke="#f2913d" strokeWidth={1.3} style={{ filter: 'drop-shadow(0 0 2px #f2913d55)' }} />
          {peak.v > 0 && inView(peak.t) && (
            <g pointerEvents="none">
              <circle cx={x(new Date(peak.t))} cy={y + s(peak.v)} r={2.5} fill="#fbe9a0" />
              <text x={x(new Date(peak.t))} y={y + s(peak.v) - 5} fontSize={8.5} fontWeight={700} textAnchor="middle" fill="#f2c46b" className="tabular-nums">
                {money ? `$${peak.v.toFixed(1)}/hr` : `${fmtV(peak.v)}${t.unit ? ' ' + t.unit : ''}`}
              </text>
            </g>
          )}
        </>
      );
    }
    if (t.type === 'events') {
      // Cluster nearby marks, then hang a labeled block from the top rail for each.
      // Blocks are placed by priority (bigger / land-feat clusters first) with true
      // rectangle collision-avoidance — anything that can't fit stays just a dot. The
      // Felton "One Week" annotation style, made robust to dense real data.
      const marks = t.marks.filter((m) => inView(m.t)).sort((a, b) => a.t - b.t);
      const railY = y + 7;
      const lineH = 11;
      const CHAR = 4.5;
      const top0 = railY + 12;
      const bottomLimit = y + h - 2;

      const clusters: { marks: EventMark[]; x: number }[] = [];
      for (const m of marks) {
        const last = clusters[clusters.length - 1];
        if (last && x(new Date(m.t)) - x(new Date(last.marks[last.marks.length - 1].t)) <= 11) last.marks.push(m);
        else clusters.push({ marks: [m], x: x(new Date(m.t)) });
      }

      const els: React.ReactNode[] = [];
      for (const m of marks) els.push(<circle key={`d${m.t}`} cx={x(new Date(m.t))} cy={railY} r={2.2} fill={kindColor(m.kind)} />);

      type L = { kind?: string; text: string; delta?: string; color: string };
      const blocks = clusters.map((cl) => {
        const lines: L[] = [];
        if (cl.marks.length > 1) lines.push({ text: `${cl.marks.length}× ${hhmm(new Date(cl.marks[0].t))}–${hhmm(new Date(cl.marks[cl.marks.length - 1].t))}`, color: '#6d7480' });
        for (const m of cl.marks.slice(0, 5)) lines.push({ kind: (m.kind ?? '').toUpperCase(), text: short(m.label.replace(/^[✓→←·]\s*/, ''), 24), delta: m.value ? `Δ${fmtV(m.value)}` : undefined, color: kindColor(m.kind) });
        if (cl.marks.length > 5) lines.push({ text: `+${cl.marks.length - 5}`, color: '#5a6270' });
        const w = 10 + Math.max(...lines.map((l) => ((l.kind ? l.kind.length + 1 : 0) + l.text.length + (l.delta ? l.delta.length + 1 : 0)) * CHAR));
        const important = cl.marks.some((m) => m.kind === 'land' || m.kind === 'feat');
        return { cl, lines, w, bh: lines.length * lineH, priority: cl.marks.length + (important ? 6 : 0) };
      });

      const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
      const hits = (a: { x0: number; x1: number; y0: number; y1: number }, b: { x0: number; x1: number; y0: number; y1: number }) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
      for (const blk of [...blocks].sort((a, b) => b.priority - a.priority)) {
        const xc = blk.cl.x;
        const rightAlign = xc + blk.w > view.plotX1 - 4; // near the right edge → grow leftward
        const rx0 = rightAlign ? xc - blk.w : xc - 1;
        const rx1 = rightAlign ? xc + 1 : xc + blk.w;
        let top: number | null = null;
        for (let cand = top0; cand + blk.bh <= bottomLimit; cand += lineH) {
          const rect = { x0: rx0, x1: rx1, y0: cand, y1: cand + blk.bh };
          if (!placed.some((p) => hits(rect, p))) { top = cand; placed.push(rect); break; }
        }
        if (top === null) continue; // no room → the dot already stands in for it
        els.push(<line key={`c${xc}`} x1={xc} y1={railY + 2} x2={xc} y2={top - 1} stroke={kindColor(blk.cl.marks[0].kind)} strokeOpacity={0.22} strokeWidth={0.6} />);
        blk.lines.forEach((l, li) => {
          const ly = top! + li * lineH + 8;
          els.push(
            <text key={`l${xc}-${li}`} x={rightAlign ? xc - 4 : xc + 4} y={ly} textAnchor={rightAlign ? 'end' : 'start'} fontSize={8} className="tabular-nums">
              {l.kind && <tspan fontWeight={700} fill={l.color}>{l.kind} </tspan>}
              <tspan fill={l.kind ? '#9aa1ad' : l.color} fontWeight={l.kind ? 400 : 600}>{l.text}</tspan>
              {l.delta && <tspan fill="#5a6270"> {l.delta}</tspan>}
            </text>,
          );
        });
      }

      // kind legend, top-right of the track
      const kinds = [...new Set(marks.map((m) => m.kind ?? 'other'))].slice(0, 6);
      let lx = view.plotX1;
      for (const k of [...kinds].reverse()) {
        const w = k.length * 4.6 + 14;
        lx -= w;
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
      const laneH = 8;
      const gap = 2;
      const maxLanes = Math.max(1, Math.floor(h / (laneH + gap)));
      const laneEnds: number[] = [];
      const sorted = [...t.spans].sort((a, b) => a.t0 - b.t0);
      const out: React.ReactNode[] = [];
      sorted.forEach((sp, i) => {
        if (sp.t1 < view.domain[0] || sp.t0 > view.domain[1]) return;
        let lane = laneEnds.findIndex((e) => e <= sp.t0);
        if (lane === -1) {
          lane = laneEnds.length;
          laneEnds.push(sp.t1);
        } else laneEnds[lane] = sp.t1;
        if (lane >= maxLanes) lane = maxLanes - 1;
        const sx = Math.max(view.plotX0, x(new Date(sp.t0)));
        const sw = Math.max(1, x(new Date(sp.t1)) - sx);
        out.push(<rect key={i} x={sx} y={y + lane * (laneH + gap)} width={sw} height={laneH} rx={1.5} fill={statusColor(sp.status)} fillOpacity={0.85} />);
      });
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

  // ── hover readout ─────────────────────────────────────────────────────────
  const tip = useMemo(() => {
    if (!hover) return null;
    const t = hover.t;
    const lines: { label: string; value: string; color?: string }[] = [];
    for (const tr of doc.tracks) {
      if (collapsed.has(tr.group)) continue;
      if (tr.type === 'bars') {
        const b = tr.bins.find((bb) => t >= bb.t && t < bb.t + tr.binMs);
        if (b && b.v > 0) lines.push({ label: tr.label, value: `${Math.round(b.v)}${tr.unit ? ' ' + tr.unit : ''}` });
      } else if (tr.type === 'series') {
        let best: { t: number; v: number } | null = null;
        for (const p of tr.points) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
        if (best && best.v > 0) lines.push({ label: tr.label, value: `${tr.unit === '$' ? '$' : ''}${best.v.toFixed(tr.unit === '$' ? 2 : 0)}` });
      } else if (tr.type === 'spans') {
        const n = tr.spans.filter((sp) => t >= sp.t0 && t <= sp.t1).length;
        if (n) lines.push({ label: tr.label, value: `${n} active` });
      } else if (tr.type === 'bands') {
        const sg = tr.segments.find((s) => t >= s.t0 && t < s.t1);
        if (sg) lines.push({ label: tr.label, value: sg.category, color: sg.color ?? cat(sg.category) });
      } else {
        // events: nearest within ~5px
        let best: { d: number; label: string; color: string } | null = null;
        for (const m of tr.marks) {
          const d = Math.abs(x(new Date(m.t)) - hover.x);
          if (d < 6 && (!best || d < best.d)) best = { d, label: m.label, color: kindColor(m.kind) };
        }
        if (best) lines.push({ label: tr.label, value: short(best.label, 30), color: best.color });
      }
    }
    return { when: new Date(t), lines };
  }, [hover, doc.tracks, collapsed, x]);

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    if (px < view.plotX0 || px > view.plotX1) {
      setHover(null);
      return;
    }
    setHover({ x: px, t: view.timeAt(px) });
  };

  return (
    <div
      ref={view.containerRef}
      className="relative w-full select-none overflow-hidden rounded-xl border border-[#1e2430] bg-[#05060a]"
      onWheel={view.onWheel}
      onPointerDown={view.onPanStart}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      style={{ cursor: 'crosshair' }}
    >
      <svg width={view.width} height={totalH} className="block">
        {/* day separators (full height) */}
        {dayTicks.map((d, i) => (
          <line key={`d${i}`} x1={x(new Date(d.t))} y1={HEADER_H - 26} x2={x(new Date(d.t))} y2={axisY} stroke="#131820" strokeWidth={1} />
        ))}
        {hourTicks.map((t, i) => (
          <line key={`h${i}`} x1={x(new Date(t))} y1={HEADER_H} x2={x(new Date(t))} y2={axisY} stroke="#0d1119" strokeWidth={1} />
        ))}

        {/* big day-column headers (top band) */}
        {dayTicks.map((d, i) => (
          <g key={`hd${i}`} pointerEvents="none">
            <text x={x(new Date(d.t)) + 7} y={HEADER_H - 18} fontSize={12.5} fontWeight={700} letterSpacing="0.08em" fill="#c4c9d2">
              {d.weekdayLong.toUpperCase()}
            </text>
            <text x={x(new Date(d.t)) + 7} y={HEADER_H - 6} fontSize={9} letterSpacing="0.04em" fill="#6d7480" className="tabular-nums">
              {d.date}
            </text>
          </g>
        ))}

        {/* rows */}
        {rows.map((r, i) => {
          if (r.kind === 'group') {
            const isCol = collapsed.has(r.groupId);
            return (
              <g key={`g${i}`} style={{ cursor: 'pointer' }} onClick={() => setCollapsed((s) => { const n = new Set(s); n.has(r.groupId) ? n.delete(r.groupId) : n.add(r.groupId); return n; })}>
                <text x={10} y={r.y + 16} fontSize={10} fontWeight={700} letterSpacing="0.12em" fill="#c4c9d2">
                  {isCol ? '▸ ' : '▾ '}
                  {r.label}
                </text>
              </g>
            );
          }
          return (
            <g key={`t${i}`}>
              <text x={LABEL_W - 8} y={r.y + 12} textAnchor="end" fontSize={9} fontWeight={600} letterSpacing="0.06em" fill="#7a8390">
                {r.label}
              </text>
              {r.track && renderTrack(r.track, r.y, r.h)}
            </g>
          );
        })}

        {/* time axis — per-day hours ruler (00·06·12·18) */}
        <line x1={view.plotX0} y1={axisY} x2={view.plotX1} y2={axisY} stroke="#1e2430" />
        {spanDays <= 10 &&
          dayTicks.flatMap((d, i) =>
            [0, 6, 12, 18].map((hr) => {
              const tt = d.t + hr * 3_600_000;
              if (tt < view.domain[0] || tt > view.domain[1]) return null;
              return (
                <text key={`hr${i}-${hr}`} x={x(new Date(tt))} y={axisY + 11} fontSize={7} textAnchor="middle" fill="#4a515e" className="tabular-nums">
                  {String(hr).padStart(2, '0')}
                </text>
              );
            }),
          )}

        {/* now marker + faint future shading (visible only when the window reaches past now) */}
        {doc.generatedAt > view.domain[0] && doc.generatedAt < view.domain[1] && (
          <g pointerEvents="none">
            <rect x={x(new Date(doc.generatedAt))} y={0} width={Math.max(0, view.plotX1 - x(new Date(doc.generatedAt)))} height={axisY} fill="#0a1420" fillOpacity={0.35} />
            <line x1={x(new Date(doc.generatedAt))} y1={0} x2={x(new Date(doc.generatedAt))} y2={axisY} stroke="#2fb6d6" strokeWidth={1} strokeDasharray="3 3" />
            <text x={x(new Date(doc.generatedAt)) + 3} y={10} fontSize={8} fontWeight={600} fill="#2fb6d6">
              now
            </text>
          </g>
        )}

        {/* hover cursor */}
        {hover && <line x1={hover.x} y1={0} x2={hover.x} y2={axisY} stroke="#f2913d" strokeOpacity={0.5} strokeWidth={1} pointerEvents="none" />}
      </svg>

      {/* tooltip */}
      {hover && tip && tip.lines.length > 0 && (
        <div
          className="pointer-events-none absolute z-10 max-w-[240px] rounded-md border border-[#232b38] bg-[#0b0e14]/95 px-2.5 py-1.5 text-[10px] shadow-xl"
          style={{ left: Math.min(hover.x + 12, view.width - 220), top: 8 }}
        >
          <div className="mb-1 font-semibold tabular-nums text-[#c4c9d2]">
            {tip.when.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' })} · {tip.when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </div>
          {tip.lines.map((l, i) => (
            <div key={i} className="flex items-center justify-between gap-3 leading-relaxed">
              <span className="flex items-center gap-1.5 text-[#7a8390]">
                {l.color && <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: l.color }} />}
                {l.label}
              </span>
              <span className="tabular-nums text-[#c4c9d2]">{l.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
