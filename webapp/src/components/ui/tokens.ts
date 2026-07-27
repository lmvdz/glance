/**
 * Shared design tokens for the dashboard UI primitives.
 *
 * Color = meaning, applied consistently across every panel:
 *   emerald = good · amber = warn · red = critical · blue = neutral info.
 * One place to read it from keeps the four panels in lockstep.
 */

export type Tone = 'success' | 'warn' | 'critical' | 'info' | 'neutral';

/** Verdict-style tones used by badges/rows. `ok` and `healthy` both map to good. */
export type ToneLike = Tone | 'healthy' | 'ok';

function normalize(tone: ToneLike): Tone {
  if (tone === 'healthy' || tone === 'ok') return 'success';
  return tone;
}

interface ToneClasses {
  /** solid dot / accent bg */
  dot: string;
  /** text color */
  text: string;
  /** soft pill background */
  pillBg: string;
  /** pill text */
  pillText: string;
  /** soft callout/card border */
  border: string;
  /** soft callout/card background */
  softBg: string;
  /** stroke/fill for svg (currentColor-friendly) */
  stroke: string;
}

const MAP: Record<Tone, ToneClasses> = {
  success: {
    dot: 'bg-emerald-500',
    text: 'text-emerald-600 dark:text-emerald-400',
    pillBg: 'bg-emerald-100 dark:bg-emerald-900/40',
    pillText: 'text-emerald-700 dark:text-emerald-300',
    border: 'border-emerald-200 dark:border-emerald-900/60',
    softBg: 'bg-emerald-50 dark:bg-emerald-950/30',
    stroke: 'text-emerald-500',
  },
  warn: {
    dot: 'bg-amber-400',
    text: 'text-amber-600 dark:text-amber-400',
    pillBg: 'bg-amber-100 dark:bg-amber-900/40',
    pillText: 'text-amber-700 dark:text-amber-300',
    border: 'border-amber-200 dark:border-amber-900/60',
    softBg: 'bg-amber-50 dark:bg-amber-950/20',
    stroke: 'text-amber-500',
  },
  critical: {
    dot: 'bg-red-500',
    text: 'text-red-600 dark:text-red-400',
    pillBg: 'bg-red-100 dark:bg-red-900/40',
    pillText: 'text-red-700 dark:text-red-300',
    border: 'border-red-200 dark:border-red-900/60',
    softBg: 'bg-red-50 dark:bg-red-950/30',
    stroke: 'text-red-500',
  },
  info: {
    dot: 'bg-sky-400',
    text: 'text-sky-700 dark:text-sky-300',
    pillBg: 'bg-sky-100 dark:bg-sky-950/40',
    pillText: 'text-sky-800 dark:text-sky-200',
    border: 'border-sky-200 dark:border-sky-900/60',
    softBg: 'bg-sky-50 dark:bg-sky-950/30',
    stroke: 'text-sky-500',
  },
  neutral: {
    dot: 'bg-ink-border-2',
    text: 'text-ink-text-label',
    pillBg: 'bg-ink-surface',
    pillText: 'text-ink-text-label',
    border: 'border-ink-border',
    softBg: 'bg-ink',
    stroke: 'text-ink-text-muted',
  },
};

export function toneClasses(tone: ToneLike): ToneClasses {
  return MAP[normalize(tone)];
}
