/**
 * Sparkline — a tiny inline SVG line+area trend. Zero deps, scales to its box,
 * degrades to a flat baseline for empty/constant series.
 */

import React, { useId } from 'react';
import { toneClasses, type ToneLike } from './tokens';

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  tone?: ToneLike;
  /** accessible description; defaults to a generic trend label. */
  label?: string;
}

export const Sparkline: React.FC<SparklineProps> = ({ values, width = 64, height = 18, tone = 'info', label }) => {
  const gradId = useId();
  const t = toneClasses(tone);
  const pts = values.filter((v) => Number.isFinite(v));

  if (pts.length === 0) {
    return (
      <svg width={width} height={height} role="img" aria-label={label ?? 'no data'} className="text-gray-300 dark:text-gray-700">
        <line x1={0} y1={height - 1} x2={width} y2={height - 1} stroke="currentColor" strokeWidth={1} strokeDasharray="2 2" />
      </svg>
    );
  }

  const max = Math.max(...pts);
  const min = Math.min(...pts);
  const span = max - min || 1;
  const stepX = pts.length > 1 ? width / (pts.length - 1) : width;
  const pad = 1.5;
  const usableH = height - pad * 2;

  const coords = pts.map((v, i) => {
    const x = pts.length > 1 ? i * stepX : width / 2;
    const y = pad + usableH - ((v - min) / span) * usableH;
    return [Number(x.toFixed(2)), Number(y.toFixed(2))] as const;
  });

  const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ');
  const area = `${line} L${coords[coords.length - 1][0]},${height} L${coords[0][0]},${height} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label ?? `trend, latest ${pts[pts.length - 1]}`}
      className={t.stroke}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity={0.22} />
          <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} stroke="none" />
      <path d={line} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
};
