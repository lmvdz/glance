/**
 * progressRing.ts — pure geometry for `<ProgressRing>` (kit/ProgressRing.tsx), an inline-SVG
 * donut used for the plan-reality header's two at-a-glance rings (done/total,
 * doneProven/done). No DOM: the component wraps these, this is unit-tested directly.
 */

/** value/total clamped to [0,1]. A zero or negative total (nothing to divide) reads as 0, not
 *  NaN/Infinity — an empty ring, not a broken one. */
export function ringPct(value: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(1, value / total));
}

/** `stroke-dashoffset` for a ring of the given circumference at `pct` filled — 0 = fully drawn,
 *  `circumference` = empty. Pairs with `stroke-dasharray={circumference}`. */
export function ringDashOffset(pct: number, circumference: number): number {
  return circumference * (1 - pct);
}

/** Circle circumference for a given radius — trivial, but named so the component never repeats
 *  the `2 * Math.PI * r` formula inline. */
export function ringCircumference(radius: number): number {
  return 2 * Math.PI * radius;
}
