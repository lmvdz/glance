/**
 * useGraphView — the interactive time-viewport for the omp-graph canvas.
 *
 * Owns the visible time domain (pan/zoom) and the measured plot width, decoupled
 * from rendering. Wheel zooms around the cursor; drag pans; both clamp to the
 * data range so you can't lose the data off-screen. Reset returns to full range.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TimeRange } from './types';

const MIN_SPAN_MS = 60 * 60 * 1000; // never zoom in past a 1-hour window

export interface GraphView {
  /** the currently visible [start, end] time domain. */
  domain: [number, number];
  /** measured inner plot width in px (excludes the left label gutter). */
  width: number;
  containerRef: (el: HTMLDivElement | null) => void;
  /** px→time and time→px against the current domain + plot geometry. */
  timeAt: (px: number) => number;
  xOf: (t: number) => number;
  onWheel: (e: React.WheelEvent) => void;
  onPanStart: (e: React.PointerEvent) => void;
  reset: () => void;
  zoomed: boolean;
  plotX0: number;
  plotX1: number;
}

export function useGraphView(range: TimeRange, labelW: number, padR: number): GraphView {
  const full: [number, number] = useMemo(() => [range.start, range.end], [range.start, range.end]);
  const [domain, setDomain] = useState<[number, number]>(full);
  const [box, setBox] = useState({ width: 900, left: 0 });
  const elRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ px: number; domain: [number, number] } | null>(null);

  // reset the view whenever the underlying data range changes (e.g. range preset).
  useEffect(() => setDomain(full), [full]);

  const containerRef = useCallback((el: HTMLDivElement | null) => {
    elRef.current = el;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBox({ width: r.width, left: r.left });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotX0 = labelW;
  const plotX1 = Math.max(plotX0 + 10, box.width - padR);
  const plotW = plotX1 - plotX0;

  const xOf = useCallback(
    (t: number) => plotX0 + ((t - domain[0]) / (domain[1] - domain[0])) * plotW,
    [domain, plotX0, plotW],
  );
  const timeAt = useCallback(
    (px: number) => domain[0] + ((px - plotX0) / plotW) * (domain[1] - domain[0]),
    [domain, plotX0, plotW],
  );

  const clamp = useCallback(
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

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      const px = e.clientX - box.left;
      if (px < plotX0) return;
      const t = timeAt(px);
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15; // out / in
      const a = t - (t - domain[0]) * factor;
      const b = t + (domain[1] - t) * factor;
      setDomain(clamp([a, b]));
    },
    [box.left, plotX0, timeAt, domain, clamp],
  );

  const onPanStart = useCallback(
    (e: React.PointerEvent) => {
      const px = e.clientX - box.left;
      if (px < plotX0) return;
      drag.current = { px, domain };
      const target = e.currentTarget as Element;
      target.setPointerCapture?.(e.pointerId);
      const move = (ev: PointerEvent) => {
        if (!drag.current) return;
        const dpx = ev.clientX - box.left - drag.current.px;
        const dt = -(dpx / plotW) * (drag.current.domain[1] - drag.current.domain[0]);
        setDomain(clamp([drag.current.domain[0] + dt, drag.current.domain[1] + dt]));
      };
      const up = () => {
        drag.current = null;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [box.left, plotX0, plotW, domain, clamp],
  );

  const reset = useCallback(() => setDomain(full), [full]);
  const zoomed = domain[0] !== full[0] || domain[1] !== full[1];

  return { domain, width: box.width, containerRef, timeAt, xOf, onWheel, onPanStart, reset, zoomed, plotX0, plotX1 };
}
