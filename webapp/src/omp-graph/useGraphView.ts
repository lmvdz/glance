/**
 * useGraphView — the interactive camera for the omp-graph canvas.
 *
 * The graph lives in a FIXED-HEIGHT viewport (taller content scrolls inside it),
 * so the page never needs to scroll to see the whole graph — which also kills the
 * wheel-zoom-vs-page-scroll conflict. Drag pans BOTH axes (time on x, tracks on
 * y); wheel zooms time around the cursor. Everything clamps to the data / content.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TimeRange } from './types';

const MIN_SPAN_MS = 60 * 60 * 1000; // never zoom in past a 1-hour window

export interface GraphView {
  domain: [number, number];
  width: number;
  /** vertical scroll offset into the (taller) content, in px. */
  offsetY: number;
  maxOffsetY: number;
  containerRef: (el: HTMLDivElement | null) => void;
  timeAt: (px: number) => number;
  onWheel: (e: React.WheelEvent) => void;
  onPanStart: (e: React.PointerEvent) => void;
  reset: () => void;
  zoomed: boolean;
  plotX0: number;
  plotX1: number;
}

export function useGraphView(range: TimeRange, labelW: number, padR: number, contentH: number, viewportH: number): GraphView {
  const full: [number, number] = useMemo(() => [range.start, range.end], [range.start, range.end]);
  const [domain, setDomain] = useState<[number, number]>(full);
  const [offsetY, setOffsetY] = useState(0);
  const [box, setBox] = useState({ width: 900, left: 0, top: 0 });
  const elRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ px: number; py: number; domain: [number, number]; offsetY: number } | null>(null);

  const maxOffsetY = Math.max(0, contentH - viewportH);

  useEffect(() => setDomain(full), [full]);
  useEffect(() => setOffsetY((o) => Math.min(o, maxOffsetY)), [maxOffsetY]);

  const containerRef = useCallback((el: HTMLDivElement | null) => {
    elRef.current = el;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBox({ width: r.width, left: r.left, top: r.top });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotX0 = labelW;
  const plotX1 = Math.max(plotX0 + 10, box.width - padR);
  const plotW = plotX1 - plotX0;

  const timeAt = useCallback((px: number) => domain[0] + ((px - plotX0) / plotW) * (domain[1] - domain[0]), [domain, plotX0, plotW]);

  const clampX = useCallback(
    (d: [number, number]): [number, number] => {
      let [a, b] = d;
      const span = Math.min(full[1] - full[0], Math.max(MIN_SPAN_MS, b - a));
      if (a < full[0]) { a = full[0]; b = a + span; }
      if (b > full[1]) { b = full[1]; a = b - span; }
      if (a < full[0]) a = full[0];
      return [a, b];
    },
    [full],
  );
  const clampY = useCallback((v: number) => Math.max(0, Math.min(maxOffsetY, v)), [maxOffsetY]);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      const px = e.clientX - box.left;
      if (px < plotX0) return;
      const t = timeAt(px);
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      setDomain(clampX([t - (t - domain[0]) * factor, t + (domain[1] - t) * factor]));
    },
    [box.left, plotX0, timeAt, domain, clampX],
  );

  const onPanStart = useCallback(
    (e: React.PointerEvent) => {
      drag.current = { px: e.clientX, py: e.clientY, domain, offsetY };
      const target = e.currentTarget as Element;
      target.setPointerCapture?.(e.pointerId);
      const move = (ev: PointerEvent) => {
        const d = drag.current;
        if (!d) return;
        const dx = ev.clientX - d.px;
        const dt = -(dx / plotW) * (d.domain[1] - d.domain[0]);
        setDomain(clampX([d.domain[0] + dt, d.domain[1] + dt]));
        setOffsetY(clampY(d.offsetY - (ev.clientY - d.py)));
      };
      const up = () => {
        drag.current = null;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [domain, offsetY, plotW, clampX, clampY],
  );

  const reset = useCallback(() => { setDomain(full); setOffsetY(0); }, [full]);
  const zoomed = domain[0] !== full[0] || domain[1] !== full[1];

  return { domain, width: box.width, offsetY, maxOffsetY, containerRef, timeAt, onWheel, onPanStart, reset, zoomed, plotX0, plotX1 };
}
