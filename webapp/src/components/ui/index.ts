/**
 * Dashboard UI primitives — the shared, dark-theme design layer every panel
 * builds on. Import from here, never from the individual files, so the contract
 * stays stable for later panels.
 *
 *   VerdictBadge  — colored verdict pill with a status dot
 *   Sparkline     — tiny inline SVG trend
 *   StatTile      — a metric tile (label + value + sub + optional sparkline)
 *   SectionCard   — bordered card with an uppercase-tracked header
 *
 * Color = meaning: emerald=good · amber=warn · red=critical · blue=neutral info.
 */

export { VerdictBadge, type VerdictBadgeProps } from './VerdictBadge';
export { Sparkline, type SparklineProps } from './Sparkline';
export { StatTile, type StatTileProps } from './StatTile';
export { SectionCard, type SectionCardProps } from './SectionCard';
export { toneClasses, type Tone, type ToneLike } from './tokens';
export { relativeAge } from './time';
