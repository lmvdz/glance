/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The glance mark, as a themeable parametric SVG: a radiant eye (aperture) with an ember-star pupil and a
// sunburst of rays. The eye + rays use `currentColor` (white on dark, dark on light — set via the parent's
// text color), the star is the fixed ember accent. Crisp at any size, from 16px favicon to hero.

const A = 24, B = 8.5, CX = 50, CY = 50, N = 24;
const eyeRadius = (th: number) => (A * B) / Math.hypot(B * Math.cos(th), A * Math.sin(th));

interface Ray {
  x1: number; y1: number; x2: number; y2: number; w: number;
}
const RAYS: Ray[] = [];
const DOTS: { cx: number; cy: number; r: number }[] = [];
for (let i = 0; i < N; i++) {
  const th = ((-90 + i * (360 / N)) * Math.PI) / 180;
  const topBottom = i === 0 || i === 12;
  const leftRight = i === 6 || i === 18;
  const [len, w] = leftRight ? [30, 1.1] : topBottom ? [24, 1.7] : i % 2 === 0 ? [15, 1.25] : [10, 1.0];
  const rin = eyeRadius(th) + 2.5;
  const rout = rin + len;
  RAYS.push({ x1: CX + rin * Math.cos(th), y1: CY + rin * Math.sin(th), x2: CX + rout * Math.cos(th), y2: CY + rout * Math.sin(th), w });
  if (leftRight) DOTS.push({ cx: CX + (rout + 3) * Math.cos(th), cy: CY + (rout + 3) * Math.sin(th), r: 1.3 });
  if (topBottom) for (const [k, r] of [[3, 1.4], [6, 0.9]] as const) DOTS.push({ cx: CX + (rout + k) * Math.cos(th), cy: CY + (rout + k) * Math.sin(th), r });
}

export const GlanceLogo = ({ size = 32, className, ember = '#f0a35a' }: { size?: number; className?: string; ember?: string }) => (
  <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden className={className}>
    {RAYS.map((r, i) => (
      <line key={i} x1={r.x1} y1={r.y1} x2={r.x2} y2={r.y2} stroke="currentColor" strokeWidth={r.w} strokeLinecap="round" />
    ))}
    {DOTS.map((d, i) => (
      <circle key={i} cx={d.cx} cy={d.cy} r={d.r} fill="currentColor" />
    ))}
    <path d="M26 50 C 34 41.5 66 41.5 74 50 C 66 58.5 34 58.5 26 50 Z" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinejoin="round" />
    <path d="M50 39.5 C 50.8 47 52.8 49.2 60.5 50 C 52.8 50.8 50.8 53 50 60.5 C 49.2 53 47.2 50.8 39.5 50 C 47.2 49.2 49.2 47 50 39.5 Z" fill={ember} />
  </svg>
);
