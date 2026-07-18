import React from 'react';
import { ringPct, ringDashOffset, ringCircumference } from '../../lib/progressRing';

/**
 * ProgressRing — a small inline-SVG donut, no external deps. The plan-reality header's two
 * at-a-glance verdicts (concerns done/total, proof coverage doneProven/done) both use this; a
 * plans-index card uses it a third time at a smaller size. `tone` picks the fill color from the
 * shared `--wf-*` tokens (brand.md: ember is the one warm accent, so 'brand' is reserved for the
 * PRIMARY ring — the proof-coverage ring uses green/amber, never a second ember).
 */
export interface ProgressRingProps {
  value: number;
  total: number;
  label: string;
  tone?: 'brand' | 'green' | 'amber';
  size?: number;
  strokeWidth?: number;
  /** Center readout override — defaults to "value/total". Pass e.g. "n/a" for a total of 0. */
  centerText?: string;
}

const TONE_VAR: Record<NonNullable<ProgressRingProps['tone']>, string> = {
  brand: 'var(--wf-accent)',
  green: 'var(--wf-success)',
  amber: 'var(--wf-warning)',
};

export const ProgressRing: React.FC<ProgressRingProps> = ({ value, total, label, tone = 'brand', size = 72, strokeWidth = 7, centerText }) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = ringCircumference(radius);
  const pct = ringPct(value, total);
  const dashOffset = ringDashOffset(pct, circumference);
  const center = size / 2;
  const display = centerText ?? (total > 0 ? `${value}/${total}` : 'n/a');
  const fontSize = size >= 64 ? 13 : 11;

  return (
    <div className="flex flex-col items-center gap-1" role="img" aria-label={`${label}: ${display}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <circle cx={center} cy={center} r={radius} fill="none" strokeWidth={strokeWidth} className="stroke-gray-200 dark:stroke-gray-800" />
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          stroke={TONE_VAR[tone]}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          className="transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none"
        />
        <text
          x={center}
          y={center}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={fontSize}
          fontWeight={600}
          className="rotate-90 fill-gray-900 font-mono tabular-nums dark:fill-gray-100"
          style={{ transformOrigin: `${center}px ${center}px` }}
        >
          {display}
        </text>
      </svg>
      <span className="text-center text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</span>
    </div>
  );
};
