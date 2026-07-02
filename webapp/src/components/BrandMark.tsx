/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The glance mark — an ember 4-point spark (a caught glint of light / a glance) at the center of a thin
// aperture ring (the eye / lens). Distilled from the brand key art into a clean, scalable, favicon-legible
// vector. Uses the ember accent (#f0a35a) with a white-hot core.
export const BrandMark = ({ size = 30, className }: { size?: number; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden className={className}>
    <circle cx="16" cy="16" r="13.6" stroke="#33333a" strokeWidth="1.2" />
    <path
      d="M16 2.5c1.1 9.4 4.1 12.4 13.5 13.5C20.1 17.1 17.1 20.1 16 29.5 14.9 20.1 11.9 17.1 2.5 16 11.9 14.9 14.9 11.9 16 2.5Z"
      fill="#f0a35a"
    />
    <circle cx="16" cy="16" r="1.7" fill="#fff6ea" />
  </svg>
);
