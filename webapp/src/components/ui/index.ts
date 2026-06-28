/**
 * Dashboard UI primitives — the shared, dark-theme design layer every panel
 * builds on. Import from here, never from the individual files, so the contract
 * stays stable for later panels.
 *
 *   PanelShell    — the <main> + header + scroll body wrapper (use on every panel)
 *   VerdictBadge  — colored verdict pill with a status dot
 *   Sparkline     — tiny inline SVG trend
 *   StatTile      — a metric tile (label + value + sub + optional sparkline)
 *   Callout       — insight/anomaly banner with an optional action
 *   SectionCard   — bordered card with an uppercase-tracked header
 *   HeatGrid      — GitHub-style per-day heat matrix
 *   AttentionRow  — severity dot + title + detail + age + action button
 *
 * Color = meaning: emerald=good · amber=warn · red=critical · blue=neutral info.
 */

export { PanelShell, type PanelShellProps } from './PanelShell';
export { VerdictBadge, type VerdictBadgeProps } from './VerdictBadge';
export { Sparkline, type SparklineProps } from './Sparkline';
export { StatTile, type StatTileProps } from './StatTile';
export { Callout, type CalloutProps } from './Callout';
export { SectionCard, type SectionCardProps } from './SectionCard';
export { HeatGrid, type HeatGridProps, type HeatGridRow } from './HeatGrid';
export { AttentionRow, type AttentionRowProps } from './AttentionRow';
export { toneClasses, type Tone, type ToneLike } from './tokens';
export { relativeAge } from './time';
