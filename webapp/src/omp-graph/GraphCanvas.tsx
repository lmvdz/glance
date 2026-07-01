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
import { kindColor, statusColor, type GraphDoc, type GraphTrack, type Scale } from './types';

const LABEL_W = 118;
const PAD_R = 18;
const AXIS_H = 30;
const GROUP_H = 24;
const TRACK_H: Record<GraphTrack['type'], number> = { events: 70, series: 74, bars: 74, spans: 130, bands: 24 };
const TRACK_GAP = 10;

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
    let y = 6;
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
    const ticks: { t: number; weekday: string; date: string }[] = [];
    const d = new Date(view.domain[0]);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1); // first midnight strictly inside is fine; also include the starting day label
    const start = new Date(view.domain[0]);
    start.setHours(0, 0, 0, 0);
    for (let cur = start.getTime(); cur <= view.domain[1]; cur += 86_400_000) {
      const dd = new Date(cur);
      ticks.push({
        t: cur,
        weekday: dd.toLocaleDateString(undefined, { weekday: 'short' }),
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
      return t.bins
        .filter((b) => b.v > 0 && inView(b.t))
        .map((b, i) => {
          const bx = x(new Date(b.t));
          const bw = Math.max(1, x(new Date(b.t + t.binMs)) - bx - 0.5);
          const by = y + s(b.v);
          const col = magma(mx > 0 ? b.v / mx : 0);
          const hot = b.v / mx > 0.66;
          return <rect key={i} x={bx} y={by} width={bw} height={y + h - by} fill={col} style={hot ? { filter: 'drop-shadow(0 0 3px ' + col + ')' } : undefined} />;
        });
    }
    if (t.type === 'series') {
      const { s } = valueScale(t.points.map((p) => p.v), h, t.scale);
      const pts = t.points;
      const ln = line<{ t: number; v: number }>().x((p) => x(new Date(p.t))).y((p) => y + s(p.v)).curve(curveMonotoneX);
      const ar = area<{ t: number; v: number }>().x((p) => x(new Date(p.t))).y0(y + h).y1((p) => y + s(p.v)).curve(curveMonotoneX);
      return (
        <>
          <path d={ar(pts) ?? undefined} fill="#f2913d" fillOpacity={0.12} />
          <path d={ln(pts) ?? undefined} fill="none" stroke="#f2913d" strokeWidth={1.4} style={{ filter: 'drop-shadow(0 0 3px #f2913d88)' }} />
        </>
      );
    }
    if (t.type === 'events') {
      const marks = t.marks.filter((m) => inView(m.t));
      const showLabels = marks.length <= 22;
      const base = y + h - 12;
      const offs = [0, 14, 28, 42];
      return marks.map((m, i) => {
        const mx = x(new Date(m.t));
        const col = kindColor(m.kind);
        const ly = y + 4 + offs[i % offs.length];
        return (
          <g key={i}>
            {showLabels && <line x1={mx} y1={ly + 8} x2={mx} y2={base} stroke={col} strokeOpacity={0.35} strokeWidth={0.75} />}
            <circle cx={mx} cy={base} r={3.2} fill={col} style={{ filter: `drop-shadow(0 0 3px ${col}aa)` }} />
            {showLabels && (
              <text x={mx + 4} y={ly + 8} fontSize={8.5} fill="#9aa1ad" className="tabular-nums">
                {short(m.label, 34)}
              </text>
            )}
          </g>
        );
      });
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
        {/* day separators + top labels */}
        {dayTicks.map((d, i) => (
          <g key={`d${i}`}>
            <line x1={x(new Date(d.t))} y1={0} x2={x(new Date(d.t))} y2={axisY} stroke="#141922" strokeWidth={1} />
          </g>
        ))}
        {hourTicks.map((t, i) => (
          <line key={`h${i}`} x1={x(new Date(t))} y1={0} x2={x(new Date(t))} y2={axisY} stroke="#0e131b" strokeWidth={1} />
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

        {/* time axis */}
        <line x1={view.plotX0} y1={axisY} x2={view.plotX1} y2={axisY} stroke="#1e2430" />
        {dayTicks.map((d, i) => (
          <g key={`dl${i}`}>
            <text x={x(new Date(d.t)) + 4} y={axisY + 12} fontSize={9} fontWeight={600} fill="#9aa1ad">
              {d.weekday}
            </text>
            <text x={x(new Date(d.t)) + 4} y={axisY + 23} fontSize={8} fill="#5a6270" className="tabular-nums">
              {d.date}
            </text>
          </g>
        ))}
        {spanDays <= 3 &&
          hourTicks.filter((_, i) => i % 3 === 0).map((t, i) => (
            <text key={`ht${i}`} x={x(new Date(t))} y={axisY + 12} fontSize={7} textAnchor="middle" fill="#4a515e" className="tabular-nums">
              {new Date(t).getHours().toString().padStart(2, '0')}
            </text>
          ))}

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
